import type { OperationRecord, ScheduledRun, ServerEvent, ServerTimelineEvent } from "../types.js";

type PersistentServerEventsInput = {
  timelineEvents: readonly ServerTimelineEvent[];
  transientEvents?: readonly ServerEvent[];
  operations?: readonly OperationRecord[];
  scheduledRuns?: readonly ScheduledRun[];
};

function eventTime(event: ServerEvent) {
  if (!event.timestamp) return 0;
  const timestamp = new Date(event.timestamp).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function eventIdentity(event: ServerEvent) {
  return [event.source, event.timestamp ?? "", event.signature, event.message, event.details ?? ""].join("\u0000");
}

function operationReason(operation: OperationRecord) {
  if (!operation.result || typeof operation.result !== "object" || Array.isArray(operation.result)) return undefined;
  const reason = (operation.result as Record<string, unknown>).reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : undefined;
}

function runtimeActionLabel(operation: OperationRecord) {
  const action = operation.type === "server.restart" ? "restart" : "stop";
  if (operation.status === "failed") return `Server ${action} failed`;
  if (operation.status === "cancelled") return `Server ${action} cancelled`;
  if (operation.status === "queued" || operation.status === "running") return `Server ${action} requested`;
  return action === "restart" ? "Server restarted" : "Server stopped";
}

function runtimeActionEvent(operation: OperationRecord): ServerEvent | null {
  if (operation.type !== "server.restart" && operation.type !== "server.stop") return null;
  const reason = operationReason(operation);
  if (!reason) return null;
  const timestamp = operation.finishedAt ?? operation.startedAt ?? operation.createdAt;
  const severity = operation.status === "failed"
    ? "error"
    : operation.status === "cancelled"
      ? "warning"
      : operation.type === "server.restart" && operation.status === "succeeded"
        ? "success"
        : "info";
  const message = runtimeActionLabel(operation);
  return {
    id: `operation-${operation.id}`,
    eventType: operation.type === "server.restart" ? "server_restarted" : "server_stopped",
    type: severity,
    severity,
    text: message,
    message,
    details: operation.errorMessage ? `Purpose: ${reason} · ${operation.errorMessage}` : `Purpose: ${reason}`,
    timestamp,
    signature: operation.type === "server.restart" ? "server_restart_operation" : "server_stop_operation",
    source: "operations"
  };
}

function automationSeverity(status: string): ServerEvent["severity"] {
  if (status === "success") return "success";
  if (status === "failed") return "error";
  if (status === "cancelled" || status === "skipped") return "warning";
  return "info";
}

function automationStatusLabel(status: string) {
  if (status === "success") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "was cancelled";
  if (status === "skipped") return "was skipped";
  return status;
}

function automationEvent(run: ScheduledRun): ServerEvent {
  const severity = automationSeverity(run.status);
  const message = `${run.scheduleName} ${automationStatusLabel(run.status)}`;
  return {
    id: `schedule-${run.id}`,
    eventType: "automation_run",
    type: severity,
    severity,
    text: message,
    message,
    details: run.message,
    timestamp: run.ranAt,
    signature: `automation_run:${run.scheduleId}:${run.status}`,
    source: "schedules",
    subject: run.scheduleName
  };
}

/**
 * Builds the Overview event history from durable panel data. The transient runtime response stays
 * in the merge so a just-written line can appear before the ten-second collector pass persists it.
 */
export function persistentServerEvents({
  timelineEvents,
  transientEvents = [],
  operations = [],
  scheduledRuns = []
}: PersistentServerEventsInput) {
  const events: ServerEvent[] = [
    ...timelineEvents,
    ...transientEvents,
    ...operations.map(runtimeActionEvent).filter((event): event is ServerEvent => event !== null),
    ...scheduledRuns.map(automationEvent)
  ];
  const seen = new Set<string>();
  return events
    .sort((first, second) => eventTime(second) - eventTime(first) || second.id.localeCompare(first.id))
    .filter((event) => {
      const identity = eventIdentity(event);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
}
