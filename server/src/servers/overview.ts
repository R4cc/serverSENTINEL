import http from "node:http";
import { readFile, stat } from "node:fs/promises";

import { config } from "../config.js";
import { logWarn, errorLogFields } from "../logging.js";
import { dockerAvailable, dockerRequest } from "../docker/dockerClient.js";
import { DockerLogDecoder } from "../docker/dockerLogs.js";
import { DockerLogResume } from "../docker/dockerLogResume.js";
import { configuredServerPort, currentContainerInspect, dockerContainerName, dockerControlConfigured, dockerRecentLogs, inspectDockerContainer, normalizeJavaRuntime, readFileRange, readLatestServerLog, serverLogFields, validDockerTimestamp, type DockerContainerInspect } from "../runtime/local/dockerContainers.js";
import { parseServerProperties } from "../runtime/serverProperties.js";
import { compactRecentEvents, parseLogEvent } from "./logEvents.js";
import { resolveMinecraftQueryEndpoints } from "../queryEndpoint.js";
import { readMinecraftPlayerObservation } from "../playerObservationReader.js";
import { validateExistingInsideServer } from "../core.js";
import { type BackpressuredClient } from "./consoleBackpressure.js";
import type { ConsoleUpstream } from "./consoleChannel.js";
import type { ManagedServer, ServerActivity, ServerEvent } from "../types.js";
const consoleHeartbeatIntervalMs = 5_000;

export type Client = BackpressuredClient;

/**
 * Growth between two polls is bounded so a workload that writes faster than the poll interval cannot
 * turn one `readFileRange` into an arbitrarily large allocation. Skipping ahead loses the middle of a
 * burst, which the viewer is told about, rather than allocating all of it.
 */
const consoleLogPollMaxBytes = 1024 * 1024;

/** History requested on the first attachment. Reconnects replay from a timestamp. */
export const dockerFollowInitialTail = 200;
export const dockerFollowRetryMs = 1_000;

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
    lastStartedAt: startedAt ?? parsedEvents.findLast((event) => event.eventType === "server_started")?.timestamp,
    lastStoppedAt: stoppedAt ?? parsedEvents.findLast((event) => event.eventType === "server_stopped")?.timestamp,
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

export function streamLatestServerLog(server: ManagedServer, upstream: ConsoleUpstream) {
  let offset = 0;
  let closed = false;
  let announcedEmpty = false;
  let lastLoggedError = "";
  let inFlight = false;

  const poll = async () => {
    if (closed || inFlight) return;
    inFlight = true;
    try {
      const logPath = await validateExistingInsideServer(server, "logs/latest.log");
      const logStat = await stat(logPath);
      if (!logStat.isFile()) {
        upstream.unavailable("logs/latest.log is not a file");
        return;
      }

      if (logStat.size < offset) {
        offset = 0;
      }

      if (logStat.size > offset) {
        const initialStart = offset === 0 ? Math.max(0, logStat.size - 128 * 1024) : offset;
        const skipped = Math.max(0, logStat.size - initialStart - consoleLogPollMaxBytes);
        const start = initialStart + skipped;
        const chunk = await readFileRange(logPath, start, logStat.size - 1);
        offset = logStat.size;
        if (skipped > 0) {
          // Numbered in place rather than sent as a side-channel frame, so the gap keeps its
          // position in the console instead of arriving wherever the viewer happens to be.
          upstream.notice(`[serverSENTINEL] Skipped ${skipped} bytes of logs/latest.log written faster than the console could read them.`);
        }
        upstream.write(chunk.toString("utf8"));
      } else if (offset === 0 && !announcedEmpty) {
        offset = logStat.size;
        announcedEmpty = true;
        upstream.empty("logs/latest.log is empty.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to read logs/latest.log";
      if (message !== lastLoggedError) {
        lastLoggedError = message;
        logWarn({ ...serverLogFields(server), source: "logs/latest.log", ...errorLogFields(error) }, "Console file log stream unavailable");
      }
      upstream.unavailable(message);
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

/**
 * Follows a container's output into the server's console buffer.
 *
 * The follow ends whenever the container does, which a restart makes routine, so it reattaches
 * instead of leaving the console silent until someone reloads the page. Timestamp overlap
 * recovers output written during the outage, with counted deduplication of retained records.
 */
export function streamDockerLogs(server: ManagedServer, upstream: ConsoleUpstream) {
  if (!dockerControlConfigured(server) || !dockerAvailable()) {
    logWarn({ ...serverLogFields(server), source: "docker" }, "Docker log stream unavailable");
    upstream.unavailable("Docker logs are not configured for this server");
    return undefined;
  }

  let closed = false;
  let hasAttached = false;
  let announceReattachOnOutput = false;
  let containerId: string | undefined;
  let resume = new DockerLogResume();
  let attachedToContainer = false;
  let request: http.ClientRequest | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const reattach = () => {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (closed) return;
      void follow();
    }, dockerFollowRetryMs);
    retryTimer.unref?.();
  };

  const follow = async () => {
    let details: DockerContainerInspect | null;
    try {
      details = await inspectDockerContainer(server);
    } catch (error) {
      if (closed) return;
      upstream.unavailable(error instanceof Error ? error.message : "Unable to inspect Docker container", { retryable: true });
      reattach();
      return;
    }
    if (closed) return;
    if (!details?.Id) { reattach(); return; }
    if (containerId !== details.Id) {
      containerId = details.Id;
      resume = new DockerLogResume();
      attachedToContainer = false;
    }
    // Pin the inspected ID so replacement between inspect and logs cannot reuse an old cursor.
    // Replacements get all startup output, even when it exceeds the initial history tail.
    const tail = hasAttached ? "all" : dockerFollowInitialTail;
    const since = attachedToContainer ? `&since=${resume.since}` : "";
    let finishStream: (() => void) | undefined;
    request = http.request(
      {
        socketPath: config.dockerSocket,
        path: `/containers/${encodeURIComponent(containerId)}/logs?stdout=1&stderr=1&tail=${tail}&follow=1&timestamps=1${since}`,
        method: "GET"
      },
      (response) => {
        if (closed) { response.destroy(); return; }
        if (response.statusCode !== 200) {
          response.resume();
          if (response.statusCode !== 404) {
            logWarn({ ...serverLogFields(server), source: "docker", statusCode: response.statusCode }, "Docker log stream returned non-OK status");
            upstream.unavailable(`Docker logs returned ${response.statusCode}`, { retryable: true });
          }
          reattach();
          return;
        }
        announceReattachOnOutput ||= hasAttached;
        hasAttached = true;
        attachedToContainer = true;
        const decoder = new DockerLogDecoder();
        // No socket pausing here: the buffer is shared, so one viewer falling behind must not stop
        // the workload's output reaching everyone else. Memory stays bounded by the buffer's own
        // retention, and a viewer that falls too far behind is told its resume point was trimmed.
        const records = resume.attachment((text) => {
          if (closed) return;
          if (announceReattachOnOutput) {
            announceReattachOnOutput = false;
            upstream.notice("[serverSENTINEL] Reattached to the container log stream.");
          }
          upstream.write(text);
        });
        let ended = false;
        const activeRequest = request;
        const finish = () => {
          if (ended) return;
          ended = true;
          activeRequest?.destroy();
          reattach();
        };
        finishStream = finish;
        response.on("data", (chunk: Buffer) => {
          if (!closed && !ended) records.write(decoder.write(chunk));
        });
        response.on("end", () => { if (!closed && !ended) records.end(); finish(); });
        response.on("aborted", finish);
        response.on("close", finish);
        response.on("error", (error) => {
          logWarn({ ...serverLogFields(server), source: "docker", ...errorLogFields(error) }, "Docker log stream failed");
          finish();
        });
      }
    );
    request.on("error", (error) => {
      if (closed) return;
      logWarn({ ...serverLogFields(server), source: "docker", ...errorLogFields(error) }, "Docker log stream failed");
      upstream.unavailable(error.message);
      if (finishStream) finishStream();
      else reattach();
    });
    request.end();
  };

  void follow();

  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    request?.destroy();
  };
}

export const resourceStatsHistoryWindow = 7 * 24 * 60 * 60 * 1000;
export const timelineHistoryWindow = 7 * 24 * 60 * 60 * 1000;
