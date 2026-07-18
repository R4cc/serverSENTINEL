import { describe, expect, it, vi } from "vitest";
import type { ServerRuntimeType } from "../types.js";
import type { ServerJarProvider } from "./profile.js";
import { RuntimeServerJarProvider } from "./serverJarProvider.js";

function provider(runtimeType: ServerRuntimeType): ServerJarProvider {
  return {
    listMinecraftVersions: vi.fn(async () => [{ id: runtimeType === "paper" ? "1.21.11" : "1.21.4", supported: true, javaMajorVersion: 21 }]),
    listRuntimeVersions: vi.fn(async () => [{ id: "version", runtimeVersion: runtimeType === "paper" ? "132" : "0.16.10" }]),
    resolveServerJar: vi.fn(async (input) => ({
      minecraftVersion: input.minecraftVersion,
      runtimeType,
      runtimeVersion: input.runtimeVersion || "latest",
      javaMajorVersion: 21,
      jarProvider: runtimeType === "paper" ? "papermc" : "mcjars",
      jarArtifact: { filename: runtimeType === "paper" ? "paper.jar" : "fabric-server-launch.jar" },
      compatibilityStatus: "compatible",
      resolvedAt: "2026-07-18T00:00:00.000Z"
    }))
  };
}

describe("runtime server jar provider registry", () => {
  it("dispatches Fabric and Paper without sharing provider behavior", async () => {
    const fabric = provider("fabric");
    const paper = provider("paper");
    const registry = new RuntimeServerJarProvider({ fabric, paper });

    await registry.listMinecraftVersions("paper");
    await registry.listRuntimeVersions("fabric", "1.21.4");
    await registry.resolveServerJar({ runtimeType: "paper", minecraftVersion: "1.21.11", runtimeVersion: "132" });

    expect(paper.listMinecraftVersions).toHaveBeenCalledWith("paper", undefined);
    expect(fabric.listRuntimeVersions).toHaveBeenCalledWith("fabric", "1.21.4", undefined);
    expect(paper.resolveServerJar).toHaveBeenCalledWith({ runtimeType: "paper", minecraftVersion: "1.21.11", runtimeVersion: "132" });
    expect(fabric.resolveServerJar).not.toHaveBeenCalled();
  });
});
