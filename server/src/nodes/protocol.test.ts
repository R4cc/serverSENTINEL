import { describe, expect, it } from "vitest";
import type { ManagedNode } from "../types.js";
import {
  assertNodeSupports,
  nodeAdvertisesCapability,
  nodeCapabilities,
  nodeProtocolVersion,
  nodeUpgradeProtocolVersion,
  normalizeNodeHello
} from "./protocol.js";

function hello(overrides: Record<string, unknown> = {}) {
  return {
    type: "hello",
    nodeId: "node-1",
    nodeSecret: "secret",
    nodeName: "Remote Node",
    agentVersion: "1.4.0",
    buildId: "commit-sha",
    startupId: "startup-id",
    protocolVersion: nodeProtocolVersion,
    capabilities: [...nodeCapabilities],
    dockerStatus: "available",
    dataPathStatus: "ready",
    totalMemory: 1024,
    ...overrides
  };
}

function node(overrides: Partial<ManagedNode> = {}): ManagedNode {
  return {
    id: "node-1",
    name: "Remote Node",
    type: "remote",
    status: "online",
    isInternal: false,
    protocolVersion: nodeProtocolVersion,
    capabilities: [...nodeCapabilities],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("node protocol v3", () => {
  it("accepts complete v3 secret and join-token hellos", () => {
    expect(normalizeNodeHello(hello())).toMatchObject({ protocolVersion: "3.0", buildId: "commit-sha" });
    expect(normalizeNodeHello(hello({ nodeId: null, nodeSecret: undefined, joinToken: "join-token" }))).toMatchObject({
      nodeId: null,
      joinToken: "join-token"
    });
  });

  it("accepts the current v2 node only as a self-update bridge", () => {
    const capabilities = [...nodeCapabilities.filter((capability) => capability !== "server.players.read"), "server.queryMetrics"];
    const legacy = normalizeNodeHello(hello({
      protocolVersion: nodeUpgradeProtocolVersion,
      agentVersion: "1.4.0",
      capabilities
    }));
    expect(legacy.protocolVersion).toBe("2.0");

    const legacyNode = node({ protocolVersion: "2.0", capabilities });
    expect(() => assertNodeSupports(legacyNode, "node.update")).not.toThrow();
    expect(() => assertNodeSupports(legacyNode, "server.start")).toThrow("protocol 3.0 is required");
    expect(nodeAdvertisesCapability(legacyNode, "node.update")).toBe(true);
    expect(nodeAdvertisesCapability(legacyNode, "server.start")).toBe(false);
  });

  it("rejects older protocols, incomplete hellos, and unsupported capabilities", () => {
    expect(() => normalizeNodeHello(hello({ protocolVersion: "1.2" }))).toThrow("protocol 3.0 is required");
    expect(() => normalizeNodeHello({ type: "hello", protocolVersion: "3.0" })).toThrow("nodeName is required");
    expect(() => normalizeNodeHello(hello({ capabilities: ["server.start", "legacy.thing"] }))).toThrow("unsupported capabilities");
    expect(() => normalizeNodeHello(hello({ protocolVersion: "2.0", capabilities: ["server.start"] }))).toThrow("must advertise node.update");
  });

  it("centralizes full capability checks for v3 nodes", () => {
    expect(() => assertNodeSupports(node(), "server.start")).not.toThrow();
    expect(() => assertNodeSupports(node({ capabilities: ["server.start"] }), "files.list")).toThrow("does not advertise files.list");
    expect(nodeAdvertisesCapability(node(), "server.players.read")).toBe(true);
  });
});
