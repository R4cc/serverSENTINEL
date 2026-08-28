import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ManagedServer, Permission, ScheduledActiveRun, ScheduledExecution, ScheduledRun } from "../types.js";
import { registerScheduleRoutes } from "./scheduleRoutes.js";

const serverId = "11111111-1111-1111-1111-111111111111";
const scheduleId = "22222222-2222-2222-2222-222222222222";
const runId = "33333333-3333-3333-3333-333333333333";

function schedule(overrides: Partial<ScheduledExecution> = {}): ScheduledExecution {
  return {
    id: scheduleId,
    name: "Nightly restart",
    cron: "0 4 * * *",
    steps: [{ type: "action", procedure: "restart", delaySeconds: 0 }],
    onlyWhenNoPlayers: false,
    waitForPlayersToLeave: false,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function completedRun(overrides: Partial<ScheduledRun> = {}): ScheduledRun {
  return {
    id: runId,
    scheduleId,
    scheduleName: "Nightly restart",
    status: "success",
    ranAt: "2026-01-01T04:00:00.000Z",
    details: {
      stepCount: 1,
      completedStepCount: 1,
      steps: [{
        stepIndex: 0,
        type: "command",
        command: "save-all",
        delaySeconds: 0,
        status: "success",
        startedAt: "2026-01-01T04:00:00.000Z",
        logs: ["[12:00:00] [Server thread/INFO]: Saved the game"],
        logCaptureStatus: "captured"
      }]
    },
    ...overrides
  };
}

function activeRun(overrides: Partial<ScheduledActiveRun> = {}): ScheduledActiveRun {
  return {
    id: runId,
    scheduleId,
    scheduleName: "Nightly restart",
    status: "running",
    startedAt: "2026-01-01T04:00:00.000Z",
    stepCount: 1,
    cancellable: true,
    ...overrides
  };
}

function testApp(options: {
  schedules?: ScheduledExecution[];
  parsedSchedule?: ScheduledExecution;
  startResult?: ScheduledActiveRun | false;
  cancelResult?: ScheduledActiveRun | null | false;
  cancelRunsForScheduleResult?: boolean;
} = {}) {
  const app = Fastify();
  const permissions: Permission[] = [];
  let destructiveRateLimitCalls = 0;
  const server = { id: serverId, schedules: options.schedules ?? [schedule()] } as ManagedServer;
  const parsedSchedule = options.parsedSchedule ?? schedule();
  const createSchedule = vi.fn();
  const updateSchedule = vi.fn();
  const deleteSchedule = vi.fn();
  const parseSchedule = vi.fn(() => parsedSchedule);
  const publicSchedule = vi.fn((_serverId: string, value: ScheduledExecution) => ({ ...value, activeRuns: [] }));
  const findScheduledRun = vi.fn((_server: ManagedServer, scheduleId: string, runId: string) =>
    (options.schedules ?? [schedule()]).find((candidate) => candidate.id === scheduleId)?.recentRuns?.find((run) => run.id === runId));
  const startScheduleExecution = vi.fn(() => options.startResult === false ? undefined : options.startResult ?? activeRun());
  const cancelActiveScheduleRunsForSchedule = vi.fn(() => options.cancelRunsForScheduleResult ?? true);
  const cancelActiveScheduleRun = vi.fn(() => options.cancelResult === false ? undefined : options.cancelResult === null ? null : options.cancelResult ?? activeRun());
  const logInfo = vi.fn();

  registerScheduleRoutes(app, {
    destructiveRateLimit: {
      preHandler: async () => {
        destructiveRateLimitCalls += 1;
      }
    },
    requireRequestPermission: async (_request, permission) => {
      permissions.push(permission);
    },
    getServer: vi.fn(async () => server),
    parseSchedule,
    publicSchedule,
    findScheduledRun,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    startScheduleExecution,
    cancelActiveScheduleRun,
    cancelActiveScheduleRunsForSchedule,
    serverLogFields: () => ({ serverId }),
    logInfo
  });

  return {
    app,
    permissions,
    server,
    parseSchedule,
    publicSchedule,
    findScheduledRun,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    startScheduleExecution,
    cancelActiveScheduleRun,
    cancelActiveScheduleRunsForSchedule,
    logInfo,
    destructiveRateLimitCalls: () => destructiveRateLimitCalls
  };
}

describe("schedule routes", () => {
  it("lists public schedules with the view permission", async () => {
    const harness = testApp();

    const response = await harness.app.inject({ method: "GET", url: `/api/servers/${serverId}/schedules` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ schedules: [{ ...schedule(), activeRuns: [] }] });
    expect(harness.permissions).toEqual(["schedules.view"]);
    expect(harness.publicSchedule).toHaveBeenCalledWith(serverId, schedule());
  });

  it("validates and persists a created schedule under the destructive route options", async () => {
    const created = schedule({ name: "Created schedule" });
    const harness = testApp({ parsedSchedule: created });
    const body = { name: "Created schedule", cron: "0 5 * * *", steps: created.steps, enabled: true };

    const response = await harness.app.inject({ method: "POST", url: `/api/servers/${serverId}/schedules`, payload: body });

    expect(response.statusCode).toBe(200);
    // Projected, not echoed: the parsed schedule can carry retained run history with captured logs.
    expect(response.json()).toEqual({ ...created, activeRuns: [] });
    expect(harness.publicSchedule).toHaveBeenCalledWith(serverId, created);
    expect(harness.destructiveRateLimitCalls()).toBe(1);
    expect(harness.permissions).toEqual(["schedules.manage"]);
    expect(harness.parseSchedule).toHaveBeenCalledWith(body);
    expect(harness.createSchedule).toHaveBeenCalledWith(serverId, created, created.updatedAt);
    expect(harness.logInfo).toHaveBeenCalledWith(expect.objectContaining({ action: "create_schedule", scheduleId }), "Schedule created");
  });

  it("validates and persists an update against the existing schedule", async () => {
    const existing = schedule();
    const updated = schedule({ name: "Updated schedule", updatedAt: "2026-01-02T00:00:00.000Z" });
    const harness = testApp({ schedules: [existing], parsedSchedule: updated });
    const body = { name: "Updated schedule", cron: existing.cron, steps: updated.steps };

    const response = await harness.app.inject({ method: "PUT", url: `/api/servers/${serverId}/schedules/${scheduleId}`, payload: body });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...updated, activeRuns: [] });
    expect(harness.publicSchedule).toHaveBeenCalledWith(serverId, updated);
    expect(harness.parseSchedule).toHaveBeenCalledWith(body, existing);
    expect(harness.updateSchedule).toHaveBeenCalledWith(serverId, updated, updated.updatedAt);
  });

  it("returns the same not-found response for stale update and delete actions", async () => {
    const harness = testApp({ schedules: [] });
    const updateResponse = await harness.app.inject({
      method: "PUT",
      url: `/api/servers/${serverId}/schedules/${scheduleId}`,
      payload: { name: "Missing", cron: "0 5 * * *", steps: [] }
    });
    const deleteResponse = await harness.app.inject({ method: "DELETE", url: `/api/servers/${serverId}/schedules/${scheduleId}` });

    expect(updateResponse.statusCode).toBe(404);
    expect(updateResponse.json().error.code).toBe("SCHEDULE_NOT_FOUND");
    expect(deleteResponse.statusCode).toBe(404);
    expect(deleteResponse.json().error.code).toBe("SCHEDULE_NOT_FOUND");
    expect(harness.updateSchedule).not.toHaveBeenCalled();
    expect(harness.deleteSchedule).not.toHaveBeenCalled();
  });

  it("deletes a validated schedule and updates the server timestamp", async () => {
    const harness = testApp();

    const response = await harness.app.inject({ method: "DELETE", url: `/api/servers/${serverId}/schedules/${scheduleId}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(harness.permissions).toEqual(["schedules.manage"]);
    expect(harness.deleteSchedule).toHaveBeenCalledWith(serverId, scheduleId, expect.any(String));
    expect(harness.cancelActiveScheduleRunsForSchedule).toHaveBeenCalledWith(serverId, scheduleId);
  });

  // Deleting the row takes away the active run's only cancel control, so the run has to be stopped
  // with it. A run already past its point of no return blocks the delete instead of being stranded.
  it("cancels the active runs of a schedule before deleting it", async () => {
    const harness = testApp();

    await harness.app.inject({ method: "DELETE", url: `/api/servers/${serverId}/schedules/${scheduleId}` });

    expect(harness.cancelActiveScheduleRunsForSchedule.mock.invocationCallOrder[0])
      .toBeLessThan(harness.deleteSchedule.mock.invocationCallOrder[0]);
  });

  it("refuses to delete a schedule whose Restart step has already started", async () => {
    const harness = testApp({ cancelRunsForScheduleResult: false });

    const response = await harness.app.inject({ method: "DELETE", url: `/api/servers/${serverId}/schedules/${scheduleId}` });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("SCHEDULE_RUN_NOT_CANCELLABLE");
    expect(harness.deleteSchedule).not.toHaveBeenCalled();
  });

  it("starts an injected tracked execution and returns 202", async () => {
    const run = activeRun();
    const harness = testApp({ startResult: run });

    const response = await harness.app.inject({ method: "POST", url: `/api/servers/${serverId}/schedules/${scheduleId}/run` });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ run });
    expect(harness.startScheduleExecution).toHaveBeenCalledWith(harness.server, schedule());
    expect(harness.logInfo).toHaveBeenCalledWith(expect.objectContaining({ action: "run_schedule_now", runId }), "Schedule test run started");
  });

  it("preserves missing and already-running execution responses", async () => {
    const missing = testApp({ schedules: [] });
    const missingResponse = await missing.app.inject({ method: "POST", url: `/api/servers/${serverId}/schedules/${scheduleId}/run` });
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.json()).toEqual({ error: { code: "SCHEDULE_NOT_FOUND", message: "Schedule not found", details: {} } });

    const running = testApp({ startResult: false });
    const runningResponse = await running.app.inject({ method: "POST", url: `/api/servers/${serverId}/schedules/${scheduleId}/run` });
    expect(runningResponse.statusCode).toBe(409);
    expect(runningResponse.json()).toEqual({ error: { code: "SCHEDULE_ALREADY_RUNNING", message: "Schedule is already running", details: {} } });
  });

  it("returns a successfully requested cancellation", async () => {
    const run = activeRun({ message: "Cancellation requested" });
    const harness = testApp({ cancelResult: run });

    const response = await harness.app.inject({ method: "POST", url: `/api/servers/${serverId}/schedules/${scheduleId}/runs/${runId}/cancel` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ run });
    expect(harness.cancelActiveScheduleRun).toHaveBeenCalledWith(serverId, scheduleId, runId);
    expect(harness.logInfo).toHaveBeenCalledWith(expect.objectContaining({ action: "cancel_schedule_run", runId }), "Schedule run cancellation requested");
  });

  it("preserves non-cancellable and missing active-run responses", async () => {
    const blocked = testApp({ cancelResult: null });
    const blockedResponse = await blocked.app.inject({ method: "POST", url: `/api/servers/${serverId}/schedules/${scheduleId}/runs/${runId}/cancel` });
    expect(blockedResponse.statusCode).toBe(409);
    expect(blockedResponse.json()).toEqual({
      error: { code: "SCHEDULE_RUN_NOT_CANCELLABLE", message: "The Restart step has started and must finish before this run can end", details: {} }
    });

    const missing = testApp({ cancelResult: false });
    const missingResponse = await missing.app.inject({ method: "POST", url: `/api/servers/${serverId}/schedules/${scheduleId}/runs/${runId}/cancel` });
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.json()).toEqual({ error: { code: "SCHEDULE_RUN_NOT_FOUND", message: "Active schedule run not found", details: {} } });
  });

  it("serves the captured console output the run lists omit", async () => {
    const run = completedRun();
    const harness = testApp({ schedules: [schedule({ recentRuns: [run] })] });

    const response = await harness.app.inject({ method: "GET", url: `/api/servers/${serverId}/schedules/${scheduleId}/runs/${runId}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ run });
    expect(response.json().run.details.steps[0].logs).toEqual(["[12:00:00] [Server thread/INFO]: Saved the game"]);
    expect(harness.permissions).toEqual(["schedules.view"]);
  });

  it("reports a missing run rather than an empty detail payload", async () => {
    const harness = testApp({ schedules: [schedule({ recentRuns: [] })] });

    const response = await harness.app.inject({ method: "GET", url: `/api/servers/${serverId}/schedules/${scheduleId}/runs/${runId}` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "SCHEDULE_RUN_NOT_FOUND", message: "Schedule run not found", details: {} } });
  });
});
