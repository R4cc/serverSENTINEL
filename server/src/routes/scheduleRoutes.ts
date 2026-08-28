import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import type { AuthenticatedRequest } from "../auth/requestAuthentication.js";
import { apiErrorResponse } from "../http/errors.js";
import { validateOperationId, validateScheduleId } from "../http/validation.js";
import type { ManagedServer, Permission, ScheduledActiveRun, ScheduledExecution, ScheduledRun } from "../types.js";

type ScheduleBody = {
  name?: string;
  cron?: string;
  steps?: unknown;
  onlyWhenNoPlayers?: boolean;
  waitForPlayersToLeave?: boolean;
  enabled?: boolean;
};

type ScheduleRoutesContext = {
  destructiveRateLimit: RouteShorthandOptions;
  requireRequestPermission(request: AuthenticatedRequest, permission: Permission): Promise<unknown>;
  getServer(serverId: string): Promise<ManagedServer>;
  parseSchedule(body: ScheduleBody, existing?: ScheduledExecution): ScheduledExecution;
  publicSchedule(serverId: string, schedule: ScheduledExecution): ScheduledExecution;
  findScheduledRun(server: ManagedServer, scheduleId: string, runId: string): ScheduledRun | undefined;
  createSchedule(serverId: string, schedule: ScheduledExecution, serverUpdatedAt: string): void;
  updateSchedule(serverId: string, schedule: ScheduledExecution, serverUpdatedAt: string): void;
  deleteSchedule(serverId: string, scheduleId: string, serverUpdatedAt: string): void;
  startScheduleExecution(server: ManagedServer, schedule: ScheduledExecution): ScheduledActiveRun | undefined;
  cancelActiveScheduleRun(serverId: string, scheduleId: string, runId: string): ScheduledActiveRun | null | undefined;
  cancelActiveScheduleRunsForSchedule(serverId: string, scheduleId: string): boolean;
  serverLogFields(server: ManagedServer): Record<string, unknown>;
  logInfo(fields: Record<string, unknown>, message: string): void;
  withServerMutation?<T>(serverId: string, action: () => Promise<T>): Promise<T>;
};

export function registerScheduleRoutes(app: FastifyInstance, context: ScheduleRoutesContext) {
  const withServerMutation = <T>(serverId: string, action: () => Promise<T>) => context.withServerMutation?.(serverId, action) ?? action();
  app.get<{ Params: { id: string } }>("/api/servers/:id/schedules", async (request) => {
    await context.requireRequestPermission(request, "schedules.view");
    const server = await context.getServer(request.params.id);
    return { schedules: (server.schedules ?? []).map((schedule) => context.publicSchedule(server.id, schedule)) };
  });

  app.post<{ Params: { id: string }; Body: ScheduleBody }>("/api/servers/:id/schedules", context.destructiveRateLimit, async (request) => {
    await context.requireRequestPermission(request, "schedules.manage");
    const server = await context.getServer(request.params.id);
    const createdSchedule = context.parseSchedule(request.body);
    await withServerMutation(server.id, async () => { context.createSchedule(server.id, createdSchedule, createdSchedule.updatedAt); });
    context.logInfo({ ...context.serverLogFields(server), scheduleId: createdSchedule.id, enabled: createdSchedule.enabled, action: "create_schedule" }, "Schedule created");
    return context.publicSchedule(server.id, createdSchedule);
  });

  app.put<{ Params: { id: string; scheduleId: string }; Body: ScheduleBody }>("/api/servers/:id/schedules/:scheduleId", context.destructiveRateLimit, async (request, reply) => {
    await context.requireRequestPermission(request, "schedules.manage");
    const server = await context.getServer(request.params.id);
    const scheduleId = validateScheduleId(request.params.scheduleId);
    const existing = server.schedules?.find((candidate) => candidate.id === scheduleId);
    if (!existing) {
      return reply.code(404).send(apiErrorResponse("SCHEDULE_NOT_FOUND", "Schedule not found"));
    }
    const updatedSchedule = context.parseSchedule(request.body, existing);
    await withServerMutation(server.id, async () => { context.updateSchedule(server.id, updatedSchedule, updatedSchedule.updatedAt); });
    context.logInfo({ ...context.serverLogFields(server), scheduleId: updatedSchedule.id, enabled: updatedSchedule.enabled, action: "update_schedule" }, "Schedule updated");
    // Projected rather than echoed: the parsed schedule carries the retained run history forward
    // from the existing record, captured logs included.
    return context.publicSchedule(server.id, updatedSchedule);
  });

  app.delete<{ Params: { id: string; scheduleId: string } }>("/api/servers/:id/schedules/:scheduleId", context.destructiveRateLimit, async (request, reply) => {
    await context.requireRequestPermission(request, "schedules.manage");
    const server = await context.getServer(request.params.id);
    const scheduleId = validateScheduleId(request.params.scheduleId);
    const existing = server.schedules?.find((candidate) => candidate.id === scheduleId);
    if (!existing) {
      return reply.code(404).send(apiErrorResponse("SCHEDULE_NOT_FOUND", "Schedule not found"));
    }
    // Deleting the schedule takes away the only control that could have stopped its active run, so
    // the run is cancelled first and the delete is refused outright when it cannot be.
    if (!context.cancelActiveScheduleRunsForSchedule(server.id, scheduleId)) {
      return reply.code(409).send(apiErrorResponse("SCHEDULE_RUN_NOT_CANCELLABLE", "The Restart step has started and must finish before this schedule can be deleted"));
    }
    await withServerMutation(server.id, async () => { context.deleteSchedule(server.id, scheduleId, new Date().toISOString()); });
    context.logInfo({ ...context.serverLogFields(server), scheduleId, action: "delete_schedule" }, "Schedule deleted");
    return { ok: true };
  });

  // Serves the captured console output that publicSchedule strips from every run list. The run
  // details dialog is the only consumer, so the cost is paid once per opened run rather than on
  // every app refresh.
  app.get<{ Params: { id: string; scheduleId: string; runId: string } }>("/api/servers/:id/schedules/:scheduleId/runs/:runId", async (request, reply) => {
    await context.requireRequestPermission(request, "schedules.view");
    const server = await context.getServer(request.params.id);
    const scheduleId = validateScheduleId(request.params.scheduleId);
    const runId = validateOperationId(request.params.runId);
    const run = context.findScheduledRun(server, scheduleId, runId);
    if (!run) {
      return reply.code(404).send(apiErrorResponse("SCHEDULE_RUN_NOT_FOUND", "Schedule run not found"));
    }
    return { run };
  });

  app.post<{ Params: { id: string; scheduleId: string } }>("/api/servers/:id/schedules/:scheduleId/run", context.destructiveRateLimit, async (request, reply) => {
    await context.requireRequestPermission(request, "schedules.manage");
    const server = await context.getServer(request.params.id);
    const scheduleId = validateScheduleId(request.params.scheduleId);
    const schedule = server.schedules?.find((candidate) => candidate.id === scheduleId);
    if (!schedule) {
      return reply.code(404).send(apiErrorResponse("SCHEDULE_NOT_FOUND", "Schedule not found"));
    }
    const run = context.startScheduleExecution(server, schedule);
    if (!run) {
      return reply.code(409).send(apiErrorResponse("SCHEDULE_ALREADY_RUNNING", "Schedule is already running"));
    }
    context.logInfo({ ...context.serverLogFields(server), scheduleId, runId: run.id, action: "run_schedule_now" }, "Schedule test run started");
    return reply.code(202).send({ run });
  });

  app.post<{ Params: { id: string; scheduleId: string; runId: string } }>("/api/servers/:id/schedules/:scheduleId/runs/:runId/cancel", context.destructiveRateLimit, async (request, reply) => {
    await context.requireRequestPermission(request, "schedules.manage");
    const server = await context.getServer(request.params.id);
    const scheduleId = validateScheduleId(request.params.scheduleId);
    const runId = validateOperationId(request.params.runId);
    const cancelled = context.cancelActiveScheduleRun(server.id, scheduleId, runId);
    if (cancelled === null) {
      return reply.code(409).send(apiErrorResponse("SCHEDULE_RUN_NOT_CANCELLABLE", "The Restart step has started and must finish before this run can end"));
    }
    if (!cancelled) {
      return reply.code(404).send(apiErrorResponse("SCHEDULE_RUN_NOT_FOUND", "Active schedule run not found"));
    }
    context.logInfo({ ...context.serverLogFields(server), scheduleId, runId, action: "cancel_schedule_run" }, "Schedule run cancellation requested");
    return { run: cancelled };
  });
}
