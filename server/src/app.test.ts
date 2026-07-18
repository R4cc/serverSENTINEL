import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import {
  compactRecentEvents,
  parseLogEvent,
  requireStrictBoolean,
  validateDockerContainerName,
  validateJavaArgs,
  validateModrinthProjectId,
  nodeInstallInstructions,
  cleanupNodeServerContainers,
  parseCookies,
  validateRuntimeJarFilename,
  dockerHostPortBindings,
  findExistingServerPortConflict,
  normalizeCreateServerPorts,
  allocateQueryPort,
  sessionExpired,
  sessionMaxAgeSeconds,
  validateJoinTokenTtlMinutes,
  fileContentRevision,
  assertFileRevision,
  validateBase64Content,
  mutableServerConfigurationBlockedReason,
  nodeUpdateImageForBuild,
  nodeUpdateAlreadyCurrent,
  modrinthSearchFacets,
  assertSameOriginRequest,
  localFilePathInput,
  publicServerStatus,
  publicInstalledModsResult,
  assertDownloadSize,
  fileDownloadIntentMode,
  dedupeDownloadSelections,
  sanitizeScheduleSteps,
  waitForCommandDelay,
  dockerNetworkingConfigFromInspect,
  minecraftContainerNetworkingConfig,
  nodeWithLiveConnectionStatus,
  isMinecraftStopCommand,
  defaultInternalNode,
  startConsoleHeartbeat,
  detectVersionsFromLogText
} from "./app.js";
import { nodeCapabilities, nodeProtocolVersion } from "./nodes/protocol.js";
import { createZipArchiveStream, safeArchivePath } from "./downloadArchive.js";
import { optionalCompatibilityFilter, optionalNodeDataMount, optionalNodePanelUrl, optionalReleaseChannel } from "./http/validation.js";
import { parseMinecraftQueryChallenge, parseMinecraftQueryResponse } from "./minecraftQuery.js";
import type { ManagedNode, ManagedServer, ServerEvent } from "./types.js";

describe("live node connectivity", () => {
  const remoteNode: ManagedNode = {
    id: "remote-node",
    name: "Remote Node",
    type: "remote",
    status: "online",
    isInternal: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };

  it("overrides stale persisted online state when no socket is connected", () => {
    expect(nodeWithLiveConnectionStatus(remoteNode, false).status).toBe("offline");
  });

  it("restores online state from an authoritative live socket", () => {
    expect(nodeWithLiveConnectionStatus({ ...remoteNode, status: "offline" }, true).status).toBe("online");
  });
});

describe("local runtime metadata", () => {
  it("advertises the current protocol and capabilities for the internal node", () => {
    expect(defaultInternalNode("2026-07-18T00:00:00.000Z")).toMatchObject({
      protocolVersion: nodeProtocolVersion,
      capabilities: [...nodeCapabilities]
    });
  });
});

describe("runtime version detection", () => {
  it("keeps Fabric detection compatible and selects Paper log patterns by runtime", () => {
    expect(detectVersionsFromLogText("Loading Fabric Loader 0.16.10", "fabric")).toMatchObject({
      runtimeType: "fabric",
      runtimeVersion: "0.16.10",
      fabricLoaderVersion: "0.16.10"
    });
    expect(detectVersionsFromLogText("This server is running Paper version 1.21.4-232", "paper")).toEqual({
      minecraftVersion: undefined,
      runtimeType: "paper",
      runtimeVersion: "232"
    });
    expect(detectVersionsFromLogText("Starting Paper version git-Paper-418", "paper")).toEqual({
      minecraftVersion: undefined,
      runtimeType: "paper",
      runtimeVersion: "418"
    });
  });
});

describe("console stream heartbeat", () => {
  it("keeps idle browser streams active and stops cleanly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T00:00:00.000Z"));
    try {
      const messages: string[] = [];
      const stop = startConsoleHeartbeat({ readyState: 1, send: (message) => messages.push(message) }, 1_000);

      vi.advanceTimersByTime(2_000);
      expect(messages.map((message) => JSON.parse(message))).toEqual([
        { type: "heartbeat", at: "2026-07-18T00:00:01.000Z" },
        { type: "heartbeat", at: "2026-07-18T00:00:02.000Z" }
      ]);

      stop();
      vi.advanceTimersByTime(1_000);
      expect(messages).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Minecraft stop command intent", () => {
  it("matches only exact stop commands", () => {
    expect(isMinecraftStopCommand("stop")).toBe(true);
    expect(isMinecraftStopCommand(" /STOP ")).toBe(true);
    expect(isMinecraftStopCommand("say stop")).toBe(false);
    expect(isMinecraftStopCommand("stop now")).toBe(false);
  });
});

function testRuntimeProfile() {
  return {
    minecraftVersion: "1.21.4",
    loader: "fabric" as const,
    loaderVersion: "0.16.10",
    javaMajorVersion: 21 as const,
    jarProvider: "mcjars" as const,
    jarArtifact: {
      filename: "fabric-server-launch.jar",
      downloadUrl: "https://example.invalid/fabric-server-launch.jar"
    },
    compatibilityStatus: "compatible" as const,
    resolvedAt: new Date().toISOString()
  };
}

describe("schedule steps", () => {
  it("accepts canonical command steps", () => {
    expect(sanitizeScheduleSteps([
      { type: "command", command: "say warning", delaySeconds: 0 },
      { type: "command", command: "save-all", delaySeconds: 30 }
    ])).toEqual([
      { type: "command", command: "say warning", delaySeconds: 0 },
      { type: "command", command: "save-all", delaySeconds: 30 }
    ]);
  });

  it("accepts one final Restart action and rejects unsafe action layouts", () => {
    expect(sanitizeScheduleSteps([
      { type: "command", command: "say restarting", delaySeconds: 0 },
      { type: "action", procedure: "restart", delaySeconds: 300 }
    ])).toHaveLength(2);
    expect(() => sanitizeScheduleSteps([
      { type: "action", procedure: "restart", delaySeconds: 0 },
      { type: "command", command: "say online", delaySeconds: 0 }
    ])).toThrow(/final schedule step/);
    expect(() => sanitizeScheduleSteps([{ type: "action", procedure: "reload", delaySeconds: 0 }])).toThrow(/Unsupported/);
  });

  it("requires steps and rejects invalid delays", () => {
    expect(() => sanitizeScheduleSteps(undefined)).toThrow(/schedule step/);
    expect(() => sanitizeScheduleSteps([{ type: "command", command: "save-all", delaySeconds: 1.5 }])).toThrow(/whole number of seconds/);
    expect(() => sanitizeScheduleSteps([{ type: "command", command: "save-all", delaySeconds: 604_801 }])).toThrow(/whole number of seconds/);
  });

  it("can interrupt a pending schedule delay", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const delay = waitForCommandDelay(5, controller.signal);

      controller.abort();

      await expect(delay).rejects.toThrow("Schedule run cancelled by user");
    } finally {
      vi.useRealTimers();
    }
  });
});

async function streamToBuffer(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}


describe("node update image selection", () => {
  it("uses immutable build tags for default node image updates", () => {
    expect(nodeUpdateImageForBuild(undefined, "abc123def456")).toBe("nl2109/serversentinel:abc123def456");
  });

  it("falls back to the app version when no build id is available", () => {
    expect(nodeUpdateImageForBuild(undefined, undefined, "1.2.0")).toBe("nl2109/serversentinel:1.2.0");
  });

  it("preserves configured custom node images", () => {
    expect(nodeUpdateImageForBuild("registry.example/serversentinel:stable", "abc123def456")).toBe("registry.example/serversentinel:stable");
  });
});

describe("Modrinth search facets", () => {
  it("filters compatible searches at the upstream API including patch wildcards", () => {
    expect(modrinthSearchFacets("fabric", "1.21.4", "compatible")).toEqual([
      ["project_type:mod"],
      ["categories:fabric"],
      ["versions:1.21.4", "versions:1.21.x"],
      ["server_side:required", "server_side:optional"]
    ]);
  });

  it("keeps all-result searches limited only to mods", () => {
    expect(modrinthSearchFacets("fabric", "1.21.4", "all")).toEqual([["project_type:mod"]]);
  });

  it("searches the Paper-compatible plugin ecosystem as one loader facet", () => {
    expect(modrinthSearchFacets(["paper", "bukkit", "spigot"], "1.21.4", "compatible", "plugin")).toEqual([
      ["project_type:plugin"],
      ["categories:paper", "categories:bukkit", "categories:spigot"],
      ["versions:1.21.4", "versions:1.21.x"],
      ["server_side:required", "server_side:optional"]
    ]);
  });

  it("treats the matching version and immutable build as already current", () => {
    expect(nodeUpdateAlreadyCurrent({ agentVersion: "1.0.3", buildId: "abc123" }, undefined, "1.0.3", "abc123")).toBe(true);
    expect(nodeUpdateAlreadyCurrent({ agentVersion: "1.0.3", buildId: "old" }, undefined, "1.0.3", "abc123")).toBe(false);
  });

  it("allows an explicit custom image even when build metadata matches", () => {
    expect(nodeUpdateAlreadyCurrent({ agentVersion: "1.0.3", buildId: "abc123" }, "registry.example/custom:next", "1.0.3", "abc123")).toBe(false);
  });

  it("executes delays using second precision", async () => {
    vi.useFakeTimers();
    try {
      const delay = waitForCommandDelay(2);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(delay).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CSRF origin checks", () => {
  function request(headers: Record<string, unknown>, protocol = "http") {
    return { headers, protocol } as any;
  }

  it("uses the public forwarded host and protocol when behind a reverse proxy", () => {
    expect(() => assertSameOriginRequest(request({
      origin: "https://panel.example.com",
      host: "127.0.0.1:8080",
      "x-forwarded-host": "panel.example.com, 127.0.0.1:8080",
      "x-forwarded-proto": "https,http"
    }), true)).not.toThrow();
  });

  it("supports Cloudflare Tunnel terminating HTTPS while connecting to the container over plain HTTP", () => {
    expect(() => assertSameOriginRequest(request({
      origin: "https://panel.example.com",
      host: "serversentinel:8085",
      "x-forwarded-host": "panel.example.com",
      "x-forwarded-proto": "https"
    }), true)).not.toThrow();
  });

  it("accepts a host-preserving HTTPS tunnel without enabling proxy trust", () => {
    expect(() => assertSameOriginRequest(request({
      origin: "https://panel.example.com",
      host: "panel.example.com",
      "x-forwarded-host": "spoofed.example.com",
      "x-forwarded-proto": "javascript"
    }), false, true)).not.toThrow();
  });

  it("rejects malformed or cross-origin proxy metadata", () => {
    expect(() => assertSameOriginRequest(request({
      origin: "https://evil.example.com",
      host: "127.0.0.1:8080",
      "x-forwarded-host": "panel.example.com",
      "x-forwarded-proto": "https"
    }), true)).toThrow("cross-origin");
    expect(() => assertSameOriginRequest(request({
      origin: "https://panel.example.com",
      host: "panel.example.com",
      "x-forwarded-proto": "javascript"
    }), true)).toThrow("invalid request protocol");
  });

  it("ignores spoofed forwarded headers unless proxy trust is explicitly enabled", () => {
    expect(() => assertSameOriginRequest(request({
      origin: "https://panel.example.com",
      host: "127.0.0.1:8080",
      "x-forwarded-host": "panel.example.com",
      "x-forwarded-proto": "https"
    }), false)).toThrow("cross-origin");
  });

  it("requires an Origin header for browser WebSocket upgrades", () => {
    expect(() => assertSameOriginRequest(request({ host: "panel.example.com" }), false, true)).toThrow("missing request origin");
  });
});

describe("file revisions", () => {
  it("detects content changes before saving", () => {
    const acquired = fileContentRevision("original");
    expect(() => assertFileRevision(acquired, acquired, fileContentRevision("changed")))
      .toThrow("The file changed after editing began");
    expect(() => assertFileRevision(acquired, acquired, acquired)).not.toThrow();
  });
});

describe("base64 upload validation", () => {
  it("rejects malformed upload payloads before permissive Buffer decoding can alter them", () => {
    expect(() => validateBase64Content("not base64!!!", true)).toThrow("valid base64");
    expect(() => validateBase64Content("abcd=", true)).toThrow("valid base64");
    expect(validateBase64Content("", true)).toBe("");
    expect(validateBase64Content(Buffer.from("hello").toString("base64"), true)).toBe("aGVsbG8=");
  });
});

describe("file download planning", () => {
  it("uses individual downloads for small selected files", () => {
    expect(fileDownloadIntentMode({ hasDirectory: false, fileCount: 2, totalSize: 1024 })).toBe("individual");
    expect(fileDownloadIntentMode({ hasDirectory: false, fileCount: 1, totalSize: 128 * 1024 * 1024 })).toBe("individual");
  });

  it("uses archives for folders, many files, or large selected files", () => {
    expect(fileDownloadIntentMode({ hasDirectory: true, fileCount: 0, totalSize: 0 })).toBe("archive");
    expect(fileDownloadIntentMode({ hasDirectory: false, fileCount: 10, totalSize: 10 })).toBe("archive");
    expect(fileDownloadIntentMode({ hasDirectory: false, fileCount: 2, totalSize: 128 * 1024 * 1024 })).toBe("archive");
  });

  it("rejects downloads above the configured hard cap", () => {
    expect(() => assertDownloadSize(512 * 1024 * 1024 + 1)).toThrow("Download is larger");
  });

  it("deduplicates child paths when their parent folder is selected", () => {
    const selections = dedupeDownloadSelections([
      { name: "a.txt", path: "/world/a.txt", target: "world/a.txt", type: "file", size: 1 },
      { name: "world", path: "/world", target: "world", type: "directory", size: 0 },
      { name: "server.properties", path: "/server.properties", target: "server.properties", type: "file", size: 1 }
    ]);

    expect(selections.map((entry) => entry.path)).toEqual(["/server.properties", "/world"]);
  });
});

describe("file download archives", () => {
  it("creates zip entries from lazy streams and validates archive paths", async () => {
    expect(safeArchivePath("world/level.dat")).toBe("world/level.dat");
    expect(() => safeArchivePath("../level.dat")).toThrow("normalized");

    const stream = createZipArchiveStream([
      { sourcePath: "level.dat", archivePath: "world/level.dat", type: "file", size: 5 }
    ], async () => Readable.from(Buffer.from("hello")));
    const archive = await streamToBuffer(stream);

    expect(archive.includes(Buffer.from("world/level.dat"))).toBe(true);
    expect(archive.includes(Buffer.from("hello"))).toBe(true);
  });
});

describe("local file path input", () => {
  const server = {
    serverDir: process.platform === "win32"
      ? "C:\\serversentinel\\servers\\server-id"
      : "/data/servers/server-id"
  } as ManagedServer;

  it("maps public root and child paths to server-relative filesystem paths", () => {
    expect(localFilePathInput(server, "/")).toBe(".");
    expect(localFilePathInput(server, "/mods")).toBe("mods");
    expect(localFilePathInput(server, "server.properties")).toBe("server.properties");
  });

  it("preserves absolute filesystem paths that are already inside the server root", () => {
    const absolute = resolve(server.serverDir, "mods");
    expect(localFilePathInput(server, absolute)).toBe(resolve(absolute));
  });

  it("rejects unsafe public paths", () => {
    expect(() => localFilePathInput(server, "/../etc/passwd")).toThrow("normalized");
    expect(() => localFilePathInput(server, "/mods\\bad.jar")).toThrow("invalid characters");
  });
});

describe("public server status DTO", () => {
  it("keeps status polling payloads to browser-needed fields", () => {
    const status = publicServerStatus({
      server: {
        id: "server-1",
        serverDir: "/srv/private/server-1",
        dockerMountSource: "/srv/private/server-1",
        resolvedVersions: {
          minecraftVersion: { version: "1.21.4", source: "detected", lastCheckedAt: "now" }
        }
      },
      docker: {
        configured: true,
        available: true,
        controllable: true,
        running: true,
        state: "running",
        container: "serversentinel-server-1",
        name: "/serversentinel-server-1",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "0001-01-01T00:00:00Z",
        message: ""
      },
      fileLogsAvailable: true,
      controlAvailable: true,
      commandInputAvailable: true,
      commandInputMessage: "ready",
      backendOnly: "hidden"
    }, { id: "server-1" });

    expect(status).toEqual({
      server: { id: "server-1" },
      docker: {
        configured: true,
        available: true,
        controllable: true,
        state: "running",
        running: true,
        container: "serversentinel-server-1",
        message: undefined
      },
      fileLogsAvailable: true,
      controlAvailable: true,
      commandInputAvailable: true,
      commandInputMessage: "ready",
      lifecycle: {
        intent: "running",
        state: "running",
        recoveryAttempt: undefined,
        recoveryLimit: undefined,
        nextRetryAt: undefined,
        crashLoopSince: undefined,
        message: undefined
      }
    });
    expect(JSON.stringify(status)).not.toContain("/srv/private");
    expect(JSON.stringify(status)).not.toContain("startedAt");
    expect(JSON.stringify(status)).not.toContain("backendOnly");
  });
});

describe("public installed mods DTO", () => {
  it("removes Modrinth hashes and download URLs from browser mod lists", () => {
    const result = publicInstalledModsResult({
      mods: [{
        filename: "fabric-api.jar",
        displayName: "Fabric API",
        compatibility: {
          status: "compatible",
          compatible: true,
          reason: "ok",
          file: {
            filename: "fabric-api.jar",
            url: "https://cdn.modrinth.com/private.jar",
            size: 123,
            hashes: { sha1: "abc", sha512: "def" }
          }
        },
        modrinth: {
          projectId: "fabric-api",
          versionId: "version-1",
          filename: "fabric-api.jar",
          versionNumber: "1.0.0",
          gameVersions: ["1.21.4"],
          loaders: ["fabric"],
          hashes: { sha1: "abc", sha512: "def" },
          installedAt: "2026-01-01T00:00:00.000Z",
          installedWithForceIncompatible: false,
          reviewAcknowledgedVersionId: "version-1",
          reviewAcknowledgedAt: "2026-01-02T00:00:00.000Z"
        },
        dependencyHealth: {
          status: "missing",
          requiredCount: 1,
          missing: [{ projectId: "cloth-config", title: "Cloth Config", iconUrl: "/api/modrinth/icon?url=cloth" }]
        }
      }]
    }) as { mods: Array<{ compatibility: { file?: unknown }; modrinth: Record<string, unknown>; dependencyHealth: { missing: Array<{ title?: string }> } }> };

    expect(JSON.stringify(result)).not.toContain("sha512");
    expect(JSON.stringify(result)).not.toContain("cdn.modrinth.com");
    expect(result.mods[0].compatibility.file).toEqual({ filename: "fabric-api.jar", size: 123 });
    expect(result.mods[0].modrinth.hashes).toBeUndefined();
    expect(result.mods[0].modrinth.reviewAcknowledgedVersionId).toBe("version-1");
    expect(result.mods[0].dependencyHealth.missing[0].title).toBe("Cloth Config");
  });
});

describe("mutable server configuration guard", () => {
  const message = "Stop the server before changing mods or server properties.";

  it("allows mod and property mutations only for stopped-like runtime states", () => {
    expect(mutableServerConfigurationBlockedReason({ docker: { running: false, state: "exited" } })).toBe("");
    expect(mutableServerConfigurationBlockedReason({ docker: { running: false, state: "created" } })).toBe("");
    expect(mutableServerConfigurationBlockedReason({ docker: { configured: false, available: false, running: false, state: "unknown", message: "No Docker integration is configured" } })).toBe("");
    expect(mutableServerConfigurationBlockedReason({ docker: { available: true, running: false, state: "unknown", message: "Container not found on remote node" } })).toBe("");
    expect(mutableServerConfigurationBlockedReason({ docker: { running: true, state: "running" } })).toBe(message);
    expect(mutableServerConfigurationBlockedReason({ docker: { running: false, state: "paused" } })).toBe(message);
    expect(mutableServerConfigurationBlockedReason({ docker: { running: false, state: "restarting" } })).toBe(message);
    expect(mutableServerConfigurationBlockedReason({ docker: { available: false, running: false, state: "unknown", message: "Docker socket is not mounted" } })).toBe(message);
    expect(mutableServerConfigurationBlockedReason({ docker: { available: true, running: false, state: "unknown" } })).toBe(message);
  });

  it("blocks mutations while lifecycle operations are queued or running", () => {
    expect(mutableServerConfigurationBlockedReason({ docker: { running: false, state: "exited" } }, [{ type: "server.start" }])).toBe(message);
    expect(mutableServerConfigurationBlockedReason({ docker: { running: false, state: "exited" } }, [{ type: "server.stop" }])).toBe(message);
    expect(mutableServerConfigurationBlockedReason({ docker: { running: false, state: "exited" } }, [{ type: "server.restart" }])).toBe(message);
    expect(mutableServerConfigurationBlockedReason({ docker: { running: false, state: "exited" } }, [{ type: "mod.update" }])).toBe("");
  });
});

describe("parseLogEvent log parsing and timestamp extraction", () => {
  it("parses modern Minecraft log format with time-of-day timestamp", () => {
    const line = "[12:34:56] [Server thread/INFO]: Antigravity joined the game";
    const reference = new Date(2026, 4, 29, 13, 0, 0);
    const expected = new Date(reference);
    expected.setHours(12, 34, 56, 0);
    const event = parseLogEvent(line, "logs/latest.log", 1, reference);
    expect(event).not.toBeNull();
    expect(event!.timestamp).toBe(expected.toISOString());
    expect(event!.type).toBe("success");
    expect(event!.text).toBe("Antigravity joined");
    expect(event!.eventType).toBe("player_joined");
    expect(event!.signature).toBe("player_joined:antigravity");
  });

  it("parses wrapper log format with full date-time timestamp", () => {
    const line = "[2026-05-29 12:34:56] [Server thread/INFO]: Antigravity left the game";
    const event = parseLogEvent(line, "logs/latest.log", 2);
    expect(event).not.toBeNull();
    expect(event!.timestamp).toBe(new Date("2026-05-29T12:34:56").toISOString());
    expect(event!.type).toBe("info");
    expect(event!.text).toBe("Antigravity left");
    expect(event!.eventType).toBe("player_left");
  });

  it("treats a future time-only log entry as the previous local day", () => {
    const reference = new Date(2026, 4, 29, 12, 0, 0);
    const expected = new Date(reference);
    expected.setDate(expected.getDate() - 1);
    expected.setHours(13, 0, 0, 0);

    const event = parseLogEvent("[13:00:00] [Server thread/INFO]: Alex joined the game", "logs/latest.log", 3, reference);

    expect(event?.timestamp).toBe(expected.toISOString());
  });

  it("correctly identifies server start events", () => {
    const line = "[12:34:56] [Server thread/INFO]: Done (5.132s)! For help, type \"help\"";
    const event = parseLogEvent(line, "logs/latest.log", 3);
    expect(event).not.toBeNull();
    expect(event!.text).toBe("Server started");
    expect(event!.type).toBe("success");
    expect(event!.signature).toBe("server_started");
  });

  it("does not report startup progress as a completed server start", () => {
    expect(parseLogEvent("[12:34:55] [Server thread/INFO]: Starting minecraft server version 26.2", "logs/latest.log", 2)).toBeNull();
  });

  it("removes socket addresses from player disconnect events", () => {
    const line = "[21:40:51] [Server thread/INFO]: MCArchive (/62.210.101.98:15415) lost connection: Disconnected";
    const event = parseLogEvent(line, "logs/latest.log", 4);
    expect(event).not.toBeNull();
    expect(event!.text).toBe("MCArchive left");
    expect(event!.signature).toBe("player_left:mcarchive");
  });

  it("compacts duplicate same-second recent events", () => {
    const reference = new Date(2026, 4, 29, 15, 0, 0);
    const events = [
      parseLogEvent("[14:15:01] [Server thread/INFO]: Done (5.132s)! For help, type \"help\"", "logs/latest.log", 1, reference),
      parseLogEvent("[14:15:01] [Server thread/INFO]: Done (5.132s)! For help, type \"help\"", "docker", 2, reference),
      parseLogEvent("[14:15:02] [Server thread/INFO]: Done (5.132s)! For help, type \"help\"", "docker", 3, reference)
    ].filter((event): event is ServerEvent => Boolean(event));
    const compacted = compactRecentEvents(events, 10);
    const first = new Date(reference);
    first.setHours(14, 15, 1, 0);
    const second = new Date(reference);
    second.setHours(14, 15, 2, 0);
    expect(compacted.map((event) => event.timestamp)).toEqual([second.toISOString(), first.toISOString()]);
  });

  it("correctly identifies server stopped events from shutdown lines", () => {
    const line = "[12:34:56] [Server thread/INFO]: Stopping server";
    const event = parseLogEvent(line, "logs/latest.log", 4);
    expect(event).not.toBeNull();
    expect(event!.text).toBe("Server stopped");
    expect(event!.eventType).toBe("server_stopped");
  });

  it("ignores server save lines because they are not recent events", () => {
    const line = "[12:34:56] [Server thread/INFO]: Saved the game";
    const event = parseLogEvent(line, "logs/latest.log", 4);
    expect(event).toBeNull();
  });

  it("identifies explicit mod disabled events", () => {
    const line = "[12:34:56] [Server thread/WARN]: Disabled mod sodium.jar";
    const event = parseLogEvent(line, "logs/latest.log", 4);
    expect(event).not.toBeNull();
    expect(event!.text).toBe("Mod disabled: sodium.jar");
    expect(event!.eventType).toBe("mod_disabled");
    expect(event!.signature).toBe("mod_disabled:sodium.jar");
  });

  it("identifies explicit crash report events", () => {
    const line = "[12:34:56] [Server thread/ERROR]: Encountered an unexpected exception";
    const event = parseLogEvent(line, "logs/latest.log", 4);
    expect(event).not.toBeNull();
    expect(event!.text).toBe("Server crashed");
    expect(event!.eventType).toBe("server_crashed");
  });

  it("identifies caught exceptions without promoting them to crashes", () => {
    const line = "[12:34:56] [Server thread/WARN]: Caught java.lang.NullPointerException: chunk task failed";
    const event = parseLogEvent(line, "logs/latest.log", 5);

    expect(event).toMatchObject({
      eventType: "exception_caught",
      severity: "warning",
      text: "Exception caught: NullPointerException",
      signature: "exception_caught:nullpointerexception"
    });
    expect(event?.details).toContain("chunk task failed");
  });

  it("identifies server overload warnings with useful lag details", () => {
    const line = "[12:34:56] [Server thread/WARN]: Can't keep up! Is the server overloaded? Running 5421ms or 108 ticks behind";
    const event = parseLogEvent(line, "logs/latest.log", 6);

    expect(event).toMatchObject({
      eventType: "server_overloaded",
      severity: "warning",
      text: "Server is falling behind",
      details: "Running 5421ms or 108 ticks behind"
    });
  });

  it("ignores file listing lines from ls -la even if they contain 'error'", () => {
    const line = "-rw-r--r-- 1 root root    0 May 29 12:34 error.log";
    const event = parseLogEvent(line, "docker", 5);
    expect(event).toBeNull();
  });

  it("ignores raw filenames containing 'error' or 'crash'", () => {
    const line1 = "error.log";
    expect(parseLogEvent(line1, "docker", 6)).toBeNull();

    const line2 = "hs_err_pid1234.log";
    expect(parseLogEvent(line2, "docker", 7)).toBeNull();
  });

  it("ignores unstructured stack lines that are not caught or levelled log events", () => {
    const line = "java.lang.NullPointerException: something went wrong";
    const event = parseLogEvent(line, "logs/latest.log", 8);
    expect(event).toBeNull();
  });

  it("ignores Fabric dependency tree lines and JVM informational messages", () => {
    expect(parseLogEvent("|-- fabric-crash-report-info-v1 1.0.3+9f78a5a839", "logs/latest.log", 9)).toBeNull();
    expect(parseLogEvent("[12:34:56] [main/INFO]: Distant Horizons: G1 Garbage collector detected.", "logs/latest.log", 10)).toBeNull();
  });
});

describe("Minecraft Query metrics parsing", () => {
  it("parses the challenge token from a Minecraft Query handshake response", () => {
    const sessionId = Buffer.from([1, 2, 3, 4]);
    const packet = Buffer.concat([Buffer.from([9]), sessionId, Buffer.from("123456\0", "utf8")]);

    expect(parseMinecraftQueryChallenge(packet, sessionId)).toBe(123456);
  });

  it("rejects challenge responses for a different session", () => {
    const sessionId = Buffer.from([1, 2, 3, 4]);
    const packet = Buffer.concat([Buffer.from([9, 4, 3, 2, 1]), Buffer.from("123456\0", "utf8")]);

    expect(() => parseMinecraftQueryChallenge(packet, sessionId)).toThrow("Invalid Minecraft Query challenge response");
  });

  it("parses player counts and player names from a full query response", () => {
    const sessionId = Buffer.from([1, 2, 3, 4]);
    const payload = Buffer.concat([
      Buffer.from("hostname\0Test Server\0numplayers\0", "utf8"),
      Buffer.from("2\0maxplayers\0", "utf8"),
      Buffer.from("20\0", "utf8"),
      Buffer.from("\0\x01player_\0\0", "latin1"),
      Buffer.from(" Alex \0Steve\0Alex\0\0", "utf8")
    ]);
    const packet = Buffer.concat([Buffer.from([0]), sessionId, Buffer.alloc(11), payload]);

    expect(parseMinecraftQueryResponse(packet, sessionId)).toEqual({
      responding: true,
      playersOnline: 2,
      maxPlayers: 20,
      playerNames: ["Alex", "Steve"]
    });
  });

  it("parses an empty player roster from a full query response", () => {
    const sessionId = Buffer.from([1, 2, 3, 4]);
    const payload = Buffer.concat([
      Buffer.from("numplayers\0", "utf8"),
      Buffer.from("0\0maxplayers\0", "utf8"),
      Buffer.from("20\0", "utf8"),
      Buffer.from("\0\x01player_\0\0\0", "latin1")
    ]);
    const packet = Buffer.concat([Buffer.from([0]), sessionId, Buffer.alloc(11), payload]);

    expect(parseMinecraftQueryResponse(packet, sessionId)).toEqual({
      responding: true,
      playersOnline: 0,
      maxPlayers: 20,
      playerNames: []
    });
  });
});

describe("security validation helpers", () => {
  it("ignores malformed cookie values instead of throwing", () => {
    expect(parseCookies("valid=abc%20123; broken=%; another=ok").get("valid")).toBe("abc 123");
    expect(parseCookies("valid=abc%20123; broken=%; another=ok").get("broken")).toBeUndefined();
    expect(parseCookies("valid=abc%20123; broken=%; another=ok").get("another")).toBe("ok");
  });

  it("requires true booleans instead of truthy strings", () => {
    expect(requireStrictBoolean(true, "forceIncompatible")).toBe(true);
    expect(requireStrictBoolean(false, "forceIncompatible")).toBe(false);
    expect(() => requireStrictBoolean("false", "forceIncompatible")).toThrow("must be a boolean");
  });

  it("rejects unsafe Java shell metacharacters", () => {
    expect(validateJavaArgs("-Xms2G -Xmx4G")).toBe("-Xms2G -Xmx4G");
    expect(() => validateJavaArgs("-Xmx4G; curl example.test")).toThrow("unsafe shell characters");
    expect(() => validateJavaArgs("$(touch owned)")).toThrow("unsafe shell characters");
  });

  it("validates Docker and Modrinth identifiers conservatively", () => {
    expect(validateDockerContainerName("serversentinel-main.1")).toBe("serversentinel-main.1");
    expect(() => validateDockerContainerName("../docker")).toThrow("Docker container name");
    expect(validateModrinthProjectId("fabric-api")).toBe("fabric-api");
    expect(() => validateModrinthProjectId("bad/project")).toThrow("Modrinth project id");
  });

  it("requires runtime server jar names to stay local jar filenames", () => {
    expect(validateRuntimeJarFilename("fabric-server-launch.jar")).toBe("fabric-server-launch.jar");
    expect(() => validateRuntimeJarFilename("../fabric-server-launch.jar")).toThrow("local .jar filename");
    expect(() => validateRuntimeJarFilename("..\\fabric-server-launch.jar")).toThrow("local .jar filename");
    expect(() => validateRuntimeJarFilename("server.txt")).toThrow("local .jar filename");
  });

  it("validates node setup inputs without credentials or multiline mounts", () => {
    expect(optionalNodePanelUrl("http://192.168.1.11:8085")).toBe("http://192.168.1.11:8085");
    expect(() => optionalNodePanelUrl("ftp://panel.local")).toThrow("http or https");
    expect(() => optionalNodePanelUrl("http://user:pass@panel.local")).toThrow("embedded credentials");
    expect(optionalNodeDataMount("/srv/serversentinel")).toBe("/srv/serversentinel");
    expect(() => optionalNodeDataMount("/srv/data\nSS_JOIN_TOKEN=bad")).toThrow("single-line");
    expect(optionalReleaseChannel("beta")).toBe("beta");
    expect(() => optionalReleaseChannel("nightly")).toThrow("Release channel");
    expect(optionalCompatibilityFilter("compatible")).toBe("compatible");
    expect(optionalCompatibilityFilter("all")).toBe("all");
    expect(() => optionalCompatibilityFilter("unsafe")).toThrow("Compatibility filter");
  });

  it("bounds node join token expiry to deliberate short-lived values", () => {
    expect(validateJoinTokenTtlMinutes(undefined)).toBe(60);
    expect(validateJoinTokenTtlMinutes(5)).toBe(5);
    expect(validateJoinTokenTtlMinutes(1440)).toBe(1440);
    expect(() => validateJoinTokenTtlMinutes(4)).toThrow("Join token expiry");
    expect(() => validateJoinTokenTtlMinutes(1441)).toThrow("Join token expiry");
    expect(() => validateJoinTokenTtlMinutes(30.5)).toThrow("Join token expiry");
  });

  it("expires server-side sessions even if a stale cookie is still sent", () => {
    const now = Date.now();
    expect(sessionExpired({ createdAt: new Date(now - sessionMaxAgeSeconds * 1000 + 1000).toISOString() }, now)).toBe(false);
    expect(sessionExpired({ createdAt: new Date(now - sessionMaxAgeSeconds * 1000 - 1000).toISOString() }, now)).toBe(true);
    expect(sessionExpired({ createdAt: "not-a-date" }, now)).toBe(true);
  });
});

describe("node install instructions", () => {
  it("passes the host-side node data directory for Docker sibling container binds", () => {
    const install = nodeInstallInstructions({
      panelUrl: "http://192.168.1.11:8085",
      dataMount: "/var/lib/serversentinel",
      nodeName: "mc-node-01",
      joinToken: "join-token"
    });

    expect(install.protocolVersion).toBe("3.0");
    expect(install.dockerCompose.environment.SERVERSENTINEL_DATA_DIR).toBe("/data");
    expect(install.dockerCompose.environment.SERVERSENTINEL_DOCKER_DATA_DIR).toBe("/var/lib/serversentinel");
    expect(install.dockerCompose.environment.TZ).toBe(process.env.TZ);
    expect(install.dockerCompose.restart).toBe("unless-stopped");
    expect(install.dockerRun).toContain("--restart unless-stopped");
    expect(install.dockerRun).toContain("--env SERVERSENTINEL_DATA_DIR='/data'");
    expect(install.dockerRun).toContain("--env SERVERSENTINEL_DOCKER_DATA_DIR='/var/lib/serversentinel'");
    expect(install.dockerRun).toContain(`--env TZ='${process.env.TZ}'`);
    expect(install.dockerRun).toContain("--volume '/var/lib/serversentinel:/data'");
  });
});

describe("node force delete cleanup", () => {
  const node = {
    id: "deleted-node",
    name: "Remote Node",
    type: "remote",
    status: "online",
    isInternal: false,
    createdAt: "",
    updatedAt: ""
  } satisfies ManagedNode;
  const assignedServers = [
    { id: "server-1", nodeId: "deleted-node", displayName: "One", serverDir: "/tmp/one", runtimeProfile: testRuntimeProfile(), createdAt: "", updatedAt: "" },
    { id: "server-3", nodeId: "deleted-node", displayName: "Three", serverDir: "/tmp/three", runtimeProfile: testRuntimeProfile(), createdAt: "", updatedAt: "" }
  ] satisfies ManagedServer[];

  it("cleans up assigned server containers before node records are deleted", async () => {
    const calls: string[] = [];
    const summary = await cleanupNodeServerContainers({
      node,
      assignedServers,
      isConnected: () => true,
      deleteServerContainer: async (_node, server) => {
        calls.push(server.id);
        return { deletedContainer: true };
      }
    });

    expect(calls).toEqual(["server-1", "server-3"]);
    expect(summary).toEqual({ attempted: 2, deletedContainers: 2, failed: [] });
  });

  it("reports cleanup failures without hiding successful container removals", async () => {
    const summary = await cleanupNodeServerContainers({
      node,
      assignedServers,
      isConnected: () => true,
      deleteServerContainer: async (_node, server) => {
        if (server.id === "server-3") throw new Error("Container is unmanaged");
        return { deletedContainer: true };
      }
    });

    expect(summary.attempted).toBe(2);
    expect(summary.deletedContainers).toBe(1);
    expect(summary.failed).toEqual([{ serverId: "server-3", serverName: "Three", message: "Container is unmanaged" }]);
  });

  it("marks assigned server cleanup as skipped when the node is offline", async () => {
    const summary = await cleanupNodeServerContainers({
      node: { ...node, status: "offline" },
      assignedServers,
      isConnected: () => false,
      deleteServerContainer: async () => {
        throw new Error("should not be called");
      }
    });

    expect(summary.attempted).toBe(0);
    expect(summary.deletedContainers).toBe(0);
    expect(summary.failed).toEqual([]);
    expect(summary.skippedReason).toContain("Remote Node is offline");
  });
});

describe("server port conflict detection", () => {
  const servers = [
    {
      id: "server-1",
      nodeId: "node-a",
      displayName: "Survival",
      serverDir: "/tmp/survival",
      dockerPorts: "25565:25565/tcp,25565:25565/udp",
      runtimeProfile: testRuntimeProfile(),
      createdAt: "",
      updatedAt: ""
    },
    {
      id: "server-2",
      nodeId: "node-b",
      displayName: "Creative",
      serverDir: "/tmp/creative",
      dockerPorts: "25565:25565/tcp",
      runtimeProfile: testRuntimeProfile(),
      createdAt: "",
      updatedAt: ""
    }
  ] satisfies ManagedServer[];

  it("extracts host ports by protocol from Docker port bindings", () => {
    expect(dockerHostPortBindings("25565:25565/tcp,19132:19132/udp")).toEqual([
      { port: "25565", protocol: "tcp", key: "25565/tcp" },
      { port: "19132", protocol: "udp", key: "19132/udp" }
    ]);
  });

  it("detects duplicate host ports on the same node", () => {
    const conflict = findExistingServerPortConflict(servers, "node-a", "25565:25566/tcp");
    expect(conflict?.ownerName).toBe('managed server "Survival"');
    expect(conflict?.port).toEqual({ port: "25565", protocol: "tcp", key: "25565/tcp" });
  });

  it("allows the same host port on a different node or different protocol", () => {
    expect(findExistingServerPortConflict(servers, "node-b", "25565:25566/tcp", "server-2")).toBeNull();
    expect(findExistingServerPortConflict(servers, "node-a", "25566:25565/tcp")).toBeNull();
    expect(findExistingServerPortConflict(servers, "node-a", "25565:25565/udp", "server-1")).toBeNull();
  });

  it("adds a required non-removable advanced Query UDP port when creating a server", () => {
    const normalized = normalizeCreateServerPorts({ serverPort: "25565" }, [], "node-a");
    expect(normalized.queryPort).toBe(25566);
    expect(normalized.dockerPorts).toContain("25566:25566/udp");
    expect(normalized.managedPorts.find((port) => port.type === "query")).toMatchObject({
      name: "Minecraft Query",
      protocol: "udp",
      internalPort: 25566,
      externalPort: 25566,
      required: true,
      removable: false,
      advanced: true
    });
  });

  it("allocates the next free Query port when 25566 is already used on the node", () => {
    const normalized = normalizeCreateServerPorts({
      serverPort: "25565"
    }, [{
      id: "server-query",
      nodeId: "node-a",
      displayName: "Query Owner",
      serverDir: "/tmp/query-owner",
      dockerPorts: "25566:25566/udp",
      managedPorts: [{
        id: "minecraft-query",
        name: "Minecraft Query",
        type: "query",
        protocol: "udp",
        internalPort: 25566,
        externalPort: 25566,
        required: true,
        removable: false,
        advanced: true
      }],
      runtimeProfile: testRuntimeProfile(),
      createdAt: "",
      updatedAt: ""
    }], "node-a");

    expect(normalized.queryPort).toBe(25567);
    expect(normalized.dockerPorts).toContain("25567:25567/udp");
  });

  it("does not allocate a Query port that conflicts with the main Minecraft port", () => {
    const normalized = normalizeCreateServerPorts({ serverPort: "25566" }, [], "node-a");
    expect(normalized.queryPort).toBe(25567);
  });

  it("rejects an explicit Query port already used on the same node", () => {
    expect(() => allocateQueryPort(servers, "node-a", "25567:25567/tcp", "25565")).toThrow("already used");
  });
});

describe("Minecraft Query endpoint resolution", () => {
  const server = (ports = [{ id: "minecraft-query", name: "Minecraft Query", type: "query" as const, protocol: "udp" as const, internalPort: 25566, externalPort: 32566, required: true, removable: false, advanced: true }]) => ({
    id: "s1",
    nodeId: "local",
    name: "Test",
    path: "/tmp/test",
    dockerContainer: "mc",
    dockerPorts: "25565:25565/tcp,32566:25566/udp",
    managedPorts: ports
  }) as ManagedServer;

  it("prefers the managed Minecraft container IP on a shared Docker network and uses internalPort", async () => {
    const { resolveMinecraftQueryEndpoint } = await import("./queryEndpoint.js");
    const endpoint = resolveMinecraftQueryEndpoint(server(), {}, {
      NetworkSettings: { Networks: { app: { NetworkID: "net1", IPAddress: "172.20.0.5" } } }
    }, {
      NetworkSettings: { Networks: { app: { NetworkID: "net1", IPAddress: "172.20.0.2" } } }
    });
    expect(endpoint).toMatchObject({ host: "172.20.0.5", port: 25566, source: "container-network" });
  });

  it("falls back to externalPort through the Docker host when no shared network is reachable", async () => {
    const { resolveMinecraftQueryEndpoint } = await import("./queryEndpoint.js");
    const endpoint = resolveMinecraftQueryEndpoint(server(), {}, {
      NetworkSettings: { Networks: { minecraft: { NetworkID: "net-mc", IPAddress: "172.21.0.5" } } }
    }, {
      NetworkSettings: { Networks: { panel: { NetworkID: "net-panel", IPAddress: "172.22.0.2", Gateway: "172.22.0.1" } } }
    });
    expect(endpoint).toMatchObject({ host: "172.22.0.1", port: 32566, source: "published-host" });
  });

  it("returns null when query is not configured", async () => {
    const { resolveMinecraftQueryEndpoint } = await import("./queryEndpoint.js");
    expect(resolveMinecraftQueryEndpoint(server([]), {}, null, null)).toBeNull();
  });
});

describe("Minecraft Docker network preservation", () => {
  const customNetworkInspect = {
    NetworkSettings: {
      Networks: {
        minecraft: {
          IPAMConfig: { IPv4Address: "172.30.0.8" },
          Aliases: ["survival"],
          DriverOpts: { "com.example.option": "enabled" },
          EndpointID: "endpoint-id",
          NetworkID: "network-id",
          IPAddress: "172.30.0.12",
          Gateway: "172.30.0.1",
          MacAddress: "02:42:ac:1e:00:0c"
        }
      }
    }
  };

  it("preserves user-provided network endpoint options without copying Docker-assigned fields", () => {
    expect(dockerNetworkingConfigFromInspect(customNetworkInspect)).toEqual({
      EndpointsConfig: {
        minecraft: {
          IPAMConfig: { IPv4Address: "172.30.0.8" },
          Aliases: ["survival"],
          DriverOpts: { "com.example.option": "enabled" }
        }
      }
    });
  });

  it("prefers the old Minecraft container networks and falls back to panel networks", () => {
    const panelInspect = {
      NetworkSettings: {
        Networks: {
          panel: {
            Aliases: ["serversentinel"]
          }
        }
      }
    };

    expect(minecraftContainerNetworkingConfig(customNetworkInspect, panelInspect)).toEqual(dockerNetworkingConfigFromInspect(customNetworkInspect));
    expect(minecraftContainerNetworkingConfig({ NetworkSettings: { Networks: {} } }, panelInspect)).toEqual(dockerNetworkingConfigFromInspect(panelInspect));
  });
});

describe("Minecraft Query timeout behavior", () => {
  it("detects disabled Minecraft Query configuration", async () => {
    const { minecraftQueryDisabled } = await import("./queryEndpoint.js");
    expect(minecraftQueryDisabled({ "enable-query": "false" })).toBe(true);
    expect(minecraftQueryDisabled({ "enable-query": "true" })).toBe(false);
    expect(minecraftQueryDisabled({})).toBe(true);
  });
});
