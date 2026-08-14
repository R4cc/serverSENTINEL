import { operationInProgress } from "./http/errors.js";
import type { OperationsRepository } from "./storage/operationsRepository.js";

const exportInProgressMessage = "An export is in progress for this server. Abort it or wait for it to finish before making changes.";

export class ExportCancelledError extends Error {
  constructor() {
    super("Export cancelled by user");
    this.name = "ExportCancelledError";
  }
}

type ActiveExport = {
  operationId: string;
  serverIds: string[];
  controller: AbortController;
  cancellable: boolean;
};

/**
 * Coordinates the short-lived in-process work behind durable export operation rows.
 * Incomplete rows are failed during startup, so the in-memory locks never need reconstruction.
 */
export class ExportCoordinator {
  private readonly activeByOperation = new Map<string, ActiveExport>();
  private readonly activeByServer = new Map<string, string>();
  private readonly mutationCounts = new Map<string, number>();
  private readonly mutationVersions = new Map<string, number>();

  constructor(private readonly operations: OperationsRepository) {}

  activeOperationId(serverId: string) {
    return this.activeByServer.get(serverId);
  }

  isCancellationAvailable(operationId: string) {
    const active = this.activeByOperation.get(operationId);
    return Boolean(active?.cancellable && !active.controller.signal.aborted);
  }

  mutationVersion(serverId: string) {
    return this.mutationVersions.get(serverId) ?? 0;
  }

  assertMutationAllowed(serverId: string) {
    if (this.activeByServer.has(serverId)) {
      operationInProgress(exportInProgressMessage, "EXPORT_IN_PROGRESS");
    }
  }

  async withMutation<T>(serverId: string, action: () => Promise<T>) {
    this.assertMutationAllowed(serverId);
    this.mutationCounts.set(serverId, (this.mutationCounts.get(serverId) ?? 0) + 1);
    try {
      return await action();
    } finally {
      // Invalidate inventories measured before or during the mutation. Failed mutations still count
      // because they may have changed files before reporting their failure.
      this.mutationVersions.set(serverId, this.mutationVersion(serverId) + 1);
      const remaining = (this.mutationCounts.get(serverId) ?? 1) - 1;
      if (remaining > 0) this.mutationCounts.set(serverId, remaining);
      else this.mutationCounts.delete(serverId);
    }
  }

  assertCanStart(serverIds: readonly string[]) {
    for (const serverId of serverIds) {
      if (this.activeByServer.has(serverId)) {
        operationInProgress("An export is already running for this server", "EXPORT_ALREADY_RUNNING");
      }
      if ((this.mutationCounts.get(serverId) ?? 0) > 0) {
        operationInProgress("A server change is still running. Wait for it to finish before exporting.", "SERVER_MUTATION_IN_PROGRESS");
      }
    }
  }

  async run<T>(operationId: string, serverIds: readonly string[], action: (signal: AbortSignal, beginCommit: () => void) => Promise<T>) {
    this.assertCanStart(serverIds);
    const active: ActiveExport = {
      operationId,
      serverIds: [...serverIds],
      controller: new AbortController(),
      cancellable: true
    };
    this.activeByOperation.set(operationId, active);
    for (const serverId of active.serverIds) this.activeByServer.set(serverId, operationId);
    try {
      const value = await action(active.controller.signal, () => {
        if (active.controller.signal.aborted) throw new ExportCancelledError();
        active.cancellable = false;
        this.operations.update(operationId, { progress: 99, task: "Finalizing export" });
      });
      if (active.controller.signal.aborted) throw new ExportCancelledError();
      return value;
    } catch (error) {
      if (active.controller.signal.aborted) throw new ExportCancelledError();
      throw error;
    } finally {
      this.activeByOperation.delete(operationId);
      for (const serverId of active.serverIds) {
        if (this.activeByServer.get(serverId) === operationId) this.activeByServer.delete(serverId);
      }
    }
  }

  requestCancel(operationId: string) {
    const active = this.activeByOperation.get(operationId);
    if (!active || !active.cancellable || active.controller.signal.aborted) return false;
    this.operations.update(operationId, { task: "Cancelling export" });
    active.controller.abort(new ExportCancelledError());
    return true;
  }
}
