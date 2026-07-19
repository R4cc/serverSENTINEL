import { describe, expect, it } from "vitest";
import type { ManagedNode } from "../types.js";
import {
  assertNodeSupports,
  nodeAdvertisesCapability,
  nodeCapabilities,
  nodeFallbackProtocolVersion,
  nodeFeatures,
  nodeProtocolMode,
  nodeProtocolVersion,
  nodeUpgradeProtocolVersion,
  normalizeNodeHello,
  normalizeNodeToPanelMessage,
  normalizePanelWelcome,
  encodeTransferChunk,
  decodeTransferChunk
} from "./protocol.js";

function hello(overrides: Record<string, unknown> = {}) {
  return {
    type: "hello",
    nodeId: "node-1",
    nodeSecret: "secret",
    nodeName: "Remote Node",
    agentVersion: "1.5.1",
    buildId: "commit-sha",
    startupId: "startup-id",
    protocolVersion: nodeProtocolVersion,
    capabilities: [...nodeCapabilities],
    features: [...nodeFeatures],
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

describe("node protocol v3.1", () => {
  it("accepts complete v3.1 secret and join-token hellos", () => {
    expect(normalizeNodeHello(hello())).toMatchObject({ protocolVersion: "3.1", buildId: "commit-sha", features: [...nodeFeatures] });
    expect(normalizeNodeHello(hello({ nodeId: null, nodeSecret: undefined, joinToken: "join-token" }))).toMatchObject({
      nodeId: null,
      joinToken: "join-token"
    });
  });

  it("accepts the current v2 node only as a self-update bridge", () => {
    const capabilities = [...nodeCapabilities.filter((capability) => capability !== "server.players.read" && capability !== "server.observe"), "server.queryMetrics"];
    const legacy = normalizeNodeHello(hello({
      protocolVersion: nodeUpgradeProtocolVersion,
      agentVersion: "1.5.0",
      capabilities
    }));
    expect(legacy.protocolVersion).toBe("2.0");

    const legacyNode = node({ protocolVersion: "2.0", capabilities });
    expect(() => assertNodeSupports(legacyNode, "node.update")).not.toThrow();
    expect(() => assertNodeSupports(legacyNode, "server.start")).toThrow("protocol 3.1 or 3.0 is required");
    expect(nodeAdvertisesCapability(legacyNode, "node.update")).toBe(true);
    expect(nodeAdvertisesCapability(legacyNode, "server.start")).toBe(false);
  });

  it("rejects older protocols, incomplete hellos, and unsupported capabilities", () => {
    expect(() => normalizeNodeHello(hello({ protocolVersion: "1.2" }))).toThrow("protocol 3.1 or 3.0 is required");
    expect(() => normalizeNodeHello({ type: "hello", protocolVersion: "3.1" })).toThrow("capabilities must be an array");
    expect(() => normalizeNodeHello(hello({ capabilities: ["server.start", "legacy.thing"] }))).toThrow("unsupported capabilities");
    expect(() => normalizeNodeHello(hello({ protocolVersion: "2.0", capabilities: ["server.start"] }))).toThrow("must advertise node.update");
  });

  it("keeps protocol 3.0 operational without 3.1 transport features", () => {
    const capabilities = [...nodeCapabilities.filter((capability) => capability !== "server.observe"), "node.health", "docker.info"];
    const fallback = normalizeNodeHello(hello({ protocolVersion: nodeFallbackProtocolVersion, capabilities, features: undefined }));
    expect(fallback.features).toEqual([]);
    expect(nodeProtocolMode(fallback.protocolVersion)).toBe("fallback");
    expect(() => assertNodeSupports(node({ protocolVersion: nodeFallbackProtocolVersion, capabilities }), "server.start")).not.toThrow();
  });

  it("centralizes full capability checks for v3 nodes", () => {
    expect(() => assertNodeSupports(node(), "server.start")).not.toThrow();
    expect(() => assertNodeSupports(node({ capabilities: ["server.start"] }), "files.list")).toThrow("does not advertise files.list");
    expect(nodeAdvertisesCapability(node(), "server.players.read")).toBe(true);
  });

  it("negotiates only known 3.1 transport features", () => {
    expect(normalizePanelWelcome({ type: "welcome", nodeId: "node-1", accepted: true, protocolVersion: "3.1", features: ["binary-transfer"] })).toMatchObject({
      protocolVersion: "3.1",
      features: ["binary-transfer"]
    });
    expect(() => normalizePanelWelcome({ type: "welcome", nodeId: "node-1", accepted: true, features: ["future-feature"] })).toThrow("unsupported features");
  });

  it("encodes bounded binary chunks with raw UUID transfer ids", () => {
    const id = "00112233-4455-6677-8899-aabbccddeeff";
    const encoded = encodeTransferChunk(id, Buffer.from("hello"));
    expect(encoded[0]).toBe(0x01);
    expect(encoded.byteLength).toBe(22);
    expect(decodeTransferChunk(encoded)).toEqual({ id, payload: Buffer.from("hello") });
    expect(() => encodeTransferChunk(id, Buffer.alloc(256 * 1024 + 1))).toThrow("256 KiB");
  });

  it("rejects malformed stream and observation messages", () => {
    expect(() => normalizeNodeToPanelMessage({ type: "streamData", id: "stream-1", event: { type: "progress", progress: 101, task: "bad" } })).toThrow("between 0 and 100");
    expect(() => normalizeNodeToPanelMessage({ type: "streamData", id: "stream-1", event: { type: "unknown" } })).toThrow("Unsupported stream event");
  });
});
