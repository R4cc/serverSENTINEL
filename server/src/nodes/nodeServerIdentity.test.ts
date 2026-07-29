import { describe, expect, it, vi } from "vitest";
import { RemoteNodeRuntime } from "./remoteNodeRuntime.js";
import type { ManagedServer } from "../types.js";

/**
 * A node answers server.create and server.update with a whole server record that the panel persists,
 * so a compromised node could name another node's server and have the panel rewrite that record --
 * including its nodeId -- handing the sibling's server to the attacker.
 */

const ownNodeId = "node-1";
const siblingServerId = "22222222-2222-2222-2222-222222222222";
const ownServerId = "11111111-1111-1111-1111-111111111111";

function managedServer(overrides: Partial<ManagedServer> = {}): ManagedServer {
  return {
    id: ownServerId,
    nodeId: ownNodeId,
    displayName: "Survival",
    serverDir: "/data/servers/survival",
    storageName: "survival",
    runtimeProfile: {
      minecraftVersion: "1.21.1",
      runtimeType: "fabric",
      runtimeVersion: "0.16.0",
      javaMajorVersion: 21,
      jarProvider: "mcjars",
      jarArtifact: { filename: "server.jar" },
      compatibilityStatus: "compatible",
      resolvedAt: "2026-01-01T00:00:00.000Z"
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

/** Builds a runtime whose node returns whatever `response` says, capturing what the panel persists. */
function runtimeReturning(response: unknown) {
  const persisted: ManagedServer[] = [];
  const updated: ManagedServer[] = [];
  const runtime = new RemoteNodeRuntime(
    ownNodeId,
    async () => ({ id: ownNodeId, name: "node-1" } as never),
    { } as never,
    async (server) => server as never,
    async (server) => { persisted.push(server); },
    async (server) => { updated.push(server); },
    async () => undefined
  );
  vi.spyOn(runtime as unknown as { command: () => Promise<unknown> }, "command").mockResolvedValue(response);
  return { runtime, persisted, updated };
}

describe("remote node server identity binding", () => {
  it("persists a created server under the node the command was sent to", async () => {
    // The node claims the server belongs to a different node.
    const { runtime, persisted } = runtimeReturning(managedServer({ nodeId: "node-2" }));

    const created = await runtime.createServer({});

    expect(created.nodeId).toBe(ownNodeId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].nodeId).toBe(ownNodeId);
  });

  it("rejects an update naming a different server than the one addressed", async () => {
    const { runtime, updated } = runtimeReturning(managedServer({ id: siblingServerId }));

    await expect(runtime.updateServer(managedServer(), {}))
      .rejects.toThrow(`returned server ${siblingServerId} for a request about server ${ownServerId}`);
    expect(updated).toEqual([]);
  });

  it("rebinds node ownership on update even when the record is otherwise unchanged", async () => {
    const { runtime, updated } = runtimeReturning(managedServer({ nodeId: "node-2" }));

    const result = await runtime.updateServer(managedServer(), {});

    expect(result.nodeId).toBe(ownNodeId);
    expect(updated[0].nodeId).toBe(ownNodeId);
  });

  it("rejects a malformed server id instead of persisting it", async () => {
    const { runtime, persisted } = runtimeReturning(managedServer({ id: "../../etc/passwd" }));

    await expect(runtime.createServer({})).rejects.toThrow("A valid server id is required");
    expect(persisted).toEqual([]);
  });

  it("keeps node-local paths as the node reported them", async () => {
    const { runtime, persisted } = runtimeReturning(managedServer({ serverDir: "/srv/minecraft/custom" }));

    await runtime.createServer({});

    expect(persisted[0].serverDir).toBe("/srv/minecraft/custom");
  });
});
