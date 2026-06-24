import { describe, expect, it } from "vitest";
import type { ManagedServer } from "../types.js";
import { minecraftJavaMajorVersion, normalizeRuntimeProfile, runtimeProfileForServer } from "./profile.js";

describe("runtime profile helpers", () => {
  it("derives Java requirements from supported Minecraft versions", () => {
    expect(minecraftJavaMajorVersion("1.18")).toBe(17);
    expect(minecraftJavaMajorVersion("1.20.4")).toBe(17);
    expect(minecraftJavaMajorVersion("1.20.5")).toBe(21);
    expect(minecraftJavaMajorVersion("1.21.8")).toBe(21);
    expect(minecraftJavaMajorVersion("26.1.2")).toBe(25);
    expect(() => minecraftJavaMajorVersion("1.17.1")).toThrow("1.18 and newer");
  });

  it("returns the current runtime profile for managed servers", () => {
    const runtimeProfile = {
      minecraftVersion: "1.20.1",
      loader: "fabric" as const,
      loaderVersion: "0.15.11",
      javaMajorVersion: 17 as const,
      jarProvider: "mcjars" as const,
      jarArtifact: {
        filename: "fabric-server-launch.jar",
        downloadUrl: "https://example.invalid/fabric-server-launch.jar"
      },
      compatibilityStatus: "compatible" as const,
      resolvedAt: new Date().toISOString()
    };
    const server = {
      id: "server-1",
      nodeId: "local",
      displayName: "Survival",
      serverDir: "/tmp/survival",
      runtimeProfile,
      createdAt: "",
      updatedAt: ""
    } satisfies ManagedServer;

    expect(runtimeProfileForServer(server)).toBe(runtimeProfile);
  });

  it("rejects unsafe runtime artifact filenames during normalization", () => {
    expect(() => normalizeRuntimeProfile({
      minecraftVersion: "1.21.4",
      loader: "fabric",
      loaderVersion: "0.16.10",
      javaMajorVersion: 21,
      jarProvider: "mcjars",
      jarArtifact: {
        filename: "../server.jar",
        downloadUrl: "https://example.invalid/server.jar"
      },
      compatibilityStatus: "compatible",
      resolvedAt: new Date().toISOString()
    })).toThrow("local .jar filename");
  });
});
