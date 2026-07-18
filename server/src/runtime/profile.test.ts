import { describe, expect, it } from "vitest";
import type { ManagedServer } from "../types.js";
import { minecraftJavaMajorVersion, normalizeRuntimeProfile, runtimeProfileForServer, runtimeTarget } from "./profile.js";

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
      runtimeType: "fabric" as const,
      runtimeVersion: "0.15.11",
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

  it("upgrades legacy Fabric profiles to the canonical runtime fields", () => {
    expect(normalizeRuntimeProfile({
      minecraftVersion: "1.21.4",
      loader: "fabric",
      loaderVersion: "0.16.10",
      javaMajorVersion: 21,
      jarProvider: "mcjars",
      jarArtifact: { filename: "fabric-server-launch.jar" },
      compatibilityStatus: "compatible",
      resolvedAt: "2026-07-18T00:00:00.000Z"
    })).toMatchObject({
      runtimeType: "fabric",
      runtimeVersion: "0.16.10",
      loader: "fabric",
      loaderVersion: "0.16.10"
    });
  });

  it("accepts canonical Paper profiles without Fabric compatibility aliases", () => {
    const profile = normalizeRuntimeProfile({
      minecraftVersion: "1.21.4",
      runtimeType: "paper",
      runtimeVersion: "1.21.4-232",
      javaMajorVersion: 21,
      jarProvider: "papermc",
      jarArtifact: { filename: "paper.jar" },
      compatibilityStatus: "compatible",
      resolvedAt: "2026-07-18T00:00:00.000Z"
    });
    expect(profile).toEqual({
      minecraftVersion: "1.21.4",
      runtimeType: "paper",
      runtimeVersion: "1.21.4-232",
      javaMajorVersion: 21,
      jarProvider: "papermc",
      jarArtifact: { filename: "paper.jar" },
      compatibilityStatus: "compatible",
      resolvedAt: "2026-07-18T00:00:00.000Z"
    });
    expect(runtimeTarget({ runtimeProfile: profile })).toMatchObject({
      runtimeType: "paper",
      runtimeVersion: "1.21.4-232",
      serverJar: "paper.jar"
    });
  });

  it("rejects conflicting runtime aliases and runtime providers", () => {
    const paperProfile = {
      minecraftVersion: "1.21.4",
      runtimeType: "paper",
      runtimeVersion: "1.21.4-232",
      javaMajorVersion: 21,
      jarProvider: "papermc",
      jarArtifact: { filename: "paper.jar" },
      compatibilityStatus: "compatible",
      resolvedAt: "2026-07-18T00:00:00.000Z"
    };

    expect(() => normalizeRuntimeProfile({ ...paperProfile, loader: "fabric" })).toThrow("loader does not match runtimeType");
    expect(() => normalizeRuntimeProfile({ ...paperProfile, loaderVersion: "0.16.10" })).toThrow("loaderVersion does not match runtimeVersion");
    expect(() => normalizeRuntimeProfile({ ...paperProfile, jarProvider: "mcjars" })).toThrow("must be papermc for paper");
  });
});
