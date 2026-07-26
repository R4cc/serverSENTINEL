import http from "node:http";
import { readFile, stat } from "node:fs/promises";

import { config } from "../config.js";
import { logWarn, errorLogFields } from "../logging.js";
import { dockerAvailable, dockerRequest } from "../docker/dockerClient.js";
import { DockerLogDecoder } from "../docker/dockerLogs.js";
import { configuredServerPort, currentContainerInspect, dockerContainerName, dockerControlConfigured, dockerRecentLogs, inspectDockerContainer, normalizeJavaRuntime, readFileRange, readLatestServerLog, serverLogFields, validDockerTimestamp, type DockerContainerInspect } from "../runtime/local/dockerContainers.js";
import { parseServerProperties } from "../runtime/serverProperties.js";
import { compactRecentEvents, parseLogEvent } from "./logEvents.js";
import { resolveMinecraftQueryEndpoints } from "../queryEndpoint.js";
import { readMinecraftPlayerObservation } from "../playerObservationReader.js";
import { validateExistingInsideServer } from "../core.js";
import type { ManagedServer, ServerActivity, ServerEvent } from "../types.js";
export const consoleHeartbeatIntervalMs = 5_000;

export type Client = {
  send: (payload: string) => void;
  readyState: number;
};

export function startConsoleHeartbeat(client: Client, intervalMs = consoleHeartbeatIntervalMs) {
  const timer = setInterval(() => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: "heartbeat", at: new Date().toISOString() }));
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

export async function serverOverviewData(server: ManagedServer) {
  const dockerConfigured = dockerControlConfigured(server);
  const [fileLog, dockerLog, properties, eula, dockerInspect] = await Promise.allSettled([
    readLatestServerLog(server),
    dockerConfigured ? dockerRecentLogs(server) : Promise.resolve(""),
    validateExistingInsideServer(server, "server.properties").then((path) => readFile(path, "utf8")),
    validateExistingInsideServer(server, "eula.txt").then((path) => readFile(path, "utf8")),
    dockerConfigured ? dockerRequest<DockerContainerInspect>("GET", `/containers/${encodeURIComponent(dockerContainerName(server))}/json`, 200) : Promise.resolve(null)
  ]);
  const logSources: Array<{ source: ServerEvent["source"]; text: string }> = [];
  if (fileLog.status === "fulfilled") logSources.push({ source: "logs/latest.log", text: fileLog.value });
  if (dockerLog.status === "fulfilled" && dockerConfigured) logSources.push({ source: "docker", text: dockerLog.value });
  const eventsStatus = fileLog.status === "fulfilled" || (dockerConfigured && dockerLog.status === "fulfilled") ? "ok" : "unavailable";
  const parsedAt = new Date();
  const parsedEvents = logSources
    .flatMap(({ source, text }) => text.split(/\r?\n/).map((line, index) => parseLogEvent(line, source, index, parsedAt)).filter((event): event is ServerEvent => Boolean(event)));
  const reversedEvents = [...parsedEvents].reverse();
  const events = compactRecentEvents(parsedEvents, 20);
  const props = properties.status === "fulfilled" ? parseServerProperties(properties.value) : {};
  const eulaAccepted = eula.status === "fulfilled"
    ? /^eula\s*=\s*true\s*$/im.test(eula.value)
    : undefined;
  const startedAt = dockerInspect.status === "fulfilled"
    ? validDockerTimestamp(dockerInspect.value?.State?.StartedAt)
    : undefined;
  const stoppedAt = dockerInspect.status === "fulfilled"
    ? validDockerTimestamp(dockerInspect.value?.State?.FinishedAt)
    : undefined;
  const activity: ServerActivity = {
    lastStartedAt: startedAt ?? reversedEvents.find((event) => event.eventType === "server_started")?.timestamp,
    lastStoppedAt: stoppedAt ?? reversedEvents.find((event) => event.eventType === "server_stopped")?.timestamp,
    currentWorld: props["level-name"],
    serverPort: configuredServerPort(server, props),
    eulaAccepted,
    javaRuntime: normalizeJavaRuntime(server)
  };
  return { events, eventsStatus, activity };
}

export async function readLocalPlayerObservation(server: ManagedServer) {
  const path = await validateExistingInsideServer(server, "server.properties").catch(() => "");
  const props = path ? parseServerProperties(await readFile(path, "utf8")) : {};
  const minecraftInspect = dockerControlConfigured(server) ? await inspectDockerContainer(server).catch(() => null) : null;
  const running = minecraftInspect?.State?.Running === true;
  const callerInspect = running && dockerAvailable() ? await currentContainerInspect().catch(() => null) : null;
  const [endpoint = null, ...fallbackEndpoints] = running ? resolveMinecraftQueryEndpoints(server, props, minecraftInspect, callerInspect) : [];
  const instanceId = minecraftInspect?.Id
    ? `${minecraftInspect.Id}:${minecraftInspect.State?.StartedAt ?? "not-started"}`
    : undefined;
  return readMinecraftPlayerObservation({ running, instanceId, props, endpoint, fallbackEndpoints });
}

export function streamLatestServerLog(server: ManagedServer, client: Client) {
  let offset = 0;
  let closed = false;
  let announcedEmpty = false;
  let lastLoggedError = "";
  let inFlight = false;

  const send = (text: string) => {
    if (text && client.readyState === 1) {
      client.send(JSON.stringify({ type: "log", source: "latest.log", text, at: new Date().toISOString() }));
    }
  };

  const poll = async () => {
    if (closed || inFlight) return;
    inFlight = true;
    try {
      const logPath = await validateExistingInsideServer(server, "logs/latest.log");
      const logStat = await stat(logPath);
      if (!logStat.isFile()) {
        client.send(JSON.stringify({ type: "unavailable", message: "logs/latest.log is not a file" }));
        return;
      }

      if (logStat.size < offset) {
        offset = 0;
      }

      if (logStat.size > offset) {
        const start = offset === 0 ? Math.max(0, logStat.size - 128 * 1024) : offset;
        const chunk = await readFileRange(logPath, start, logStat.size - 1);
        offset = logStat.size;
        send(chunk.toString("utf8"));
      } else if (offset === 0 && !announcedEmpty) {
        offset = logStat.size;
        announcedEmpty = true;
        client.send(JSON.stringify({
          type: "empty",
          source: "latest.log",
          text: "logs/latest.log is empty.",
          at: new Date().toISOString()
        }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to read logs/latest.log";
      if (message !== lastLoggedError) {
        lastLoggedError = message;
        logWarn({ ...serverLogFields(server), source: "logs/latest.log", ...errorLogFields(error) }, "Console file log stream unavailable");
      }
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "unavailable", message }));
      }
    } finally {
      inFlight = false;
    }
  };

  void poll();
  const interval = setInterval(() => void poll(), 1_000);
  return () => {
    closed = true;
    clearInterval(interval);
  };
}

export function streamDockerLogs(server: ManagedServer, client: Client) {
  if (!dockerControlConfigured(server) || !dockerAvailable()) {
    logWarn({ ...serverLogFields(server), source: "docker" }, "Docker log stream unavailable");
    client.send(JSON.stringify({ type: "unavailable", message: "Docker logs are not configured for this server" }));
    return undefined;
  }

  const request = http.request(
    {
      socketPath: config.dockerSocket,
      path: `/containers/${encodeURIComponent(dockerContainerName(server))}/logs?stdout=1&stderr=1&tail=200&follow=1`,
      method: "GET"
    },
    (response) => {
      if (response.statusCode !== 200) {
        logWarn({ ...serverLogFields(server), source: "docker", statusCode: response.statusCode }, "Docker log stream returned non-OK status");
        client.send(JSON.stringify({ type: "unavailable", message: `Docker logs returned ${response.statusCode}` }));
        return;
      }
      const decoder = new DockerLogDecoder();
      response.on("data", (chunk: Buffer) => {
        const text = decoder.write(chunk).toString("utf8");
        if (text && client.readyState === 1) {
          client.send(JSON.stringify({ type: "log", source: "docker", text, at: new Date().toISOString() }));
        }
      });
    }
  );
  request.on("error", (error) => {
    logWarn({ ...serverLogFields(server), source: "docker", ...errorLogFields(error) }, "Docker log stream failed");
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: "unavailable", message: error.message }));
    }
  });
  request.end();
  return request;
}

export const resourceStatsHistoryWindow = 24 * 60 * 60 * 1000;
export const timelineHistoryWindow = 24 * 60 * 60 * 1000;
