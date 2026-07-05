import { describe, expect, it } from "vitest";
import type { ManagedNode, ManagedServer, ServerRuntimeProfile } from "../types.js";
import type { PanelNodeConnections } from "./panelConnections.js";
import { nodeCapabilities, nodeProtocolVersion } from "./protocol.js";
import { RemoteNodeRuntime } from "./remoteNodeRuntime.js";

function testRuntimeProfile(): ServerRuntimeProfile {
  return {
    minecraftVersion: "1.21.4",
    loader: "fabric",
    loaderVersion: "0.16.10",
    javaMajorVersion: 21,
    jarProvider: "mcjars",
    jarArtifact: {
      filename: "fabric-server-launch.jar",
      downloadUrl: "https://example.invalid/fabric-server-launch.jar"
    },
    compatibilityStatus: "compatible",
    resolvedAt: new Date().toISOString()
  };
}

function testNode(): ManagedNode {
  return {
    id: "node-1",
    name: "Remote Node",
    type: "remote",
    status: "online",
    isInternal: false,
    protocolVersion: nodeProtocolVersion,
    capabilities: [...nodeCapabilities],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function testServer(): ManagedServer {
  return {
    id: "server-1",
    nodeId: "node-1",
    displayName: "Survival",
    serverDir: "/srv/servers/server-1",
    storageName: "server-1",
    runtimeProfile: testRuntimeProfile(),
    dockerContainer: "serversentinel-server-1",
    dockerImage: "eclipse-temurin:21-jre",
    dockerPorts: "25565:25565/tcp,25566:25566/udp",
    javaArgs: "-Xms2G -Xmx4G",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function runtimeWithRecorder(result: unknown = { ok: true }) {
  const calls: Array<{ command: string; timeoutMs?: number }> = [];
  const node = testNode();
  const connections = {
    request: async (_node: ManagedNode, command: string, _payload: unknown, timeoutMs?: number) => {
      calls.push({ command, timeoutMs });
      return result;
    }
  } as unknown as PanelNodeConnections;
  const runtime = new RemoteNodeRuntime(
    node.id,
    async () => node,
    connections,
    async (server) => server as never,
    async () => undefined,
    async () => undefined,
    async () => undefined
  );
  return { runtime, calls };
}

describe("RemoteNodeRuntime command timeouts", () => {
  it("allows slow remote server provisioning commands to outlive the default request timeout", async () => {
    const server = testServer();
    const { runtime, calls } = runtimeWithRecorder(server);

    await runtime.createServer({ displayName: "Survival" });
    await runtime.updateServer(server, { runtime: { minecraftVersion: "1.21.5" } });

    expect(calls).toEqual([
      { command: "server.create", timeoutMs: 600_000 },
      { command: "server.update", timeoutMs: 600_000 }
    ]);
  });

  it("uses longer timeouts for remote transfers and Modrinth-backed commands", async () => {
    const server = testServer();
    const { runtime, calls } = runtimeWithRecorder({ filename: "mods.zip", size: 0, contentBase64: "" });

    await runtime.downloadFile(server, "mods.zip");
    await runtime.uploadFile(server, ".", "mods.zip", "");
    await runtime.uploadMod(server, "fabric-api.jar", "UEsDBA==");
    await runtime.listMods(server, { forceRefresh: true });
    await runtime.installMod(server, { projectId: "fabric-api" });

    expect(calls).toEqual([
      { command: "files.download", timeoutMs: 120_000 },
      { command: "files.upload", timeoutMs: 120_000 },
      { command: "mods.upload", timeoutMs: 120_000 },
      { command: "mods.list", timeoutMs: 300_000 },
      { command: "mods.install", timeoutMs: 300_000 }
    ]);
  });
});
