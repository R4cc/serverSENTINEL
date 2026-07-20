import { describe, expect, it } from "vitest";
import type { ManagedNode, NodeOperation } from "../types";
import { advanceNodeOperation, isNodeRuntimeUsable, nodeBlockReason, nodeRestartImpactMessage, nodeWarnings } from "./nodes";

const graceMs = 5 * 60 * 1000;

function node(overrides: Partial<ManagedNode> = {}): ManagedNode {
  return {
    id: "node-1",
    name: "Node 1",
    type: "remote",
    status: "online",
    isInternal: false,
    connectedAt: "before",
    agentVersion: "1.1.0",
    buildId: "old-build",
    ...overrides
  };
}

function operation(overrides: Partial<NodeOperation> = {}): NodeOperation {
  return {
    kind: "update",
    phase: "waiting",
    startedAt: 1_000,
    startedConnectedAt: "before",
    targetVersion: "1.2.0",
    targetBuildId: "new-build",
    ...overrides
  };
}

describe("advanceNodeOperation", () => {
  it("keeps an update active while the original connection is still online", () => {
    expect(advanceNodeOperation(operation(), node(), 2_000, graceMs)).toEqual({
      operation: operation(),
      outcome: "pending"
    });
  });

  it("records the expected offline phase without completing", () => {
    expect(advanceNodeOperation(operation(), node({ status: "offline" }), 5_000, graceMs)).toEqual({
      operation: { ...operation(), observedOffline: true },
      outcome: "pending"
    });
  });

  it("completes when an updated node reconnects with the requested target", () => {
    expect(advanceNodeOperation(
      operation({ observedOffline: true }),
      node({ connectedAt: "after", agentVersion: "1.2.0", buildId: "new-build" }),
      10_000,
      graceMs
    )).toEqual({ outcome: "completed" });
  });

  it("keeps waiting when the first report after reconnect still has the old target", () => {
    expect(advanceNodeOperation(
      operation({ observedOffline: true }),
      node({ connectedAt: "after" }),
      10_000,
      graceMs
    )).toEqual({
      operation: { ...operation({ observedOffline: true }), reconnectedAt: 10_000 },
      outcome: "pending"
    });
  });

  it("completes when the refreshed target arrives during reconnect reconciliation", () => {
    expect(advanceNodeOperation(
      operation({ observedOffline: true, reconnectedAt: 10_000 }),
      node({ connectedAt: "after", agentVersion: "1.2.0", buildId: "new-build" }),
      15_000,
      graceMs
    )).toEqual({ outcome: "completed" });
  });

  it("reports a mismatch when the old target remains after reconnect reconciliation", () => {
    expect(advanceNodeOperation(
      operation({ observedOffline: true, reconnectedAt: 10_000 }),
      node({ connectedAt: "after" }),
      25_000,
      graceMs
    )).toEqual({ outcome: "mismatch" });
  });

  it("completes restart operations after reconnecting", () => {
    expect(advanceNodeOperation(
      operation({ kind: "restart", targetVersion: undefined, targetBuildId: undefined, observedOffline: true }),
      node({ connectedAt: "after" }),
      10_000,
      graceMs
    )).toEqual({ outcome: "completed" });
  });

  it("moves an overdue operation to the stable timed-out phase", () => {
    expect(advanceNodeOperation(operation({ observedOffline: true }), node({ status: "offline" }), 1_000 + graceMs, graceMs)).toEqual({
      operation: { ...operation(), observedOffline: true, phase: "timed-out" },
      outcome: "pending"
    });
  });
});

describe("nodeRestartImpactMessage", () => {
  it("explains that remote-node servers remain available during reconnect", () => {
    const message = nodeRestartImpactMessage(node());

    expect(message).toContain("not restarted");
    expect(message).toContain("stay online and reachable");
    expect(message).toContain("status and controls in the Panel will be temporarily unavailable");
  });

  it("explains the temporary Panel outage for the internal node", () => {
    const message = nodeRestartImpactMessage(node({ type: "local", isInternal: true }));

    expect(message).toContain("stay online and reachable");
    expect(message).toContain("Panel and its controls will be temporarily unavailable");
  });
});

describe("node protocol modes", () => {
  it("keeps protocol 3.0 fallback nodes usable while recommending an update", () => {
    const fallback = node({ protocolVersion: "3.0", protocolMode: "fallback", dockerStatus: "available" });
    expect(isNodeRuntimeUsable(fallback)).toBe(true);
    expect(nodeBlockReason(fallback)).toBe("");
    expect(nodeWarnings(fallback)).toContain("This node is using protocol 3.0 fallback. Update it to enable optimized monitoring and transfers.");
  });

  it("blocks update-only protocol 2.0 nodes from server management", () => {
    const updateOnly = node({ protocolVersion: "2.0", protocolMode: "update-only", dockerStatus: "available" });
    expect(isNodeRuntimeUsable(updateOnly)).toBe(false);
    expect(nodeBlockReason(updateOnly)).toBe("Node update required");
  });
});
