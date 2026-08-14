import { createHash } from "node:crypto";
import { serverRuntimeDefinition } from "@serversentinel/contracts";
import type { ModCompatibility, ModrinthProject, ModrinthVersion, ReleaseChannel, ServerRuntimeType } from "../types.js";
import { allowedForChannel, minecraftVersionsInclude, modrinthJarFile, modrinthServerSideSupported, versionChannel, type ModrinthJarFile } from "./compatibility.js";

/**
 * Install gates shared by the panel's Modrinth installer and the node agent's
 * mods.install command, so both reject the same versions for the same reasons.
 */

type ManagedContentNaming = {
  displayName: string;
  singular: "mod" | "plugin";
  /** The same word at the start of a sentence, which operation titles and error messages need. */
  Singular: "Mod" | "Plugin";
  plural: string;
  directory: string;
  loaders: readonly string[];
};

export function managedContentNaming(runtimeType: ServerRuntimeType): ManagedContentNaming {
  const definition = serverRuntimeDefinition(runtimeType);
  const singular = definition.contentKind === "plugins" ? "plugin" : "mod";
  return {
    displayName: definition.displayName,
    singular,
    Singular: capitalized(singular),
    plural: definition.contentKind,
    directory: definition.contentDirectory,
    loaders: definition.compatibleModrinthLoaders
  };
}

function capitalized(singular: "mod" | "plugin") {
  return singular === "plugin" ? "Plugin" : "Mod";
}

export function compatibilityFromSelectedVersion(input: {
  version: ModrinthVersion;
  file: ModrinthJarFile;
  projectSides: { server_side?: string; client_side?: string };
  compatible: boolean;
  reason: string;
}): ModCompatibility {
  return {
    status: input.compatible ? "compatible" : "incompatible",
    compatible: input.compatible,
    reason: input.reason,
    matchedVersionId: input.version.id,
    matchedVersionNumber: input.version.version_number,
    matchedVersionType: versionChannel(input.version.version_type),
    matchedLoaders: input.version.loaders,
    matchedGameVersions: input.version.game_versions,
    file: input.file,
    serverSide: input.projectSides.server_side,
    clientSide: input.projectSides.client_side
  };
}

type InstallCandidate = {
  file: ModrinthJarFile;
  hasCompatibleLoader: boolean;
  matchesMinecraft: boolean;
  serverSupported: boolean;
  compatible: boolean;
  incompatibilityReason?: string;
};

/**
 * Applies every gate that decides whether a selected Modrinth version may be
 * installed, throwing the first violation. `requireKnownServerSide` gates the
 * two "confirm the risk" prompts; the node agent does not surface them, so it
 * passes false.
 */
export function assertVersionInstallable(input: {
  version: ModrinthVersion;
  project: Pick<ModrinthProject, "server_side" | "client_side">;
  naming: ManagedContentNaming;
  minecraftVersion: string;
  channel: ReleaseChannel;
  forceIncompatible: boolean;
  overrideMinecraftVersion: boolean;
  requireKnownServerSide: boolean;
}): InstallCandidate {
  const { version, project, naming, minecraftVersion } = input;
  if (!allowedForChannel(version, input.channel)) {
    throw new Error("The selected version is outside the requested release channel");
  }
  const file = modrinthJarFile(version);
  if (!file?.url || !file.filename) {
    throw new Error("No installable .jar file was found for that version");
  }
  const hasCompatibleLoader = version.loaders.some((loader) => naming.loaders.includes(loader));
  if (!hasCompatibleLoader) {
    throw new Error(`The selected version is not compatible with ${naming.displayName}`);
  }
  const serverSide = project.server_side;
  if (serverSide === "unsupported") {
    throw new Error(`Client-only ${naming.plural} cannot be installed on the server`);
  }
  const serverSupported = modrinthServerSideSupported(serverSide);
  if (input.requireKnownServerSide && !input.forceIncompatible) {
    if (serverSide === "unknown") {
      throw new Error("Server-side support is unknown. Confirm the risk before installing.");
    }
    if (!serverSupported) {
      throw new Error("Server-side support could not be verified. Confirm the risk before installing.");
    }
  }
  const matchesMinecraft = minecraftVersionsInclude(version.game_versions, minecraftVersion);
  if (!matchesMinecraft && !input.overrideMinecraftVersion) {
    throw new Error(`This version is not marked for Minecraft ${minecraftVersion}. Confirm the Minecraft version override before installing.`);
  }
  const compatible = hasCompatibleLoader && matchesMinecraft && serverSupported;
  return {
    file,
    hasCompatibleLoader,
    matchesMinecraft,
    serverSupported,
    compatible,
    incompatibilityReason: compatible
      ? undefined
      : !matchesMinecraft
        ? `Installed with Minecraft version override. Server ${minecraftVersion}; ${naming.singular} ${version.game_versions.join(", ") || "unknown"}.`
        : serverSide === "unknown"
          ? "Server-side support could not be verified"
          : "Installed with compatibility override"
  };
}

/** Guards the transport before any bytes are fetched. */
export function assertDownloadableModrinthFile(
  file: Pick<ModrinthJarFile, "url" | "size">,
  options: { singular: "mod" | "plugin"; maximumBytes: number }
) {
  if (!file.url.startsWith("https://")) {
    throw new Error(`Refusing to download a non-HTTPS ${options.singular} file`);
  }
  assertModrinthDownloadSize(file.size, options);
}

export function assertModrinthDownloadSize(
  size: number | undefined,
  options: { singular: "mod" | "plugin"; maximumBytes: number }
) {
  if (size && size > options.maximumBytes) {
    throw new Error(`${capitalized(options.singular)} download is larger than ${Math.floor(options.maximumBytes / 1024 / 1024)} MiB`);
  }
}

/**
 * Compares downloaded bytes against the hashes Modrinth published for the file before they become
 * managed executable content. Both installers carry these hashes in metadata they already fetched, so
 * skipping the comparison would let anything that can answer the download URL substitute a JAR.
 */
export function assertModrinthJarHashes(content: Buffer, file: Pick<ModrinthJarFile, "hashes">) {
  const expectedSha1 = file.hashes?.sha1;
  if (expectedSha1 && createHash("sha1").update(content).digest("hex") !== expectedSha1) {
    throw new Error("Downloaded JAR hash did not match Modrinth metadata");
  }
  const expectedSha512 = file.hashes?.sha512;
  if (expectedSha512 && createHash("sha512").update(content).digest("hex") !== expectedSha512) {
    throw new Error("Downloaded JAR hash did not match Modrinth metadata");
  }
}
