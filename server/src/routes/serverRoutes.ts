import type { FastifyInstance } from "fastify";
import { runtimeForNodeId, runtimeForServer, services } from "../appServices.js";
import { config, maxServerPort, minServerPort } from "../config.js";
import { commandRateLimit, destructiveRateLimit, provisionRateLimit, runtimeActionRateLimit } from "../http/rateLimits.js";
import { badRequest } from "../http/validation.js";
import { apiErrorResponse } from "../http/errors.js";
import { consoleLogLineLimit } from "../consoleLogs.js";
import { hasPermission } from "../permissions.js";
import { serverRuntimeDefinition } from "@serversentinel/contracts";
import { activeScheduledRunsFor } from "../schedules/activeRuns.js";
import { requireNoActiveModMutation } from "../mods/modService.js";
import { allocateQueryPort, assertNodePortsAvailable, assertUniqueDockerHostPorts, dockerPortsWithManagedEntries, isValidServerPort, normalizeCreateServerPorts, normalizeManagedPorts, queryPortEntry } from "../servers/ports.js";
import { runtimeProfileForServer } from "../runtime/profile.js";
import { requireRequestPermission } from "../auth/sessionService.js";
import { getServer, listManagedServers } from "../servers/store.js";
import { publicServerStatus } from "../servers/publicViews.js";
import { serverJarProvider, startProvisionOperation } from "../servers/provisioning.js";
import { type CreateServerInput } from "../servers/ports.js";
import { lifecycleWithIntent, recordOperation, requireServerStoppedForMutableConfiguration, runtimeResultRunning, sendConsoleCommandWithIntent } from "../servers/lifecycle.js";
import { startConsoleHeartbeat, timelineHistoryWindow as timelineHistoryWindowMs, type Client } from "../servers/overview.js";
import { createConsoleSender } from "../servers/consoleBackpressure.js";
import { consoleHub, type ConsoleCursor } from "../servers/consoleService.js";
import { serverLogFields } from "../runtime/local/dockerContainers.js";
import { timelinePlayerActivity, timelinePlayerIsKnown, timelineResourcePoints, timelineScheduleMarkers } from "../serverTimeline.js";
import { localNodeId } from "../nodes/nodeService.js";
import { logDebug, logInfo, logWarn, errorLogFields } from "../logging.js";
import type { ManagedServer, ServerRuntimeProfile } from "../types.js";

/**
 * A viewer's resume point. Both halves have to be present and well formed to be trusted: without a
 * matching epoch a sequence number refers to some other buffer, and honouring it would silently
 * skip the lines the viewer actually needs.
 */
function consoleCursor(params: URLSearchParams): ConsoleCursor | undefined {
  const epoch = params.get("epoch");
  const since = Number(params.get("since"));
  if (!epoch || !Number.isInteger(since) || since < 0) return undefined;
  return { since, epoch };
}

export function registerServerRoutes(app: FastifyInstance) {
app.post<{
  Body: CreateServerInput;
}>("/api/servers", provisionRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "servers.create");
  const nodeId = request.body.nodeId?.trim() || (config.runtimeMode === "all-in-one" ? localNodeId : "");
  if (!nodeId) throw new Error("nodeId is required when serverSENTINEL runs in panel mode");
  const { dockerPorts, queryPort } = normalizeCreateServerPorts(request.body, await listManagedServers(), nodeId);
  assertNodePortsAvailable(await listManagedServers(), nodeId, dockerPorts);
  request.body.dockerPorts = dockerPorts;
  request.body.queryPort = String(queryPort);
  const server = await recordOperation({
    type: "server.create",
    nodeId,
    createdBy: user.id,
    task: "Creating server",
    runningTask: "Creating server",
    successTask: "Server setup complete",
    serverIdFromResult: (createdServer: ManagedServer) => createdServer.id,
    result: (createdServer: ManagedServer) => ({ serverId: createdServer.id })
  }, (operation) => runtimeForNodeId(nodeId).createServer({ ...request.body, nodeId }, undefined, operation.id));
  logInfo(serverLogFields(server), "Managed server created");
  return runtimeForServer(server).publicServer(server);
});

app.post<{ Body: CreateServerInput }>("/api/servers/provision", provisionRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "servers.create");
  if (!request.body.nodeId && config.runtimeMode === "panel") {
    throw new Error("nodeId is required when serverSENTINEL runs in panel mode");
  }
  return startProvisionOperation(request.body, user.id);
});

app.put<{
  Params: { id: string };
  Body: {
    displayName?: string;
    runtime?: CreateServerInput["runtime"];
    dockerContainer?: string;
    dockerImage?: string;
    dockerPorts?: string;
    queryPort?: string;
    javaArgs?: string;
    serverPort?: string;
    startOnNodeStart?: boolean;
  };
}>("/api/servers/:id", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.editSettings");
  const server = await getServer(request.params.id);
  await requireServerStoppedForMutableConfiguration(server);
  const nextDisplayName = request.body.displayName?.trim() || server.displayName;
  const servers = await listManagedServers();
  if (servers.some((candidate) => candidate.id !== server.id && candidate.displayName.toLowerCase() === nextDisplayName.toLowerCase())) {
    throw new Error("A managed server with this display name already exists");
  }
  const serverPort = request.body.serverPort?.trim();
  if (serverPort && !isValidServerPort(serverPort)) {
    throw new Error(`Server port must be between ${minServerPort} and ${maxServerPort}`);
  }
  const requestedDockerPorts = request.body.dockerPorts?.trim() || (serverPort ? `${serverPort}:${serverPort}/tcp` : server.dockerPorts);
  const currentQueryPort = server.managedPorts?.find((port) => port.type === "query")?.externalPort;
  const queryPort = request.body.queryPort?.trim() || (currentQueryPort ? String(currentQueryPort) : undefined);
  const allocatedQueryPort = allocateQueryPort(servers, server.nodeId, requestedDockerPorts || "", queryPort, { ignoreServerId: server.id });
  const managedPorts = normalizeManagedPorts(requestedDockerPorts || "", [queryPortEntry(allocatedQueryPort)]);
  const dockerPorts = dockerPortsWithManagedEntries(requestedDockerPorts || "", managedPorts);
  if (dockerPorts) {
    assertUniqueDockerHostPorts(dockerPorts);
    assertNodePortsAvailable(await listManagedServers(), server.nodeId, dockerPorts, { ignoreServerId: server.id });
  }
  const updatedServer = await runtimeForServer(server).updateServer(server, { ...request.body, dockerPorts, queryPort: String(allocatedQueryPort) });
  return runtimeForServer(updatedServer).publicServer(updatedServer);
});

app.get<{ Params: { id: string } }>("/api/servers/:id/runtime", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const server = await getServer(request.params.id);
  const runtimeProfile = runtimeProfileForServer(server);
  return {
    serverId: server.id,
    runtimeProfile,
    compatibilityStatus: runtimeProfile.compatibilityStatus
  };
});

app.post<{ Params: { id: string }; Body: { refresh?: boolean } }>("/api/servers/:id/runtime/refresh", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.editSettings");
  const server = await getServer(request.params.id);
  await requireServerStoppedForMutableConfiguration(server);
  const runtimeProfile = runtimeProfileForServer(server);
  const runtimeDefinition = serverRuntimeDefinition(runtimeProfile.runtimeType);
  if (!runtimeDefinition.managedProvisioning) {
    throw new Error(`${runtimeDefinition.displayName} runtime refresh is not available until its provider is enabled`);
  }
  const refreshed = await serverJarProvider.resolveServerJar({
    runtimeType: runtimeProfile.runtimeType,
    minecraftVersion: runtimeProfile.minecraftVersion,
    runtimeVersion: runtimeProfile.runtimeVersion || "latest",
    preferStable: true,
    forceRefresh: request.body.refresh === true
  });
  const nextProfile: ServerRuntimeProfile = {
    ...refreshed,
    jarArtifact: {
      ...refreshed.jarArtifact,
      filename: runtimeProfile.jarArtifact.filename || refreshed.jarArtifact.filename
    }
  };
  const updatedServer: ManagedServer = {
    ...server,
    runtimeProfile: nextProfile,
    updatedAt: new Date().toISOString()
  };
  services.serversRepository.replaceMetadata(updatedServer);
  return {
    serverId: server.id,
    runtimeProfile: nextProfile,
    server: await runtimeForServer(updatedServer).publicServer(updatedServer),
    warnings: []
  };
});

app.delete<{
  Params: { id: string };
  Body: {
    confirmName?: string;
    deleteFiles?: boolean;
  };
}>("/api/servers/:id", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.delete");
  const server = await getServer(request.params.id);
  return runtimeForServer(server).deleteServer(server, request.body);
});

app.get<{ Params: { id: string } }>("/api/servers/:id/status", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const server = await getServer(request.params.id);
  return publicServerStatus(await runtimeForServer(server).serverStatus(server), server);
});

app.post<{ Params: { id: string } }>("/api/servers/:id/start", runtimeActionRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "servers.control");
  const server = await getServer(request.params.id);
  requireNoActiveModMutation(server.id);
  const runtime = runtimeForServer(server);
  const wasRunning = ((await runtime.serverStatus(server).catch(() => null)) as { docker?: { running?: boolean } } | null)?.docker?.running === true;
  return recordOperation({
    type: "server.start",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: "Starting server",
    successTask: "Server started",
    restartEffect: (status) => !wasRunning && runtimeResultRunning(status) ? "clear" : undefined
  }, () => lifecycleWithIntent(server, "start"));
});

app.post<{ Params: { id: string } }>("/api/servers/:id/stop", runtimeActionRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "servers.control");
  const server = await getServer(request.params.id);
  requireNoActiveModMutation(server.id);
  return recordOperation({
    type: "server.stop",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: "Stopping server",
    successTask: "Server stopped"
  }, () => lifecycleWithIntent(server, "stop"));
});

app.post<{ Params: { id: string } }>("/api/servers/:id/restart", runtimeActionRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "servers.control");
  const server = await getServer(request.params.id);
  requireNoActiveModMutation(server.id);
  return recordOperation({
    type: "server.restart",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: "Restarting server",
    successTask: "Server restarted",
    restartEffect: "clear"
  }, () => lifecycleWithIntent(server, "restart"));
});

app.post<{ Params: { id: string }; Body: { command?: string } }>("/api/servers/:id/command", commandRateLimit, async (request) => {
  await requireRequestPermission(request, "console.command");
  const server = await getServer(request.params.id);
  return sendConsoleCommandWithIntent(server, request.body.command);
});

app.get("/ws/console", { websocket: true }, async (socket, request) => {
  const client = socket as unknown as Client;
  const url = new URL(request.url, "http://localhost");
  const serverId = url.searchParams.get("serverId") ?? undefined;
  let stopHeartbeat: (() => void) | undefined;
  try {
    await requireRequestPermission(request, "console.view");
    const server = await getServer(serverId);
    stopHeartbeat = startConsoleHeartbeat(client);
    socket.on("close", stopHeartbeat);
    logDebug({ ...serverLogFields(server), source: "console_websocket" }, "Console stream connected");

    // Per viewer, not per buffer: a viewer that cannot keep up drops its own frames and resumes
    // from its cursor, rather than slowing the output everyone else is reading.
    const sender = createConsoleSender(client);
    const session = await consoleHub.attach(server, {
      lines: (lines, epoch) => { sender.send({ type: "log", epoch, lines }); },
      unavailable: (message, options) => { sender.send({ type: "unavailable", message, ...options }); },
      empty: (message) => { sender.send({ type: "empty", message }); }
    }, consoleCursor(url.searchParams));
    socket.on("close", session.detach);

    sender.send({ type: "backlog", ...session.backlog });
    session.start();
    // The viewer refetches status over HTTP; this only tells it that now is the moment to.
    sender.send({ type: "status" });
  } catch (error) {
    stopHeartbeat?.();
    logWarn({ serverId, source: "console_websocket", ...errorLogFields(error) }, "Console stream unavailable");
    const streamError = error as Error & { code?: string };
    client.send(JSON.stringify({
      type: "unavailable",
      message: streamError.message,
      code: streamError.code?.toUpperCase(),
      retryable: streamError.code === "node_offline" || streamError.code === "command_timeout"
    }));
  }
});

/**
 * The polling fallback for viewers whose network blocks websockets. It reads the same buffer as the
 * stream, so a viewer can move between the two transports without its sequence numbers meaning
 * anything different.
 */
app.get<{ Params: { id: string }; Querystring: { since?: string; epoch?: string } }>("/api/servers/:id/console", async (request) => {
  await requireRequestPermission(request, "console.view");
  const server = await getServer(request.params.id);
  return consoleHub.read(server, consoleCursor(new URLSearchParams(request.query as Record<string, string>)));
});

app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/servers/:id/logs", async (request) => {
  await requireRequestPermission(request, "console.view");
  const server = await getServer(request.params.id);
  return runtimeForServer(server).serverLogs(server, consoleLogLineLimit(request.query.limit));
});

app.get<{ Params: { id: string } }>("/api/servers/:id/stats", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const server = await getServer(request.params.id);
  return services.resourceStatsCollector
    ? services.resourceStatsCollector.collectServer(server)
    : runtimeForServer(server).serverStats(server);
});

app.get<{ Params: { id: string } }>("/api/servers/:id/stats/history", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const server = await getServer(request.params.id);
  if (!services.resourceStatsCollector) {
    const sampledAt = Date.now();
    const stats = await runtimeForServer(server).serverStats(server);
    return {
      samples: [
        stats && typeof stats === "object"
          ? { ...(stats as Record<string, unknown>), sampledAt }
          : {
              available: false,
              running: false,
              cpuPercent: 0,
              memoryUsageBytes: 0,
              memoryLimitBytes: 0,
              readAt: new Date(sampledAt).toISOString(),
              message: "Container stats are unavailable",
              sampledAt
            }
      ]
    };
  }
  return services.resourceStatsCollector.history(server);
});

app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; maxPoints?: string } }>("/api/servers/:id/timeline", async (request) => {
  const user = await requireRequestPermission(request, "servers.view");
  const server = await getServer(request.params.id);
  const generatedAt = new Date();
  const to = request.query.to === undefined ? generatedAt.getTime() : Number(request.query.to);
  const from = request.query.from === undefined ? to - 60 * 60 * 1000 : Number(request.query.from);
  const requestedMaxPoints = request.query.maxPoints === undefined ? 900 : Number(request.query.maxPoints);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) badRequest("Timeline from and to must define a valid time range");
  if (to - from > timelineHistoryWindowMs) badRequest("Timeline range cannot exceed 7 days");
  if (!Number.isInteger(requestedMaxPoints) || requestedMaxPoints < 100) badRequest("Timeline maxPoints must be a whole number of at least 100");
  const maxPoints = Math.min(1_200, requestedMaxPoints);
  const contextFrom = generatedAt.getTime() - timelineHistoryWindowMs;
  const timelineEvents = services.timelineEventsRepository.list(server.id, contextFrom, to);
  const rawSamples = services.resourceStatsRepository.listRange(server.id, from, to, true);
  const latestRaw = services.resourceStatsRepository.latest(server.id);
  const samples = timelineResourcePoints(rawSamples, from, to, maxPoints, latestRaw?.cpuCapacityCores);
  const latest = latestRaw
    ? timelineResourcePoints(services.resourceStatsRepository.listRange(server.id, latestRaw.sampledAt, latestRaw.sampledAt, true), latestRaw.sampledAt, latestRaw.sampledAt, 2, latestRaw.cpuCapacityCores).at(-1)
    : undefined;
  const scheduleAnnotationsAvailable = hasPermission(user, "schedules.view");
  const scheduleResult = scheduleAnnotationsAvailable
    ? timelineScheduleMarkers({
        schedules: server.schedules ?? [],
        runs: services.serversRepository.scheduledRunsInRange(server.id, from, to),
        activeRuns: (server.schedules ?? []).flatMap((schedule) => activeScheduledRunsFor(server.id, schedule.id)),
        from,
        to,
        now: generatedAt.getTime()
      })
    : { markers: [], truncated: false };
  return {
    from,
    to,
    generatedAt: generatedAt.toISOString(),
    latest,
    samples,
    events: timelineEvents.filter((event) => event.occurredAt >= from),
    schedules: scheduleResult.markers,
    playerActivity: timelinePlayerActivity({
      events: timelineEvents,
      snapshot: services.playerSnapshotCoordinator?.latest(server.id),
      contextFrom,
      from,
      to,
      now: generatedAt.getTime()
    }),
    scheduleAnnotationsAvailable,
    truncated: { schedules: scheduleResult.truncated }
  };
});

app.get<{ Params: { id: string } }>("/api/servers/:id/events", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const server = await getServer(request.params.id);
  return runtimeForServer(server).serverOverview(server);
});

app.get("/api/player-snapshots", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const servers = await listManagedServers();
  return { snapshots: await services.playerSnapshotCoordinator!.snapshots(servers) };
});

app.get<{ Params: { id: string; name: string } }>("/api/servers/:id/player-head/:name", async (request, reply) => {
  await requireRequestPermission(request, "servers.view");
  if (!services.playerHeadService.enabled()) {
    return reply.code(404).send(apiErrorResponse("PLAYER_HEADS_DISABLED", "Player heads are disabled"));
  }
  const server = await getServer(request.params.id);
  const snapshot = services.playerSnapshotCoordinator?.latest(server.id);
  const names = snapshot?.state === "live" || snapshot?.state === "stale" ? snapshot.names : [];
  const requestedName = request.params.name.trim();
  const currentPlayerName = names.find((name) => name.toLocaleLowerCase("en-US") === requestedName.toLocaleLowerCase("en-US"));
  const now = Date.now();
  const recentEvents = currentPlayerName
    ? []
    : services.timelineEventsRepository.list(server.id, now - timelineHistoryWindowMs, now);
  const playerName = currentPlayerName ?? (timelinePlayerIsKnown(recentEvents, requestedName) ? requestedName : undefined);
  if (!playerName) {
    return reply.code(404).send(apiErrorResponse("PLAYER_HEAD_NOT_AVAILABLE", "Player head is not available"));
  }
  const bytes = await services.playerHeadService.head(playerName);
  if (!bytes) {
    return reply.code(503).send(apiErrorResponse("PLAYER_HEAD_UNAVAILABLE", "Player head is temporarily unavailable"));
  }
  reply.header("Content-Type", "image/png");
  reply.header("Cache-Control", "private, max-age=3600, must-revalidate");
  reply.header("X-Content-Type-Options", "nosniff");
  return reply.send(bytes);
});

}
