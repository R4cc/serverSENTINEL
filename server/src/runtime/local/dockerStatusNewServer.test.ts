import { beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeRunning } from "../../mods/modService.js";
import type { ManagedServer } from "../../types.js";

/**
 * A managed container is only created on the first start, so an imported or freshly created server
 * has none. That is a known state -- the server is definitively not running -- and not the unknown
 * one the panel reports when it cannot reach a runtime at all. Mod changes gate on the difference,
 * so getting it wrong leaves a newly imported server unable to update a mod until someone starts
 * and stops it.
 */

const dockerRequestMock = vi.fn();
let socketMounted = true;

vi.mock("../../docker/dockerClient.js", () => ({
  dockerAvailable: () => socketMounted,
  dockerRequest: (...args: unknown[]) => dockerRequestMock(...args),
  dockerJsonRequest: vi.fn(),
  dockerBufferRequest: vi.fn(),
  isMissingDockerNetworkError: () => false,
  sendDockerContainerStdinLine: vi.fn()
}));

function importedServer(overrides: Partial<ManagedServer> = {}): ManagedServer {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    nodeId: "local",
    displayName: "Survival",
    serverDir: "/data/servers/survival",
    dockerContainer: "serversentinel-survival",
    dockerMountSource: "/data/servers/survival",
    dockerPorts: "25565:25565/tcp",
    runtimeProfile: {
      minecraftVersion: "1.21.1",
      runtimeType: "fabric",
      runtimeVersion: "0.16.10",
      javaMajorVersion: 21,
      jarProvider: "mcjars",
      jarArtifact: { filename: "fabric-server-launch.jar" },
      compatibilityStatus: "compatible",
      resolvedAt: "2026-01-01T00:00:00.000Z"
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

beforeEach(() => {
  socketMounted = true;
  dockerRequestMock.mockReset();
  dockerRequestMock.mockRejectedValue(new Error("No such container: serversentinel-survival"));
});

describe("runtime status for a server that has never started", () => {
  it("reports the absent container as not running", async () => {
    const { dockerStatus } = await import("./dockerContainers.js");

    const status = await dockerStatus(importedServer());

    expect(status).toMatchObject({ configured: true, available: true, state: "unknown", running: false });
    expect(status.message).toBe("Managed container will be created on start");
    // The gate a mod change uses: `undefined` means "cannot tell" and refuses the change.
    expect(runtimeRunning({ docker: status })).toBe(false);
  });

  it("still reports an unreachable runtime as unknown", async () => {
    const { dockerStatus } = await import("./dockerContainers.js");
    socketMounted = false;

    const status = await dockerStatus(importedServer());

    expect(status).toMatchObject({ available: false, state: "unknown" });
    expect(status).not.toHaveProperty("running", false);
    expect(runtimeRunning({ docker: status })).toBeUndefined();
  });

  it("still reports a server with no Docker integration as unknown", async () => {
    const { dockerStatus } = await import("./dockerContainers.js");

    const status = await dockerStatus(importedServer({ dockerContainer: "", dockerMountSource: "" }));

    expect(status).toMatchObject({ configured: false, state: "unknown" });
    expect(runtimeRunning({ docker: status })).toBeUndefined();
  });
});
