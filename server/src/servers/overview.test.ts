import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHttpRequest = vi.hoisted(() => vi.fn());

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
  it("waits through a pre-container 404 and still requests the startup history", () => {
    const requests = recordDockerRequests();
    const upstream = consoleUpstream();
    const stop = streamDockerLogs(dockerServer, upstream);

    expect(requests[0].options.path).toContain(`tail=${dockerFollowInitialTail}`);
    const missing = requests[0].respond(404);
    expect(missing.resume).toHaveBeenCalled();
    expect(upstream.unavailable).not.toHaveBeenCalled();

    vi.advanceTimersByTime(dockerFollowRetryMs);
    expect(requests[1].options.path).toContain(`tail=${dockerFollowInitialTail}`);
    const started = requests[1].respond(200);
    started.emit("data", dockerFrame("first startup line\n"));

    expect(upstream.write).toHaveBeenCalledWith("first startup line\n");
    expect(upstream.notice).not.toHaveBeenCalled();
    stop?.();
  });

  it("announces a reattach only when output actually resumes", () => {
    const requests = recordDockerRequests();
    const upstream = consoleUpstream();
    const stop = streamDockerLogs(dockerServer, upstream);

    const initial = requests[0].respond(200);
    initial.emit("data", dockerFrame("before stop\n"));
    initial.emit("end");

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      vi.advanceTimersByTime(dockerFollowRetryMs);
      expect(requests[attempt].options.path).toContain("tail=0");
      const stopped = requests[attempt].respond(200);
      stopped.emit("end");
    }

    expect(upstream.notice).not.toHaveBeenCalled();
    vi.advanceTimersByTime(dockerFollowRetryMs);
    const restarted = requests[3].respond(200);
    restarted.emit("data", dockerFrame("after restart\n"));
    restarted.emit("data", dockerFrame("still running\n"));

    expect(upstream.notice).toHaveBeenCalledTimes(1);
    expect(upstream.write).toHaveBeenCalledWith("after restart\n");
    expect(upstream.write).toHaveBeenCalledWith("still running\n");
    stop?.();
  });
});
