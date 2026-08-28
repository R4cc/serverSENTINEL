import { describe, expect, it } from "vitest";
import type { OperationRecord, ScheduledRun, ServerEvent, ServerTimelineEvent } from "../types.js";
import { persistentServerEvents } from "./serverEvents.js";

function event(id: string, timestamp: string, overrides: Partial<ServerEvent> = {}): ServerTimelineEvent {
  return {
    id,
    eventType: "player_joined",
    type: "success",
    severity: "success",
    text: "Alex joined",
    message: "Alex joined",
    timestamp,
    occurredAt: new Date(timestamp).getTime(),
    signature: "player_joined:alex",
    source: "logs/latest.log",
    subject: "Alex",
    ...overrides
  };
}

function operation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: "operation-1",
    type: "server.restart",
    status: "succeeded",
    serverId: "server-1",
    progress: 100,
    task: "Server restarted",
    createdAt: "2026-08-28T11:59:00.000Z",
    finishedAt: "2026-08-28T12:00:00.000Z",
    result: { reason: "Apply the updated configuration" },
    ...overrides
  };
}

function scheduledRun(overrides: Partial<ScheduledRun> = {}): ScheduledRun {
  return {
    id: "run-1",
    scheduleId: "schedule-1",
    scheduleName: "Nightly backup",
    status: "success",
    message: "All steps completed",
    ranAt: "2026-08-28T11:30:00.000Z",
    ...overrides
  };
}

describe("persistent server events", () => {
  it("keeps persisted timeline events and removes their transient duplicate", () => {
    const persisted = event("persisted", "2026-08-28T12:00:00.000Z");
    const transient = { ...persisted, id: "transient" };

    const result = persistentServerEvents({ timelineEvents: [persisted], transientEvents: [transient] });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("transient");
  });

  it("adds restart and stop purposes from durable operations", () => {
    const result = persistentServerEvents({
      timelineEvents: [],
      operations: [
        operation(),
        operation({ id: "operation-2", type: "server.stop", status: "failed", errorMessage: "Runtime unavailable", result: { reason: "Emergency maintenance" } })
      ]
    });

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "server_restarted", text: "Server restarted", details: "Purpose: Apply the updated configuration" }),
      expect.objectContaining({ eventType: "server_stopped", severity: "error", details: "Purpose: Emergency maintenance · Runtime unavailable" })
    ]));
  });

  it("omits legacy runtime operations that have no purpose", () => {
    expect(persistentServerEvents({
      timelineEvents: [],
      operations: [operation({ result: undefined })]
    })).toEqual([]);
  });

  it("adds persisted automation runs and orders the unified history newest first", () => {
    const result = persistentServerEvents({
      timelineEvents: [event("player", "2026-08-28T11:00:00.000Z")],
      scheduledRuns: [scheduledRun()]
    });

    expect(result.map((item) => item.eventType)).toEqual(["automation_run", "player_joined"]);
    expect(result[0]).toMatchObject({
      source: "schedules",
      text: "Nightly backup completed",
      details: "All steps completed"
    });
  });
});
