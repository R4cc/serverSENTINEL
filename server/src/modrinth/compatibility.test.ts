import { describe, expect, it } from "vitest";
import { resolveCompatibilityFromVersions, unknownCompatibility } from "./compatibility.js";
import type { ModrinthVersion, ReleaseChannel } from "../types.js";

function version(input: Partial<ModrinthVersion> & { id: string; loaders: string[]; game_versions: string[]; version_type?: ReleaseChannel; jar?: boolean }): ModrinthVersion {
  return {
    id: input.id,
    version_number: input.version_number ?? input.id,
    version_type: input.version_type ?? "release",
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
  projectSides?: { server_side?: string; client_side?: string }
) {
  return resolveCompatibilityFromVersions(
    versions,
    {
      loader: "fabric",
      minecraftVersion: "1.21.4",
      channel
    },
    projectSides ?? { server_side: "required" }
  );
}

describe("Modrinth compatibility resolver", () => {
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
