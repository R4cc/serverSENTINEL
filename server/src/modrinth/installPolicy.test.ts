import { describe, expect, it } from "vitest";
import {
  assertDownloadableModrinthFile,
  assertModrinthDownloadSize,
  assertVersionInstallable,
  compatibilityFromSelectedVersion,
  managedContentNaming
} from "./installPolicy.js";
import type { ModrinthVersion, ReleaseChannel } from "../types.js";

function version(input: Partial<ModrinthVersion> & { id: string; loaders: string[]; game_versions: string[] }): ModrinthVersion {
  return {
    id: input.id,
    version_number: input.version_number ?? input.id,
    version_type: input.version_type ?? "release",
    date_published: input.date_published,
    loaders: input.loaders,
    game_versions: input.game_versions,
    files: input.files ?? [{
      filename: `${input.id}.jar`,
      url: `https://cdn.example.test/${input.id}.jar`,
      primary: true,
      size: 123,
      hashes: { sha1: input.id }
    }]
  };
}

const fabric = managedContentNaming("fabric");
const paper = managedContentNaming("paper");

function assertInstallable(overrides: {
  version?: ModrinthVersion;
  serverSide?: string;
  channel?: ReleaseChannel;
  forceIncompatible?: boolean;
  overrideMinecraftVersion?: boolean;
  requireKnownServerSide?: boolean;
  naming?: typeof fabric;
} = {}) {
  return assertVersionInstallable({
    version: overrides.version ?? version({ id: "v1", loaders: ["fabric"], game_versions: ["1.21.4"] }),
    project: { server_side: overrides.serverSide ?? "required", client_side: "optional" },
    naming: overrides.naming ?? fabric,
    minecraftVersion: "1.21.4",
    channel: overrides.channel ?? "release",
    forceIncompatible: overrides.forceIncompatible ?? false,
    overrideMinecraftVersion: overrides.overrideMinecraftVersion ?? false,
    requireKnownServerSide: overrides.requireKnownServerSide ?? true
  });
}

describe("managedContentNaming", () => {
  it("describes mod and plugin runtimes", () => {
    expect(fabric).toMatchObject({ singular: "mod", plural: "mods", directory: "mods" });
    expect(paper).toMatchObject({ singular: "plugin", plural: "plugins" });
    expect(paper.loaders).toContain("paper");
  });
});

describe("assertVersionInstallable", () => {
  it("accepts a compatible server-side release", () => {
    const candidate = assertInstallable();
    expect(candidate).toMatchObject({ compatible: true, matchesMinecraft: true, hasCompatibleLoader: true });
    expect(candidate.incompatibilityReason).toBeUndefined();
    expect(candidate.file.filename).toBe("v1.jar");
  });

  it("rejects a version outside the requested channel", () => {
    expect(() => assertInstallable({
      version: version({ id: "beta", loaders: ["fabric"], game_versions: ["1.21.4"], version_type: "beta" })
    })).toThrow("outside the requested release channel");
  });

  it("rejects a version with no installable jar", () => {
    expect(() => assertInstallable({
      version: version({ id: "nojar", loaders: ["fabric"], game_versions: ["1.21.4"], files: [] })
    })).toThrow("No installable .jar file was found for that version");
  });

  it("rejects a loader the runtime cannot use, naming the runtime", () => {
    expect(() => assertInstallable({
      version: version({ id: "forge", loaders: ["forge"], game_versions: ["1.21.4"] })
    })).toThrow(`The selected version is not compatible with ${fabric.displayName}`);
  });

  it("always rejects client-only content, naming the runtime's content kind", () => {
    expect(() => assertInstallable({ serverSide: "unsupported" })).toThrow("Client-only mods cannot be installed on the server");
    expect(() => assertInstallable({
      serverSide: "unsupported",
      naming: paper,
      version: version({ id: "v1", loaders: ["paper"], game_versions: ["1.21.4"] }),
      requireKnownServerSide: false
    })).toThrow("Client-only plugins cannot be installed on the server");
  });

  describe("unknown server-side support", () => {
    it("blocks the panel until the risk is confirmed", () => {
      expect(() => assertInstallable({ serverSide: "unknown" })).toThrow("Server-side support is unknown");
      expect(assertInstallable({ serverSide: "unknown", forceIncompatible: true }))
        .toMatchObject({ compatible: false, incompatibilityReason: "Server-side support could not be verified" });
    });

    it("lets the node agent through, since it cannot prompt", () => {
      expect(assertInstallable({ serverSide: "unknown", requireKnownServerSide: false }))
        .toMatchObject({ serverSupported: false, compatible: false });
    });
  });

  describe("Minecraft version mismatch", () => {
    const mismatched = version({ id: "old", loaders: ["fabric"], game_versions: ["1.20.1"] });

    it("requires an explicit override", () => {
      expect(() => assertInstallable({ version: mismatched }))
        .toThrow("This version is not marked for Minecraft 1.21.4. Confirm the Minecraft version override before installing.");
    });

    it("reports the mismatch once overridden", () => {
      expect(assertInstallable({ version: mismatched, overrideMinecraftVersion: true })).toMatchObject({
        matchesMinecraft: false,
        compatible: false,
        incompatibilityReason: "Installed with Minecraft version override. Server 1.21.4; mod 1.20.1."
      });
    });

    it("names plugins as plugins in the mismatch reason", () => {
      const candidate = assertVersionInstallable({
        version: version({ id: "old", loaders: ["paper"], game_versions: ["1.20.1"] }),
        project: { server_side: "required", client_side: "unsupported" },
        naming: paper,
        minecraftVersion: "1.21.4",
        channel: "release",
        forceIncompatible: false,
        overrideMinecraftVersion: true,
        requireKnownServerSide: true
      });
      expect(candidate.incompatibilityReason).toBe("Installed with Minecraft version override. Server 1.21.4; plugin 1.20.1.");
    });
  });
});

describe("compatibilityFromSelectedVersion", () => {
  it("carries the matched version and project sides into the compatibility record", () => {
    const selected = version({ id: "v1", loaders: ["fabric"], game_versions: ["1.21.4"] });
    const candidate = assertInstallable({ version: selected });

    expect(compatibilityFromSelectedVersion({
      version: selected,
      file: candidate.file,
      projectSides: { server_side: "required", client_side: "optional" },
      compatible: true,
      reason: "Compatible server-side Fabric mod"
    })).toMatchObject({
      status: "compatible",
      compatible: true,
      reason: "Compatible server-side Fabric mod",
      matchedVersionId: "v1",
      matchedVersionType: "release",
      matchedLoaders: ["fabric"],
      matchedGameVersions: ["1.21.4"],
      serverSide: "required",
      clientSide: "optional"
    });
  });

  it("marks an incompatible install as incompatible", () => {
    const selected = version({ id: "v1", loaders: ["fabric"], game_versions: ["1.20.1"] });
    const candidate = assertInstallable({ version: selected, overrideMinecraftVersion: true });
    expect(compatibilityFromSelectedVersion({
      version: selected,
      file: candidate.file,
      projectSides: {},
      compatible: false,
      reason: "Installed with Minecraft version override"
    })).toMatchObject({ status: "incompatible", compatible: false });
  });
});

describe("download guards", () => {
  it("refuses non-HTTPS downloads, naming the content kind", () => {
    expect(() => assertDownloadableModrinthFile({ url: "http://cdn.example.test/a.jar", size: 1 }, { singular: "mod", maximumBytes: 1024 }))
      .toThrow("Refusing to download a non-HTTPS mod file");
    expect(() => assertDownloadableModrinthFile({ url: "http://cdn.example.test/a.jar", size: 1 }, { singular: "plugin", maximumBytes: 1024 }))
      .toThrow("Refusing to download a non-HTTPS plugin file");
  });

  it("enforces the size limit and reports it in MiB", () => {
    expect(() => assertDownloadableModrinthFile({ url: "https://cdn.example.test/a.jar", size: 5 * 1024 * 1024 }, { singular: "mod", maximumBytes: 2 * 1024 * 1024 }))
      .toThrow("Mod download is larger than 2 MiB");
    expect(() => assertModrinthDownloadSize(5 * 1024 * 1024, { singular: "plugin", maximumBytes: 2 * 1024 * 1024 }))
      .toThrow("Plugin download is larger than 2 MiB");
  });

  it("allows a download with no advertised size", () => {
    expect(() => assertDownloadableModrinthFile({ url: "https://cdn.example.test/a.jar" }, { singular: "mod", maximumBytes: 1 })).not.toThrow();
    expect(() => assertModrinthDownloadSize(0, { singular: "mod", maximumBytes: 1 })).not.toThrow();
  });
});
