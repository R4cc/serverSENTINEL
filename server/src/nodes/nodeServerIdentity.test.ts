import { describe, expect, it, vi } from "vitest";
import { RemoteNodeRuntime } from "./remoteNodeRuntime.js";
import { compactNodeServerSpec } from "./protocol.js";
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

/**
 * A node only ever receives `compactNodeServerSpec`, and it answers `server.update` by spreading that
 * spec back. Its reply therefore cannot carry anything outside the projection, so the panel has to
 * merge it onto the stored record rather than persist it whole.
 */
describe("remote node update replies", () => {
  const storedWithBookkeeping = () => managedServer({
    javaArgs: "-Xms2G -Xmx4G",
    dockerPorts: "25565:25565/tcp",
    startOnNodeStart: true,
    portConflictUnresolved: true,
    restartRequiredSince: "2026-02-01T00:00:00.000Z",
    crashAttemptTimestamps: ["2026-02-01T00:00:00.000Z"],
    schedules: [{
      id: "schedule-1", name: "Nightly restart", cron: "0 4 * * *",
      steps: [{ type: "action", procedure: "restart", delaySeconds: 0 }],
      onlyWhenNoPlayers: true, waitForPlayersToLeave: false, enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    }]
  });

  /** The reply a real node sends: the spec it was given, with the update applied, across JSON. */
  function nodeUpdateReply(stored: ManagedServer, overrides: Partial<ManagedServer>) {
    return JSON.parse(JSON.stringify({ ...compactNodeServerSpec(stored), ...overrides })) as unknown;
  }

  it("keeps the panel bookkeeping a node was never sent", async () => {
    const stored = storedWithBookkeeping();
    const { runtime, updated } = runtimeReturning(nodeUpdateReply(stored, {
      displayName: "Renamed",
      startOnNodeStart: true,
      updatedAt: "2026-02-02T00:00:00.000Z"
    }));

    const result = await runtime.updateServer(stored, { displayName: "Renamed" });

    expect(result.displayName).toBe("Renamed");
    expect(result.updatedAt).toBe("2026-02-02T00:00:00.000Z");
    // The reply has no createdAt because the node was never told one, and the store rejects a record
    // without it -- which is how renaming a server on a node failed with
    // "server.createdAt must be a non-empty string".
    expect(updated[0].createdAt).toBe(stored.createdAt);
    expect(updated[0].schedules).toEqual(stored.schedules);
    expect(updated[0].restartRequiredSince).toBe(stored.restartRequiredSince);
    expect(updated[0].crashAttemptTimestamps).toEqual(stored.crashAttemptTimestamps);
    expect(updated[0].portConflictUnresolved).toBe(true);
  });

  it("still takes every field a node owns, including one the update cleared", async () => {
    const stored = storedWithBookkeeping();
    const { runtime, updated } = runtimeReturning(nodeUpdateReply(stored, {
      dockerPorts: "25570:25570/tcp",
      javaArgs: undefined,
      startOnNodeStart: false,
      updatedAt: "2026-02-02T00:00:00.000Z"
    }));

    await runtime.updateServer(stored, { dockerPorts: "25570:25570/tcp", javaArgs: "" });

    expect(updated[0].dockerPorts).toBe("25570:25570/tcp");
    // Merging must not turn a cleared field back on: the projection names every field a node owns,
    // so an absent one overwrites the stored value instead of falling back to it.
    expect(updated[0].javaArgs).toBeUndefined();
    expect(updated[0].startOnNodeStart).toBe(false);
  });
});
