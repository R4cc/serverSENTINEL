import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../config.js";
import { managedContainerLabels } from "../containerLabels.js";
import type { ManagedServer } from "../../types.js";

/**
 * Docker kills a container that has not exited within its stop timeout, and its ten second default
 * is far shorter than a Minecraft world save. That timeout is the only thing standing between a
 * world and a SIGKILL when something other than serverSENTINEL stops the container - a `docker stop`
 * from the shell, or the stop the daemon issues to everything it runs when the Docker package is
 * upgraded - because no `stop` console command precedes those.
 */

const dockerRequestMock = vi.fn();
const dockerJsonRequestMock = vi.fn();

vi.mock("../../docker/dockerClient.js", () => ({
  dockerAvailable: () => true,
  dockerRequest: (...args: unknown[]) => dockerRequestMock(...args),
  dockerJsonRequest: (...args: unknown[]) => dockerJsonRequestMock(...args),
  dockerBufferRequest: vi.fn(),
  dockerLogTailMaxBytes: 1024,
  isMissingDockerNetworkError: () => false,
  sendDockerContainerStdinLine: vi.fn()
}));

const serverId = "00000000-0000-4000-8000-000000000001";
const containerName = "serversentinel-minecraft";
const configuredStopTimeout = config.minecraftStopTimeoutSeconds;

const server: ManagedServer = {
  id: serverId,
  nodeId: "local",
  displayName: "survivor",
  serverDir: "/data/servers/survivor",
  dockerContainer: containerName,
  dockerMountSource: "/data/servers/survivor",
  dockerPorts: "25565:25565/tcp",
  runtimeProfile: {
    minecraftVersion: "1.21",
    runtimeType: "paper",
    runtimeVersion: "1",
    javaMajorVersion: 21,
    jarProvider: "papermc",
    jarArtifact: { filename: "server.jar" },
    compatibilityStatus: "compatible",
    resolvedAt: "2026-01-01T00:00:00.000Z"
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

function ownedInspect(configHash: string, running: boolean) {
  return {
    Id: "container-id",
    Name: `/${containerName}`,
    State: { Status: running ? "running" : "exited", Running: running },
    Config: { Labels: managedContainerLabels(serverId, configHash), OpenStdin: true, AttachStdin: true },
    HostConfig: { RestartPolicy: { Name: "no" } },
    Mounts: [{ Type: "bind", Source: "/data/servers/survivor", Destination: "/data/server" }]
  };
}

/** Answers this server's container inspect with `payload`; every other Docker read succeeds emptily. */
function respondWith(payload: unknown) {
  dockerRequestMock.mockImplementation(async (_method: string, path: string) => {
    if (!path.startsWith(`/containers/${containerName}/json`)) return {};
    if (payload === null) throw new Error("No such container");
    return payload;
  });
}

function createdContainerConfig() {
  return dockerJsonRequestMock.mock.calls.find(([, path]) => String(path).startsWith("/containers/create"))?.[2];
}

function postedAction(fragment: string) {
  return dockerRequestMock.mock.calls.find(([method, path]) => method === "POST" && String(path).includes(fragment));
}

describe("Minecraft container stop grace period", () => {
  beforeEach(() => {
    dockerRequestMock.mockReset();
    dockerJsonRequestMock.mockReset();
    dockerJsonRequestMock.mockResolvedValue({});
  });

  afterEach(() => {
    config.minecraftStopTimeoutSeconds = configuredStopTimeout;
  });

  it("creates managed containers with the configured stop timeout", async () => {
    respondWith(null);
    const { ensureDockerContainer } = await import("./dockerContainers.js");

    await ensureDockerContainer(server);

    expect(createdContainerConfig()).toMatchObject({ StopTimeout: configuredStopTimeout });
  });

  it("replaces a container that was created with a different stop timeout", async () => {
    const { dockerRuntimeConfigHash, ensureDockerContainer } = await import("./dockerContainers.js");
    const hashBeforeChange = dockerRuntimeConfigHash(server);
    config.minecraftStopTimeoutSeconds = configuredStopTimeout + 30;
    respondWith(ownedInspect(hashBeforeChange, false));

    await ensureDockerContainer(server);

    expect(dockerRequestMock).toHaveBeenCalledWith("DELETE", expect.stringContaining(containerName), 204);
    expect(createdContainerConfig()).toMatchObject({ StopTimeout: configuredStopTimeout + 30 });
  });

  it("asks Docker for the full grace period when stopping, and waits longer than it for the answer", async () => {
    const { dockerAction, dockerRuntimeConfigHash } = await import("./dockerContainers.js");
    respondWith(ownedInspect(dockerRuntimeConfigHash(server), true));

    await dockerAction(server, "stop");

    const stop = postedAction("/stop");
    expect(stop?.[1]).toContain(`/stop?t=${configuredStopTimeout}`);
    expect(stop?.[4]).toBeGreaterThan(configuredStopTimeout * 1_000);
  });

  it("gives a restart the same grace period", async () => {
    const { dockerAction, dockerRuntimeConfigHash } = await import("./dockerContainers.js");
    respondWith(ownedInspect(dockerRuntimeConfigHash(server), true));

    await dockerAction(server, "restart");

    const restart = postedAction("/restart");
    expect(restart?.[1]).toContain(`/restart?t=${configuredStopTimeout}`);
    expect(restart?.[4]).toBeGreaterThan(configuredStopTimeout * 1_000);
  });

  it("leaves a start unbounded by the stop grace period", async () => {
    const { dockerAction, dockerRuntimeConfigHash } = await import("./dockerContainers.js");
    respondWith(ownedInspect(dockerRuntimeConfigHash(server), true));

    await dockerAction(server, "start");

    const start = postedAction("/start");
    expect(start?.[1]).not.toContain("?t=");
    expect(start?.[4]).toBeUndefined();
  });
});
