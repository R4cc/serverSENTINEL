import { describe, expect, it } from "vitest";
import type { ManagedNode } from "../types.js";
import {
  assertNodeSupports,
  nodeAdvertisesCapability,
  nodeCapabilities,
  nodeOperationContract,
  nodeProtocolVersion,
  normalizeNodeHello
} from "./protocol.js";

function v2Hello(overrides: Record<string, unknown> = {}) {
  return {
    type: "hello",
    nodeId: "node-1",
    nodeSecret: "secret",
    nodeName: "Remote Node",
    agentVersion: "0.8.0",
    buildId: "commit-sha",
    protocolVersion: nodeProtocolVersion,
    capabilities: [...nodeCapabilities],
    runtimeMode: "node",
    dataRoot: {
      root: "/data",
      dockerRoot: "/srv/serversentinel",
      status: "ready"
    },
    docker: {
      available: true,
      status: "available"
    },
    dockerStatus: "available",
    dataPathStatus: "ready",
    totalMemory: 1024,
    operations: nodeOperationContract,
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

describe("node protocol v2", () => {
  it("accepts a complete v2 hello for existing node sessions", () => {
    const hello = normalizeNodeHello(v2Hello());
    expect(hello.protocolVersion).toBe("2.0");
    expect(hello.buildId).toBe("commit-sha");
    expect(hello.runtimeMode).toBe("node");
    expect(hello.operations.server).toContain("server.create");
    expect(hello.dataRoot.dockerRoot).toBe("/srv/serversentinel");
  });

  it("accepts a complete v2 join-token hello before the panel assigns a node id", () => {
    const hello = normalizeNodeHello(v2Hello({ nodeId: null, nodeSecret: undefined, joinToken: "join-token" }));
    expect(hello.nodeId).toBeNull();
    expect(hello.joinToken).toBe("join-token");
  });

  it("rejects old protocol and incomplete node hello payloads clearly", () => {
    expect(() => normalizeNodeHello(v2Hello({ protocolVersion: "1.2" }))).toThrow("protocol 2.0 is required");
    expect(() => normalizeNodeHello({ type: "hello", protocolVersion: "2.0" })).toThrow("nodeName is required");
    expect(() => normalizeNodeHello(v2Hello({ capabilities: ["server.start", "legacy.thing"] }))).toThrow("unsupported capabilities");
  });

  it("centralizes capability and compatibility checks", () => {
    expect(() => assertNodeSupports(node(), "server.start")).not.toThrow();
    expect(() => assertNodeSupports(node({ protocolVersion: "1.2" }), "server.start")).toThrow("protocol 2.0 is required");
    expect(() => assertNodeSupports(node({ capabilities: ["server.start"] }), "files.list")).toThrow("does not advertise files.list");
    expect(nodeAdvertisesCapability(node(), "mods.liveMutation")).toBe(true);
    expect(nodeAdvertisesCapability(node({ capabilities: nodeCapabilities.filter((capability) => capability !== "mods.liveMutation") }), "mods.liveMutation")).toBe(false);
  });
});
