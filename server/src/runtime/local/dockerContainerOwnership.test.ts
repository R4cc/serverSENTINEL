import { beforeEach, describe, expect, it, vi } from "vitest";
import { managedContainerLabels } from "../containerLabels.js";
import type { DockerContainerInspect } from "./dockerContainers.js";
import type { ManagedServer } from "../../types.js";

/**
 * `dockerContainer` is an editable per-server setting, so a server can be pointed at a container that
 * another managed server owns. Every local Docker path must check the owning server id stamped on the
 * container, not just the managed marker, or one server drives its neighbour's runtime.
 */

const dockerRequestMock = vi.fn();
const dockerJsonRequestMock = vi.fn();
const sendDockerContainerStdinLineMock = vi.fn();

vi.mock("../../docker/dockerClient.js", () => ({
  dockerAvailable: () => true,
  dockerRequest: (...args: unknown[]) => dockerRequestMock(...args),
  dockerJsonRequest: (...args: unknown[]) => dockerJsonRequestMock(...args),
  dockerBufferRequest: vi.fn(),
  isMissingDockerNetworkError: () => false,
  sendDockerContainerStdinLine: (...args: unknown[]) => sendDockerContainerStdinLineMock(...args)
}));

const ownerId = "00000000-0000-4000-8000-000000000001";
const neighbourId = "00000000-0000-4000-8000-000000000002";
const sharedContainer = "serversentinel-neighbour";

function managedServer(id: string): ManagedServer {
  return {
    id,
    nodeId: "local",
    displayName: `server-${id.slice(-1)}`,
    serverDir: "/data/servers/server",
    dockerContainer: sharedContainer,
    dockerMountSource: "/data/servers/server",
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
}

/** An inspect payload for a running container that is managed by, and labelled for, `ownerId`. */
function neighbourInspect(): DockerContainerInspect {
  return {
    Id: "container-owned-by-neighbour",
    Name: `/${sharedContainer}`,
    State: { Status: "running", Running: true },
    Config: {
      Labels: managedContainerLabels(neighbourId, "hash-1"),
      OpenStdin: true,
      AttachStdin: true
    },
    HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
    Mounts: [{ Type: "bind", Source: "/data/servers/server", Destination: "/data/server" }]
  };
}

// The attacker's server: a different id, configured with the neighbour's container name.
const attacker = managedServer(ownerId);

describe("local Docker container ownership", () => {
  beforeEach(() => {
    dockerRequestMock.mockReset();
    dockerJsonRequestMock.mockReset();
    sendDockerContainerStdinLineMock.mockReset();
    dockerRequestMock.mockResolvedValue(neighbourInspect());
  });

  it("refuses to send console commands to a container owned by another server", async () => {
    const { sendDockerStdinCommand } = await import("./dockerContainers.js");

    await expect(sendDockerStdinCommand(attacker, "op attacker")).rejects.toThrow(
      "belongs to a different managed server"
    );
    expect(sendDockerContainerStdinLineMock).not.toHaveBeenCalled();
  });

  it("reports console input as unavailable for a container owned by another server", async () => {
    const { dockerCommandInputCapability } = await import("./dockerContainers.js");

    const capability = await dockerCommandInputCapability(attacker);
    expect(capability.available).toBe(false);
    expect(capability.message).toContain("belongs to a different managed server");
  });

  it("refuses to stop a container owned by another server", async () => {
    const { dockerAction } = await import("./dockerContainers.js");

    await expect(dockerAction(attacker, "stop")).rejects.toThrow("belongs to a different managed server");
    expect(dockerRequestMock).not.toHaveBeenCalledWith("POST", expect.stringContaining("/stop"), expect.anything());
  });

  it("refuses to reuse or recreate a container owned by another server", async () => {
    const { ensureDockerContainer } = await import("./dockerContainers.js");

    await expect(ensureDockerContainer(attacker)).rejects.toThrow("belongs to a different managed server");
    expect(dockerJsonRequestMock).not.toHaveBeenCalled();
    expect(dockerRequestMock).not.toHaveBeenCalledWith("DELETE", expect.anything(), expect.anything());
  });

  it("refuses to delete a container owned by another server", async () => {
    const { removeManagedDockerContainer } = await import("./dockerContainers.js");

    await expect(removeManagedDockerContainer(attacker)).rejects.toThrow("belongs to a different managed server");
    expect(dockerRequestMock).not.toHaveBeenCalledWith("DELETE", expect.anything(), expect.anything());
  });

  it("reports a container owned by another server as not controllable", async () => {
    const { dockerStatus } = await import("./dockerContainers.js");

    const status = await dockerStatus(attacker);
    expect(status.controllable).toBe(false);
    expect(status.message).toBe("A same-named Docker container belongs to a different managed server");
  });

  it("does not rewrite the restart policy of a container owned by another server", async () => {
    const { reconcileDockerRestartPolicy } = await import("./dockerContainers.js");

    await reconcileDockerRestartPolicy(attacker, neighbourInspect());
    expect(dockerJsonRequestMock).not.toHaveBeenCalled();
  });

  it("still controls a container the server legitimately owns", async () => {
    const base = neighbourInspect();
    const owned: DockerContainerInspect = {
      ...base,
      Config: { ...base.Config, Labels: managedContainerLabels(ownerId, "hash-1") }
    };
    dockerRequestMock.mockResolvedValue(owned);
    const { dockerCommandInputCapability, reconcileDockerRestartPolicy } = await import("./dockerContainers.js");

    expect((await dockerCommandInputCapability(attacker)).available).toBe(true);
    await reconcileDockerRestartPolicy(attacker, owned);
    expect(dockerJsonRequestMock).toHaveBeenCalledWith(
      "POST",
      expect.stringContaining("/update"),
      { RestartPolicy: { Name: "no" } },
      200
    );
  });
});
