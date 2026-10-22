import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../config.js";
import { managedContainerLabels } from "../containerLabels.js";
import type { ManagedServer } from "../../types.js";
import { dockerRuntimeConfigHash, ensureDockerContainer } from "./dockerContainers.js";

const dockerRequest = vi.fn(), dockerJsonRequest = vi.fn();
vi.mock("../../docker/dockerClient.js", () => ({
  dockerAvailable: () => true,
  dockerRequest: (...args: unknown[]) => dockerRequest(...args),
  dockerJsonRequest: (...args: unknown[]) => dockerJsonRequest(...args),
  dockerBufferRequest: vi.fn(), dockerLogTailMaxBytes: 1024,
  isMissingDockerNetworkError: () => false, sendDockerContainerStdinLine: vi.fn()
}));

const previous = { directory: config.serversDir, volume: config.serversDockerVolume };
function server(name: string): ManagedServer {
  return {
    id: name, nodeId: "local", displayName: name, serverDir: `/data/servers/${name}`, storageName: name,
    dockerMountSource: "minecraft-data", dockerWorkingDir: `/data/servers/${name}`, dockerContainer: `ss-${name}`,
    dockerPorts: "25565:25565/tcp", javaArgs: "-Xmx1G",
    runtimeProfile: { minecraftVersion: "1.21", runtimeType: "paper", runtimeVersion: "1", javaMajorVersion: 21, jarProvider: "papermc",
      jarArtifact: { filename: "server.jar" }, compatibilityStatus: "compatible", resolvedAt: "now" }, createdAt: "now", updatedAt: "now"
  };
}
function created() {
  return dockerJsonRequest.mock.calls.filter(([, path]) => String(path).startsWith("/containers/create")).map(call => call[2]);
}

describe("Minecraft named-volume isolation", () => {
  beforeEach(() => {
    config.serversDir = "/data/servers";
    config.serversDockerVolume = "minecraft-data";
    dockerRequest.mockReset(); dockerJsonRequest.mockReset();
    dockerJsonRequest.mockResolvedValue({});
    dockerRequest.mockImplementation(async (_method, path) => {
      if (path === "/version") return { ApiVersion: "1.45" };
      if (String(path).startsWith("/containers/ss-")) throw new Error("No such container");
      return {};
    });
  });
  afterEach(() => { config.serversDir = previous.directory; config.serversDockerVolume = previous.volume; });

  it("mounts a separate volume child for each server and preserves its working directory", async () => {
    for (const name of ["survival", "creative"]) await ensureDockerContainer(server(name));
    for (const [index, name] of ["survival", "creative"].entries()) {
      expect(created()[index]).toMatchObject({ WorkingDir: `/data/servers/${name}`, HostConfig: { Mounts: [{
        Type: "volume", Source: "minecraft-data", Target: `/data/servers/${name}`, VolumeOptions: { Subpath: name, NoCopy: true }
      }] } });
      expect(created()[index].HostConfig.Mounts).toHaveLength(1);
    }
  });

  it.each(["1.44", "invalid", undefined])("refuses unsupported Docker API %s before mutating containers", async version => {
    dockerRequest.mockResolvedValue({ ApiVersion: version });
    await expect(ensureDockerContainer(server("survival"))).rejects.toThrow("API 1.45");
    expect(dockerJsonRequest).not.toHaveBeenCalled();
    expect(dockerRequest.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });

  it("rejects the volume root and paths outside it", async () => {
    for (const serverDir of ["/data/servers", "/data/other"]) {
      await expect(ensureDockerContainer({ ...server("survival"), serverDir })).rejects.toThrow("must use a child");
    }
    expect(dockerJsonRequest).not.toHaveBeenCalled();
  });

  it("replaces a legacy whole-volume mount even with a matching configuration label", async () => {
    const instance = server("survival"), hash = dockerRuntimeConfigHash(instance, { includeTerminal: true, restartPolicy: "no" });
    dockerRequest.mockImplementation(async (method, path) => {
      if (path === "/version") return { ApiVersion: "1.56" };
      if (method === "GET" && path === "/containers/ss-survival/json") return {
        Config: { Labels: managedContainerLabels(instance.id, hash), OpenStdin: true, AttachStdin: true },
        HostConfig: { RestartPolicy: { Name: "no" } },
        Mounts: [{ Type: "volume", Name: "minecraft-data", Destination: "/data/servers" }]
      };
      return {};
    });
    await ensureDockerContainer(instance);
    expect(dockerRequest).toHaveBeenCalledWith("DELETE", "/containers/ss-survival?force=1", 204);
    expect(created()[0].HostConfig.Mounts[0].VolumeOptions.Subpath).toBe("survival");
  });

  it("reuses a correctly isolated container", async () => {
    const instance = server("survival"), hash = dockerRuntimeConfigHash(instance, { includeTerminal: true, restartPolicy: "no" });
    dockerRequest.mockImplementation(async (_method, path) => path === "/version" ? { ApiVersion: "1.45" } : {
      Config: { Labels: managedContainerLabels(instance.id, hash), OpenStdin: true, AttachStdin: true },
      HostConfig: { RestartPolicy: { Name: "no" }, Mounts: [{ Type: "volume", Source: "minecraft-data", Target: "/data/servers/survival", VolumeOptions: { Subpath: "survival" } }] },
      Mounts: [{ Type: "volume", Name: "minecraft-data", Destination: "/data/servers/survival" }]
    });
    await ensureDockerContainer(instance);
    expect(dockerJsonRequest).not.toHaveBeenCalled();
  });
});
