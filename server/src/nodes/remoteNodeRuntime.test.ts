import { describe, expect, it } from "vitest";
import type { Readable } from "node:stream";
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

function paperServer(): ManagedServer {
  const server = testServer();
  return {
    ...server,
    runtimeProfile: {
      ...server.runtimeProfile,
      runtimeType: "paper",
      runtimeVersion: "232",
      loader: undefined,
      loaderVersion: undefined,
      jarProvider: "papermc",
      jarArtifact: { filename: "paper.jar" }
    }
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

async function drain(stream: Readable) {
  for await (const _chunk of stream) {
    // Drain the stream so lazy archive entries open their remote transfers.
  }
}

describe("RemoteNodeRuntime command timeouts", () => {
  it("uses canonical managed-content commands for Paper and legacy mod commands for Fabric", async () => {
    const { runtime, calls } = runtimeWithRecorder({ mods: [] });

    await runtime.listMods(testServer());
    await runtime.listMods(paperServer());
    await runtime.toggleMod(paperServer(), "example.jar", false);

    expect(calls.map((call) => call.command)).toEqual(["mods.list", "content.list", "content.enableDisable"]);
    expect(runtime.isModsPath(paperServer(), "/plugins/example.jar")).toBe(true);
    expect(runtime.isModsPath(paperServer(), "/mods/example.jar")).toBe(false);
  });

  it("passes the selected console history limit to remote nodes", async () => {
    const node = testNode();
    const calls: Array<{ command: string; payload: unknown }> = [];
    const connections = {
      request: async (_node: ManagedNode, command: string, payload: unknown) => {
        calls.push({ command, payload });
        return { text: "", source: "logs/latest.log" };
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

    await runtime.serverLogs(testServer(), 5_000);

    expect(calls).toEqual([{
      command: "server.logs.recent",
      payload: expect.objectContaining({ limit: 5_000 })
    }]);
  });

  it("sends file moves to remote nodes with normalized source and destination paths", async () => {
    const node = testNode();
    const calls: Array<{ command: string; payload: unknown }> = [];
    const connections = {
      request: async (_node: ManagedNode, command: string, payload: unknown) => {
        calls.push({ command, payload });
        return { ok: true };
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

    await runtime.moveFile(testServer(), "/config/app.yml", "/archive");

    expect(calls).toEqual([{
      command: "files.move",
      payload: expect.objectContaining({ path: "config/app.yml", destinationPath: "archive" })
    }]);
  });

  it("reads the authoritative player observation from the remote node", async () => {
    const node = testNode();
    const observation = {
      state: "live" as const,
      instanceId: "container:started",
      online: 2,
      maxPlayers: 20,
      names: ["Alex", "Steve"],
      sampledAt: "2026-07-11T10:00:00.000Z"
    };
    const connections = {
      request: async (_node: ManagedNode, command: string) => {
        if (command === "server.players.read") return observation;
        return {};
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

    await expect(runtime.readPlayerObservation(testServer())).resolves.toEqual(observation);
  });

  it("keeps remote overview activity independent from player collection", async () => {
    const node = testNode();
    const connections = {
      request: async (_node: ManagedNode, command: string) => {
        if (command === "server.inspect") return { docker: { running: true, startedAt: "2026-07-15T10:00:00.000Z" } };
        if (command === "server.logs.recent") return { source: "logs/latest.log", text: "[12:00:00] [Server thread/INFO]: Alex joined the game" };
        if (command === "files.read") return { content: "max-players=20\nlevel-name=world" };
        return {};
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

    const overview = await runtime.serverOverview(testServer());

    expect(overview.activity).toMatchObject({ currentWorld: "world" });
    expect(overview.activity).not.toHaveProperty("playersOnline");
  });

  it("parses operational warnings and caught exceptions from remote logs", async () => {
    const node = testNode();
    const connections = {
      request: async (_node: ManagedNode, command: string) => {
        if (command === "server.inspect") return { docker: { running: true } };
        if (command === "server.logs.recent") return {
          source: "logs/latest.log",
          text: [
            "[12:00:00] [Server thread/WARN]: Can't keep up! Is the server overloaded? Running 2400ms or 48 ticks behind",
            "[12:00:01] [Server thread/ERROR]: Caught java.lang.IllegalStateException: tick task failed"
          ].join("\n")
        };
        if (command === "files.read") return { content: "level-name=world" };
        return {};
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

    const overview = await runtime.serverOverview(testServer());

    expect(overview.events.map((event) => event.eventType)).toEqual(["exception_caught", "server_overloaded"]);
    expect(overview.events[0].details).toContain("tick task failed");
  });

  it("sends a structured retryable event when console streaming finds the node offline", async () => {
    const node = testNode();
    const messages: string[] = [];
    const connections = { isConnected: () => false } as unknown as PanelNodeConnections;
    const runtime = new RemoteNodeRuntime(
      node.id,
      async () => node,
      connections,
      async (server) => server as never,
      async () => undefined,
      async () => undefined,
      async () => undefined
    );

    await runtime.streamConsole(testServer(), {
      readyState: 1,
      send: (message: string) => messages.push(message)
    }, () => undefined);

    expect(JSON.parse(messages[0])).toMatchObject({
      type: "unavailable",
      code: "NODE_OFFLINE",
      retryable: true
    });
  });

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
      { command: "mods.list", timeoutMs: 30_000 },
      { command: "mods.install", timeoutMs: 300_000 }
    ]);
  });

  it("uses existing remote file downloads when streaming archives", async () => {
    const server = testServer();
    const { runtime, calls } = runtimeWithRecorder({ filename: "a.txt", size: 1, contentBase64: Buffer.from("a").toString("base64") });

    const archive = await runtime.downloadArchive(server, [
      { sourcePath: "a.txt", archivePath: "a.txt", type: "file", size: 1 }
    ], "files.zip");
    await drain(archive.stream);

    expect(calls).toEqual([
      { command: "files.download", timeoutMs: 120_000 }
    ]);
  });
});
