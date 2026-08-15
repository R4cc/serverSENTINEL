import { describe, expect, it } from "vitest";
import type { ManagedNode } from "../types.js";
import {
  assertNodeSupports,
  nodeAdvertisesCapability,
  nodeCapabilities,
  nodeFeatures,
  nodeProtocolVersion,
  normalizeNodeHello,
  normalizeNodeToPanelMessage,
  normalizePanelToNodeMessage,
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
    agentVersion: "1.5.2",
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

  it("carries a reported update failure and drops an unusable one without losing the session", () => {
    const failure = {
      at: "2026-08-14T10:00:00.000Z",
      stage: "start",
      message: "The replacement container could not start",
      image: "nl2109/serversentinel:26.8.13",
      recovered: true,
      containerName: "serversentinel-node"
    };

    expect(normalizeNodeHello(hello({ updateFailure: failure })).updateFailure).toEqual(failure);
    expect(normalizeNodeHello(hello({ updateFailure: { ...failure, stage: "invented" } })).updateFailure).toBeUndefined();
    expect(normalizeNodeHello(hello({ updateFailure: { stage: "start" } })).updateFailure).toBeUndefined();
    expect(normalizeNodeHello(hello({ updateFailure: "broken" })).updateFailure).toBeUndefined();
    expect(normalizeNodeHello(hello()).updateFailure).toBeUndefined();
  });

  it("rejects non-current protocols, incomplete hellos, capabilities, and features", () => {
    expect(() => normalizeNodeHello(hello({ protocolVersion: "3.0" }))).toThrow("protocol 3.1 is required");
    expect(() => normalizeNodeHello(hello({ protocolVersion: "2.0" }))).toThrow("protocol 3.1 is required");
    expect(() => normalizeNodeHello({ type: "hello", protocolVersion: "3.1" })).toThrow("capabilities must be an array");
    expect(normalizeNodeHello(hello({ capabilities: ["server.start", "future.safe.command"] })).capabilities).toEqual(["server.start"]);
    expect(() => normalizeNodeHello(hello({ features: ["binary-transfer"] }))).toThrow("missing required protocol features");
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

  it("accepts the capability-gated streamed export download", () => {
    expect(nodeCapabilities).toContain("exports.download");
    expect(normalizePanelToNodeMessage({
      type: "transferStart",
      id: "00112233-4455-4677-8899-aabbccddeeff",
      direction: "download",
      command: "exports.download",
      payload: {},
      maxBytes: 1024
    })).toMatchObject({ command: "exports.download", direction: "download", maxBytes: 1024 });
  });

  it("rejects malformed stream and observation messages", () => {
    expect(() => normalizeNodeToPanelMessage({ type: "streamData", id: "stream-1", event: { type: "progress", progress: 101, task: "bad" } })).toThrow("between 0 and 100");
    expect(() => normalizeNodeToPanelMessage({ type: "streamData", id: "stream-1", event: { type: "unknown" } })).toThrow("Unsupported stream event");
  });
});
