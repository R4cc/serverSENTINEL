import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHttpRequest = vi.hoisted(() => vi.fn());
const mockInspect = vi.hoisted(() => vi.fn());
vi.mock("../runtime/local/dockerContainers.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../runtime/local/dockerContainers.js")>(),
  inspectDockerContainer: mockInspect
}));

vi.mock("node:http", () => ({ default: { request: mockHttpRequest } }));
vi.mock("../docker/dockerClient.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../docker/dockerClient.js")>(),
  dockerAvailable: () => true
}));

import {
  dockerFollowInitialTail,
  dockerFollowRetryMs,
  resourceStatsHistoryWindow,
  streamDockerLogs,
  timelineHistoryWindow
} from "./overview.js";
import type { ConsoleUpstream } from "./consoleChannel.js";
import type { ManagedServer } from "../types.js";

type PendingDockerRequest = {
  options: RequestOptions;
  respond(statusCode: number): IncomingMessage;
};

function recordDockerRequests() {
  const pending: PendingDockerRequest[] = [];
  mockHttpRequest.mockImplementation((options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const request = new EventEmitter() as ClientRequest;
    request.end = vi.fn() as ClientRequest["end"];
    request.destroy = vi.fn() as ClientRequest["destroy"];
    pending.push({
      options,
      respond: (statusCode) => {
        const response = new EventEmitter() as IncomingMessage;
        response.statusCode = statusCode;
        response.resume = vi.fn() as IncomingMessage["resume"];
        callback(response);
        return response;
      }
    });
    return request;
  });
  return pending;
}

function dockerFrame(text: string) {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function consoleUpstream() {
  return {
    write: vi.fn(),
    notice: vi.fn(),
    unavailable: vi.fn(),
    empty: vi.fn()
  } satisfies ConsoleUpstream;
}

const dockerServer = {
  id: "imported-server",
  displayName: "Imported server",
  dockerContainer: "serversentinel-imported-server"
} as ManagedServer;

beforeEach(() => {
  vi.useFakeTimers();
  mockHttpRequest.mockReset();
  mockInspect.mockReset().mockResolvedValue({ Id: "container-a" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("overview history retention", () => {
  it("retains resource samples and timeline events for seven days", () => {
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(resourceStatsHistoryWindow).toBe(sevenDays);
    expect(timelineHistoryWindow).toBe(sevenDays);
  });
});

describe("Docker console following", () => {
  it("recovers a burst written during disconnection exactly once, including identical timestamped records", async () => {
    const requests = recordDockerRequests();
    const upstream = consoleUpstream();
    const stop = streamDockerLogs(dockerServer, upstream);
    await vi.advanceTimersByTimeAsync(0);
    const history = ["2026-09-05T12:00:00.123456789Z repeated\n"];
    const serve = (index: number) => {
      const query = new URL(`http://docker${requests[index].options.path}`).searchParams;
      const since = Number(query.get("since") ?? 0);
      const tail = query.get("tail");
      const response = requests[index].respond(200);
      const eligible = history.filter((line) => Date.parse(line.split(" ")[0]) / 1000 >= since);
      const selected = tail === "all" ? eligible : eligible.slice(-Number(tail));
      for (const line of selected) response.emit("data", dockerFrame(line));
      return response;
    };
    serve(0).emit("aborted");
    // The workload writes while no follower exists, not after the replacement stream opens.
    history.push(history[0]);
    for (let i = 0; i < 350; i++) history.push(`2026-09-05T12:00:01.000000001Z startup ${i}\n`);
    await vi.advanceTimersByTimeAsync(dockerFollowRetryMs);
    expect(requests[1].options.path).toContain("since=1788609599");
    serve(1).emit("end");
    await vi.advanceTimersByTimeAsync(dockerFollowRetryMs);
    serve(2);
    expect(upstream.write.mock.calls.map(([text]) => text)).toEqual(history.map((line) => line.slice(line.indexOf(" ") + 1)));
    expect(upstream.notice).toHaveBeenCalledTimes(1);
    stop?.();
  });

  it("resets replay on replacement without requiring a 404 and pins each request to its ID", async () => {
    const requests = recordDockerRequests();
    const upstream = consoleUpstream();
    const stop = streamDockerLogs(dockerServer, upstream);
    await vi.advanceTimersByTimeAsync(0);
    const initial = requests[0].respond(200);
    const line = "2026-09-05T12:00:00.123456789Z startup\n";
    initial.emit("data", dockerFrame(line));
    initial.emit("end");
    mockInspect.mockResolvedValue({ Id: "container-b" });
    await vi.advanceTimersByTimeAsync(dockerFollowRetryMs);
    expect(requests[1].options.path).toContain("/containers/container-b/logs?");
    expect(requests[1].options.path).toContain("tail=all");
    expect(requests[1].options.path).not.toContain("since=");
    requests[1].respond(200).emit("data", dockerFrame(line));
    expect(upstream.write.mock.calls).toEqual([["startup\n"], ["startup\n"]]);
    stop?.();
  });

  it("recovers a fragmented UTF-8 record after abrupt close and cancels pending retries", async () => {
    const requests = recordDockerRequests();
    const upstream = consoleUpstream();
    const stop = streamDockerLogs(dockerServer, upstream);
    await vi.advanceTimersByTimeAsync(0);
    const response = requests[0].respond(200);
    const record = Buffer.from("2026-09-05T12:00:00.123456789Z héllo\n");
    response.emit("data", dockerFrame(record.subarray(0, 33).toString()));
    response.emit("close");
    await vi.advanceTimersByTimeAsync(dockerFollowRetryMs);
    const resumed = requests[1].respond(200);
    // Raw TTY output can split inside a UTF-8 code point as well as a timestamp.
    const split = record.indexOf(Buffer.from("é")) + 1;
    resumed.emit("data", record.subarray(0, split));
    resumed.emit("data", record.subarray(split));
    expect(upstream.write.mock.calls).toEqual([["héllo\n"]]);
    resumed.emit("end");
    stop?.();
    await vi.advanceTimersByTimeAsync(dockerFollowRetryMs);
    expect(requests).toHaveLength(2);
  });

  it("keeps the cursor through inspect failures and a transient log 404", async () => {
    const requests = recordDockerRequests();
    const upstream = consoleUpstream();
    const stop = streamDockerLogs(dockerServer, upstream);
    await vi.advanceTimersByTimeAsync(0);
    const initial = requests[0].respond(200);
    initial.emit("data", dockerFrame("2026-09-05T12:00:00.000000001Z before\n"));
    initial.emit("end");
    mockInspect.mockRejectedValueOnce(new Error("Docker offline"));
    await vi.advanceTimersByTimeAsync(dockerFollowRetryMs);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(dockerFollowRetryMs);
    requests[1].respond(404);
    await vi.advanceTimersByTimeAsync(dockerFollowRetryMs);
    expect(requests[2].options.path).toBe(requests[1].options.path);
    const response = requests[2].respond(200);
    response.emit("data", dockerFrame("2026-09-05T12:00:00.000000001Z before\n2026-09-05T12:00:01.000000001Z during outage\n"));
    expect(upstream.write.mock.calls).toEqual([["before\n"], ["during outage\n"]]);
    stop?.();
  });

  it("replays all output after an empty first connection and stops during inspection", async () => {
    const requests = recordDockerRequests();
    const upstream = consoleUpstream();
    const stop = streamDockerLogs(dockerServer, upstream);
    await vi.advanceTimersByTimeAsync(0);
    requests[0].respond(200).emit("end");
    await vi.advanceTimersByTimeAsync(dockerFollowRetryMs);
    expect(requests[1].options.path).toContain("tail=all");
    expect(requests[1].options.path).toContain("since=0");
    requests[1].respond(200).emit("end");
    let resolveInspect!: (value: { Id: string }) => void;
    mockInspect.mockReturnValueOnce(new Promise((resolve) => { resolveInspect = resolve; }));
    await vi.advanceTimersByTimeAsync(dockerFollowRetryMs);
    stop?.();
    resolveInspect({ Id: "container-a" });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(2);
  });

  it("waits through a pre-container 404 and still requests the startup history", async () => {
    const requests = recordDockerRequests();
    const upstream = consoleUpstream();
    const stop = streamDockerLogs(dockerServer, upstream);
    await vi.advanceTimersByTimeAsync(0);

    expect(requests[0].options.path).toContain(`tail=${dockerFollowInitialTail}`);
    const missing = requests[0].respond(404);
    expect(missing.resume).toHaveBeenCalled();
    expect(upstream.unavailable).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(dockerFollowRetryMs);
    expect(requests[1].options.path).toContain(`tail=${dockerFollowInitialTail}`);
    const started = requests[1].respond(200);
    started.emit("data", dockerFrame("first startup line\n"));

    expect(upstream.write).toHaveBeenCalledWith("first startup line\n");
    expect(upstream.notice).not.toHaveBeenCalled();
    stop?.();
  });

  it("announces a reattach only when output actually resumes", async () => {
    const requests = recordDockerRequests();
    const upstream = consoleUpstream();
    const stop = streamDockerLogs(dockerServer, upstream);
    await vi.advanceTimersByTimeAsync(0);

    const initial = requests[0].respond(200);
    initial.emit("data", dockerFrame("before stop\n"));
    initial.emit("end");

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await vi.advanceTimersByTimeAsync(dockerFollowRetryMs);
      expect(requests[attempt].options.path).toContain("tail=all");
      const stopped = requests[attempt].respond(200);
      stopped.emit("end");
    }

    expect(upstream.notice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(dockerFollowRetryMs);
    const restarted = requests[3].respond(200);
    restarted.emit("data", dockerFrame("after restart\n"));
    restarted.emit("data", dockerFrame("still running\n"));

    expect(upstream.notice).toHaveBeenCalledTimes(1);
    expect(upstream.write).toHaveBeenCalledWith("after restart\n");
    expect(upstream.write).toHaveBeenCalledWith("still running\n");
    stop?.();
  });
});
