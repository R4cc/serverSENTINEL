import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { ManagedNode, ManagedServer, ServerRuntimeProfile } from "../types.js";
import type { PanelNodeConnections } from "./panelConnections.js";
import { nodeCapabilities, nodeFeatures, nodeProtocolVersion } from "./protocol.js";
import { parseLogEvent } from "../servers/logEvents.js";
import { RemoteNodeRuntime } from "./remoteNodeRuntime.js";

function testRuntimeProfile(): ServerRuntimeProfile {
  return {
    minecraftVersion: "1.21.4",
    runtimeType: "fabric",
    runtimeVersion: "0.16.10",
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

/** Stands in for the console buffer a node's forwarded output is written into. */
function testUpstream() {
  const written: string[] = [];
  const failures: Array<{ message: string; code?: string; retryable?: boolean }> = [];
  const ends: number[] = [];
  return {
    written,
    failures,
    ends,
    upstream: {
      write: (chunk: string) => { written.push(chunk); },
      notice: (message: string) => { written.push(`${message}\n`); },
      unavailable: (message: string, options?: { code?: string; retryable?: boolean }) => {
        failures.push({ message, ...options });
      },
      empty: () => {},
      ended: () => { ends.push(failures.length); }
    }
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
    // Server ids are UUIDs in practice (newServerId is randomUUID) and the panel validates that shape
    // on anything a node returns, so the fixture uses a realistic one.
    id: "33333333-3333-4333-8333-333333333333",
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
      jarProvider: "papermc",
      jarArtifact: { filename: "paper.jar" }
    }
  };
}

function runtimeWithRecorder(result: unknown = { ok: true }, nodeOverrides: Partial<ManagedNode> = {}) {
  const calls: Array<{ command: string; timeoutMs?: number; requireSize?: boolean }> = [];
  const node = { ...testNode(), ...nodeOverrides };
  const connections = {
    connectedNode: () => ({ ...node, features: [...nodeFeatures] }),
    request: async (_node: ManagedNode, command: string, _payload: unknown, timeoutMs?: number) => {
      calls.push({ command, timeoutMs });
      return result;
    },
    upload: async (_node: ManagedNode, command: string, _payload: unknown, _stream: Readable, _size: number, timeoutMs?: number) => {
      calls.push({ command, timeoutMs });
      return result;
    },
    download: async (_node: ManagedNode, command: string, _payload: unknown, _maxBytes: number, timeoutMs?: number, requireSize?: boolean) => {
      calls.push({ command, timeoutMs, requireSize });
      return result;
    },
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

describe("RemoteNodeRuntime export streaming", () => {
  it("uses the node-side export stream when the connected node advertises it", async () => {
    const result = { filename: "export.zip", stream: Readable.from([]) };
    const { runtime, calls } = runtimeWithRecorder(result);
    await expect(runtime.downloadExportArchive(testServer(), { servers: [] }, "export.zip", 4096)).resolves.toBe(result);
    expect(calls).toEqual([{ command: "exports.download", timeoutMs: 6 * 60 * 60 * 1000, requireSize: false }]);
  });

  it("falls back without starting a transfer when the node lacks the capability", async () => {
    const { runtime, calls } = runtimeWithRecorder(undefined, { capabilities: nodeCapabilities.filter((capability) => capability !== "exports.download") });
    await expect(runtime.downloadExportArchive(testServer(), { servers: [] }, "export.zip", 4096)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("falls back when the manifest cannot fit in a protocol control frame", async () => {
    const { runtime, calls } = runtimeWithRecorder();
    await expect(runtime.downloadExportArchive(testServer(), { padding: "x".repeat(8 * 1024 * 1024) }, "export.zip", 4096)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe("RemoteNodeRuntime storage", () => {
  it("queries storage on the node that hosts the server", async () => {
    const result = { totalBytes: 100 * 1024 ** 3, availableBytes: 8 * 1024 ** 3 };
    const { runtime, calls } = runtimeWithRecorder(result);

    await expect(runtime.serverStorage(testServer())).resolves.toEqual(result);
    expect(calls).toEqual([{ command: "server.storage", timeoutMs: 15_000 }]);
  });
});

describe("RemoteNodeRuntime payload projection", () => {
  function bookkeepingServer(): ManagedServer {
    return {
      ...testServer(),
      schedules: [{
        id: "schedule-1", name: "Nightly restart", cron: "0 4 * * *",
        steps: [{ type: "action", procedure: "restart", delaySeconds: 0 }],
        onlyWhenNoPlayers: true, waitForPlayersToLeave: false, enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        recentRuns: [{ id: "run-1", scheduleId: "schedule-1", scheduleName: "Nightly restart", status: "succeeded", ranAt: "2026-01-02T04:00:00.000Z" }]
      }],
      restartRequiredModBaseline: Array.from({ length: 40 }, (_, index) => ({
        identity: `mod-${index}`, displayName: `Mod ${index}`, filename: `mod-${index}.jar`, enabled: true, sha1: "a".repeat(40)
      })),
      crashAttemptTimestamps: ["2026-01-02T00:00:00.000Z", "2026-01-02T00:05:00.000Z"]
    } as ManagedServer;
  }

  function payloadRecorder() {
    const payloads: Array<Record<string, unknown>> = [];
    const node = testNode();
    const connections = {
      isConnected: () => true,
      connectedNode: () => ({ ...node, features: [...nodeFeatures] }),
      request: async (_node: ManagedNode, _command: string, payload: Record<string, unknown>) => {
        payloads.push(payload);
        return { ok: true };
      },
      stream: async (_node: ManagedNode, _command: string, payload: Record<string, unknown>) => {
        payloads.push(payload);
        return () => undefined;
      },
      upload: async (_node: ManagedNode, _command: string, payload: Record<string, unknown>, stream: Readable) => {
        payloads.push(payload);
        await drain(stream);
        return { ok: true };
      },
      download: async (_node: ManagedNode, _command: string, payload: Record<string, unknown>) => {
        payloads.push(payload);
        return { filename: "world.zip", size: 0, stream: Readable.from([]) };
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
    return { runtime, payloads };
  }

  it("sends only the fields a node reads, never panel bookkeeping", async () => {
    const { runtime, payloads } = payloadRecorder();

    await runtime.listFiles(bookkeepingServer(), "config");

    expect(payloads).toHaveLength(1);
    const sent = payloads[0].server as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual([
      "displayName", "dockerContainer", "dockerImage", "dockerMountSource", "dockerPorts", "dockerWorkingDir",
      "id", "javaArgs", "managedPorts", "nodeId", "runtimeProfile", "serverDir", "storageName"
    ]);
    expect(sent).not.toHaveProperty("schedules");
    expect(sent).not.toHaveProperty("restartRequiredModBaseline");
    expect(sent).not.toHaveProperty("crashAttemptTimestamps");
  });

  it("projects the server for streams and binary transfers too", async () => {
    const server = bookkeepingServer();
    const { runtime, payloads } = payloadRecorder();

    await runtime.streamConsole(server, testUpstream().upstream);
    await runtime.downloadFile(server, "world.zip");
    await runtime.uploadFile(server, "config", "ops.json", { stream: Readable.from([Buffer.from("[]")]), size: 2 });

    expect(payloads.length).toBeGreaterThanOrEqual(3);
    for (const payload of payloads) {
      expect(payload.server).not.toHaveProperty("schedules");
      expect(payload.server).not.toHaveProperty("restartRequiredModBaseline");
    }
  });
});

describe("RemoteNodeRuntime command timeouts", () => {
  it("keeps a confirmed start successful when only its delayed verification loses the node", async () => {
    vi.useFakeTimers();
    try {
      const node = testNode();
      const server = testServer();
      const connections = {
        request: async (_node: ManagedNode, command: string) => {
          if (command === "server.start") return { docker: { running: true } };
          throw Object.assign(new Error("Node disconnected"), { code: "node_offline" });
        }
      } as unknown as PanelNodeConnections;
      const runtime = new RemoteNodeRuntime(
        node.id,
        async () => node,
        connections,
        async (value) => value as never,
        async () => undefined,
        async () => undefined,
        async () => undefined
      );

      const started = runtime.lifecycle(server, "start");
      const result = expect(started).resolves.toEqual({ docker: { running: true } });
      await vi.advanceTimersByTimeAsync(1_500);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the live node's negotiated features for 17 MiB streamed mod uploads", async () => {
    const storedNode = testNode();
    const liveNode = { ...storedNode, features: [...nodeFeatures] };
    const uploaded: Array<{ command: string; size: number; content: Buffer }> = [];
    const connections = {
      connectedNode: (nodeId: string) => nodeId === liveNode.id ? liveNode : undefined,
      upload: async (_node: ManagedNode, command: string, _payload: unknown, stream: Readable, size: number) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        uploaded.push({ command, size, content: Buffer.concat(chunks) });
        return { ok: true };
      },
      request: async () => { throw new Error("streamed upload fell back to a control message"); }
    } as unknown as PanelNodeConnections;
    const runtime = new RemoteNodeRuntime(
      storedNode.id,
      async () => storedNode,
      connections,
      async (server) => server as never,
      async () => undefined,
      async () => undefined,
      async () => undefined
    );
    const content = Buffer.alloc(17 * 1024 * 1024);
    Buffer.from("PK\x03\x04").copy(content);

    await expect(runtime.uploadMod(testServer(), "fabric-api.jar", { stream: Readable.from([content]), size: content.byteLength })).resolves.toEqual({ ok: true });

    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]).toMatchObject({ command: "mods.upload", size: content.byteLength });
    expect(uploaded[0].content.equals(content)).toBe(true);
  });

  it("uses canonical managed-content commands for Paper and mod commands for Fabric", async () => {
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

  // The remote overview once carried its own log parser, so the events shown on the
  // overview disagreed with the ones the timeline collector persisted for the same
  // server. Both sides now share parseLogEvent; this pins them together.
  it("derives remote overview events with the same parser the timeline collector uses", async () => {
    const logLines = [
      "[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.4",
      "[12:00:05] [Server thread/INFO]: Done (5.123s)! For help, type \"help\"",
      "[12:00:10] [Server thread/INFO]: Steve joined the game",
      "[12:00:20] [Server thread/INFO]: Steve lost connection: Disconnected",
      "[12:00:30] [Server thread/WARN]: Can't keep up! Is the server overloaded? Running 2400ms behind",
      "[12:00:40] [Server thread/INFO]: Stopping server"
    ];
    const node = testNode();
    const connections = {
      request: async (_node: ManagedNode, command: string) => {
        if (command === "server.inspect") return { docker: { running: true } };
        if (command === "server.logs.recent") return { source: "logs/latest.log", text: logLines.join("\n") };
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
    const collectorEvents = logLines
      .map((line, index) => parseLogEvent(line, "logs/latest.log", index))
      .filter((event) => event !== null);

    expect(overview.events.map((event) => event.signature).sort())
      .toEqual(collectorEvents.map((event) => event.signature).sort());
    // "Starting minecraft server" is a starting line, not a started one; only the
    // "Done (...)" line may raise server_started.
    expect(overview.events.filter((event) => event.eventType === "server_started")).toHaveLength(1);
    // Time-only log stamps are canonicalized to an instant before crossing the API
    // boundary so clients in another zone do not reinterpret the wall clock.
    for (const event of overview.events) {
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("reports a structured retryable failure when console streaming finds the node offline", async () => {
    const node = testNode();
    const sink = testUpstream();
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

    await runtime.streamConsole(testServer(), sink.upstream);

    expect(sink.failures[0]).toMatchObject({
      message: expect.stringContaining("offline"),
      code: "NODE_OFFLINE",
      retryable: true
    });
    // Nothing was attached, so the console must not be held as live. Recording it is what left a
    // recovered node still reading as offline to every viewer that came afterwards.
    expect(sink.ends).toHaveLength(1);
  });

  it("reports the console as ended when the node stops sending", async () => {
    const node = testNode();
    const sink = testUpstream();
    let close: (error?: Error) => void = () => {};
    const connections = {
      isConnected: () => true,
      stream: async (
        _node: ManagedNode,
        _command: string,
        _payload: unknown,
        _onData: (event: unknown) => void,
        onClose?: (error?: Error) => void
      ) => {
        close = onClose ?? (() => {});
        return () => {};
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

    await runtime.streamConsole(testServer(), sink.upstream);
    expect(sink.ends).toHaveLength(0);
    close();

    expect(sink.ends).toHaveLength(1);
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
    const { runtime, calls } = runtimeWithRecorder({ filename: "mods.zip", size: 0, stream: Readable.from([]) });

    await runtime.downloadFile(server, "mods.zip");
    await runtime.uploadFile(server, ".", "mods.zip", { stream: Readable.from([]), size: 0 });
    await runtime.uploadMod(server, "fabric-api.jar", { stream: Readable.from([Buffer.from("PK\u0003\u0004")]), size: 4 });
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
    const { runtime, calls } = runtimeWithRecorder({ filename: "a.txt", size: 1, stream: Readable.from([Buffer.from("a")]) });

    const archive = await runtime.downloadArchive(server, [
      { sourcePath: "a.txt", archivePath: "a.txt", type: "file", size: 1 }
    ], "files.zip");
    await drain(archive.stream);

    expect(calls).toEqual([
      { command: "files.download", timeoutMs: 120_000 }
    ]);
  });
});
