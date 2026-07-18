import { describe, expect, it } from "vitest";
import { latestCompatibleProjectVersion, minecraftVersionFacetValues, minecraftVersionsInclude, modrinthVersionIsNewer, resolveCompatibilityFromVersions, unknownCompatibility } from "./compatibility.js";
import type { ModrinthVersion, ReleaseChannel } from "../types.js";

function version(input: Partial<ModrinthVersion> & { id: string; loaders: string[]; game_versions: string[]; version_type?: ReleaseChannel; jar?: boolean }): ModrinthVersion {
  return {
    id: input.id,
    version_number: input.version_number ?? input.id,
    version_type: input.version_type ?? "release",
    date_published: input.date_published,
    loaders: input.loaders,
    game_versions: input.game_versions,
    files: input.jar === false ? [] : [{
      filename: `${input.id}.jar`,
      url: `https://cdn.example.test/${input.id}.jar`,
      primary: true,
      size: 123,
      hashes: { sha1: input.id }
    }]
  };
}

function resolve(
  versions: ModrinthVersion[],
  channel: ReleaseChannel = "release",
  projectSides?: { server_side?: string; client_side?: string },
  minecraftVersion = "1.21.4"
) {
  return resolveCompatibilityFromVersions(
    versions,
    {
      loader: "fabric",
      minecraftVersion,
      channel
    },
    projectSides ?? { server_side: "required" }
  );
}

describe("Modrinth compatibility resolver", () => {
  it.each(["paper", "bukkit", "spigot"])("accepts a %s plugin release for Paper", (loader) => {
    const result = resolveCompatibilityFromVersions(
      [version({ id: `${loader}-plugin`, loaders: [loader], game_versions: ["1.21.4"] })],
      { loaders: ["paper", "bukkit", "spigot"], runtimeName: "Paper", contentKind: "plugin", minecraftVersion: "1.21.4", channel: "release" },
      { server_side: "required" }
    );

    expect(result).toMatchObject({ status: "compatible", compatible: true, reason: "Compatible server-side Paper plugin" });
  });

  it("rejects runtime-specific plugin releases that are not compatible with Paper", () => {
    const result = resolveCompatibilityFromVersions(
      [version({ id: "folia-plugin", loaders: ["folia"], game_versions: ["1.21.4"] })],
      { loaders: ["paper", "bukkit", "spigot"], runtimeName: "Paper", contentKind: "plugin", minecraftVersion: "1.21.4", channel: "release" },
      { server_side: "required" }
    );

    expect(result).toMatchObject({ status: "no_compatible_loader", compatible: false, reason: "No Paper-compatible version available" });
  });

  it("accepts a Fabric-only compatible version", () => {
    const result = resolve([version({ id: "fabric-release", loaders: ["fabric"], game_versions: ["1.21.4"] })]);

    expect(result.compatible).toBe(true);
    expect(result.matchedVersionId).toBe("fabric-release");
    expect(result.file?.filename).toBe("fabric-release.jar");
  });

  it("accepts a mixed Fabric and NeoForge compatible version", () => {
    const result = resolve([version({ id: "mixed-loader", loaders: ["fabric", "neoforge"], game_versions: ["1.21.4"] })]);

    expect(result.compatible).toBe(true);
    expect(result.matchedLoaders).toEqual(["fabric", "neoforge"]);
  });

  it("accepts wildcard Minecraft patch versions from Modrinth", () => {
    const result = resolve(
      [version({ id: "minecraft-family", loaders: ["fabric"], game_versions: ["26.1.x"] })],
      "release",
      { server_side: "required" },
      "26.1.2"
    );

    expect(result.compatible).toBe(true);
    expect(result.matchedVersionId).toBe("minecraft-family");
    expect(minecraftVersionsInclude(["26.1.x"], "26.1.2")).toBe(true);
  });

  it("builds Modrinth search facets with exact and wildcard Minecraft versions", () => {
    expect(minecraftVersionFacetValues("26.1.2")).toEqual(["26.1.2", "26.1.x"]);
  });

  it("rejects a NeoForge-only version as not Fabric", () => {
    const result = resolve([version({ id: "neoforge-only", loaders: ["neoforge"], game_versions: ["1.21.4"] })]);

    expect(result.compatible).toBe(false);
    expect(result.reason).toBe("No Fabric version available");
  });

  it("rejects Fabric versions for the wrong Minecraft version", () => {
    const result = resolve([version({ id: "wrong-mc", loaders: ["fabric"], game_versions: ["1.20.1"] })]);

    expect(result.compatible).toBe(false);
    expect(result.reason).toBe("Not available for Minecraft 1.21.4");
  });

  it("rejects matching Fabric versions with no installable jar", () => {
    const result = resolve([version({ id: "no-jar", loaders: ["fabric"], game_versions: ["1.21.4"], jar: false })]);

    expect(result.compatible).toBe(false);
    expect(result.reason).toBe("No installable .jar file was found");
  });

  it("respects release channel filtering", () => {
    const releaseOnly = resolve([version({ id: "beta-build", loaders: ["fabric"], game_versions: ["1.21.4"], version_type: "beta" })]);
    const betaAllowed = resolve([version({ id: "beta-build", loaders: ["fabric"], game_versions: ["1.21.4"], version_type: "beta" })], "beta");

    expect(releaseOnly.compatible).toBe(false);
    expect(releaseOnly.reason).toBe("No version matched the selected release channel");
    expect(betaAllowed.compatible).toBe(true);
  });

  it("chooses the newest compatible version by publish date", () => {
    const latest = latestCompatibleProjectVersion([
      version({ id: "older", version_number: "1.2.0", loaders: ["fabric"], game_versions: ["26.1.2"], date_published: "2026-06-11T19:29:30Z" }),
      version({ id: "newer", version_number: "1.2.1", loaders: ["fabric"], game_versions: ["26.1.2"], date_published: "2026-06-15T14:30:22Z" })
    ], {
      loader: "fabric",
      minecraftVersion: "26.1.2",
      channel: "release"
    });

    expect(latest?.version_number).toBe("1.2.1");
  });

  it("detects an installed version newer than a stale update candidate", () => {
    const installed = version({ id: "fabric-api-new", version_number: "0.152.1+26.1.2", loaders: ["fabric"], game_versions: ["26.1.2"], date_published: "2026-06-15T09:40:14Z" });
    const staleLatest = version({ id: "fabric-api-old", version_number: "0.151.0+26.1.2", loaders: ["fabric"], game_versions: ["26.1.2"], date_published: "2026-06-07T13:21:50Z" });

    expect(modrinthVersionIsNewer(installed, staleLatest)).toBe(true);
    expect(modrinthVersionIsNewer(staleLatest, installed)).toBe(false);
  });

  it("uses unknown for API failure compatibility, not a hard incompatibility", () => {
    const result = unknownCompatibility();

    expect(result.compatible).toBe(false);
    expect(result.status).toBe("unknown");
    expect(result.reason).toBe("Compatibility could not be verified.");
  });

  it("accepts server_side=required as compatible", () => {
    const result = resolve(
      [version({ id: "fabric-release", loaders: ["fabric"], game_versions: ["1.21.4"] })],
      "release",
      { server_side: "required", client_side: "optional" }
    );
    expect(result.compatible).toBe(true);
    expect(result.serverSide).toBe("required");
    expect(result.clientSide).toBe("optional");
  });

  it("accepts server_side=optional as compatible", () => {
    const result = resolve(
      [version({ id: "fabric-release", loaders: ["fabric"], game_versions: ["1.21.4"] })],
      "release",
      { server_side: "optional", client_side: "required" }
    );
    expect(result.compatible).toBe(true);
    expect(result.serverSide).toBe("optional");
    expect(result.clientSide).toBe("required");
  });

  it("rejects server_side=unsupported as incompatible/client-only", () => {
    const result = resolve(
      [version({ id: "fabric-release", loaders: ["fabric"], game_versions: ["1.21.4"] })],
      "release",
      { server_side: "unsupported", client_side: "required" }
    );
    expect(result.compatible).toBe(false);
    expect(result.status).toBe("incompatible");
    expect(result.reason).toBe("Client-only mod; server-side support is unsupported");
  });

  it("rejects server_side=unknown as warning/review required", () => {
    const result = resolve(
      [version({ id: "fabric-release", loaders: ["fabric"], game_versions: ["1.21.4"] })],
      "release",
      { server_side: "unknown" }
    );
    expect(result.compatible).toBe(false);
    expect(result.status).toBe("unknown");
    expect(result.reason).toBe("Server-side support could not be verified");
  });
});
