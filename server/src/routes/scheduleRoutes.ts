import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import type { AuthenticatedRequest } from "../auth/requestAuthentication.js";
import { apiErrorResponse } from "../http/errors.js";
import { validateOperationId, validateScheduleId } from "../http/validation.js";
import type { ManagedServer, Permission, ScheduledActiveRun, ScheduledExecution } from "../types.js";

export type ScheduleBody = {
  name?: string;
  cron?: string;
  steps?: unknown;
  commands?: unknown;
  commandDelaysSeconds?: unknown;
  commandDelaysMinutes?: unknown;
  onlyWhenNoPlayers?: boolean;
  enabled?: boolean;
};

export type ScheduleRoutesContext = {
  destructiveRateLimit: RouteShorthandOptions;
  requireRequestPermission(request: AuthenticatedRequest, permission: Permission): Promise<unknown>;
  getServer(serverId: string): Promise<ManagedServer>;
  parseSchedule(body: ScheduleBody, existing?: ScheduledExecution): ScheduledExecution;
  publicSchedule(serverId: string, schedule: ScheduledExecution): ScheduledExecution;
  createSchedule(serverId: string, schedule: ScheduledExecution, serverUpdatedAt: string): void;
  updateSchedule(serverId: string, schedule: ScheduledExecution, serverUpdatedAt: string): void;
  deleteSchedule(serverId: string, scheduleId: string, serverUpdatedAt: string): void;
  startScheduleExecution(server: ManagedServer, schedule: ScheduledExecution): ScheduledActiveRun | undefined;
  cancelActiveScheduleRun(serverId: string, scheduleId: string, runId: string): ScheduledActiveRun | null | undefined;
  serverLogFields(server: ManagedServer): Record<string, unknown>;
  logInfo(fields: Record<string, unknown>, message: string): void;
};

export function registerScheduleRoutes(app: FastifyInstance, context: ScheduleRoutesContext) {
  app.get<{ Params: { id: string } }>("/api/servers/:id/schedules", async (request) => {
    await context.requireRequestPermission(request, "schedules.view");
    const server = await context.getServer(request.params.id);
    return { schedules: (server.schedules ?? []).map((schedule) => context.publicSchedule(server.id, schedule)) };
  });

  app.post<{ Params: { id: string }; Body: ScheduleBody }>("/api/servers/:id/schedules", context.destructiveRateLimit, async (request) => {
    await context.requireRequestPermission(request, "schedules.manage");
    const server = await context.getServer(request.params.id);
    const createdSchedule = context.parseSchedule(request.body);
    context.createSchedule(server.id, createdSchedule, createdSchedule.updatedAt);
    context.logInfo({ ...context.serverLogFields(server), scheduleId: createdSchedule.id, enabled: createdSchedule.enabled, action: "create_schedule" }, "Schedule created");
    return createdSchedule;
  });

  app.put<{ Params: { id: string; scheduleId: string }; Body: ScheduleBody }>("/api/servers/:id/schedules/:scheduleId", context.destructiveRateLimit, async (request) => {
    await context.requireRequestPermission(request, "schedules.manage");
    const server = await context.getServer(request.params.id);
    const scheduleId = validateScheduleId(request.params.scheduleId);
    const existing = server.schedules?.find((candidate) => candidate.id === scheduleId);
    if (!existing) throw new Error("Schedule not found");
    const updatedSchedule = context.parseSchedule(request.body, existing);
    context.updateSchedule(server.id, updatedSchedule, updatedSchedule.updatedAt);
    context.logInfo({ ...context.serverLogFields(server), scheduleId: updatedSchedule.id, enabled: updatedSchedule.enabled, action: "update_schedule" }, "Schedule updated");
    return updatedSchedule;
  });

  app.delete<{ Params: { id: string; scheduleId: string } }>("/api/servers/:id/schedules/:scheduleId", context.destructiveRateLimit, async (request) => {
    await context.requireRequestPermission(request, "schedules.manage");
    const server = await context.getServer(request.params.id);
    const scheduleId = validateScheduleId(request.params.scheduleId);
    context.deleteSchedule(server.id, scheduleId, new Date().toISOString());
    context.logInfo({ ...context.serverLogFields(server), scheduleId, action: "delete_schedule" }, "Schedule deleted");
    return { ok: true };
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
