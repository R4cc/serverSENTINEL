import type { GeneralJob, ManagedServer, OperationRecord } from "../types";

/** The server a completed provision operation created, when it reported one. */
export function serverFromOperation(operation: OperationRecord) {
  const result = operation.result;
  if (result && typeof result === "object" && "server" in result) {
    return (result as { server?: ManagedServer }).server;
  }
  return undefined;
}

/**
 * Projects a provision operation onto the job card fields. A job stays
 * non-dismissible while it is still queued or running.
 */
export function operationToProvisionActiveJob(operation: OperationRecord): Partial<GeneralJob> {
  return {
    id: operation.id,
    status: operation.status,
    progress: operation.progress,
    task: operation.task || "Server setup is running.",
    error: operation.errorMessage,
    errorDetails: operation.logSummary,
    dismissible: operation.status !== "queued" && operation.status !== "running"
  };
}
