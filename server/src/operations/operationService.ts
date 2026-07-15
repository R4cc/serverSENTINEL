import type { OperationRecord, OperationType } from "../types.js";
import type { OperationsRepository } from "../storage/operationsRepository.js";

export type RestartEffect = "mark" | "clear";

type BaseOperationInput<T> = {
  type: OperationType;
  serverId?: string;
  nodeId?: string;
  createdBy?: string;
  task: string;
  runningTask?: string;
  successTask?: string;
  serverIdFromResult?: (value: T) => string | undefined;
  result?: (value: T) => unknown | Promise<unknown>;
};

export type ForegroundOperationInput<T> = BaseOperationInput<T> & {
  restartEffect?: RestartEffect | ((value: T) => RestartEffect | undefined);
};

export type QueuedOperationInput<T> = BaseOperationInput<T> & {
  initialProgress?: number;
  runningProgress?: number;
  failureTask: string;
  failureFallback: string;
  onStarted?: (operation: OperationRecord) => void;
  onError?: (error: unknown, operation: OperationRecord) => void;
  onSettled?: (operation: OperationRecord) => void;
};

type OperationServiceContext = {
  markRestartRequired(serverId: string): void;
  clearRestartRequired(serverId: string): void;
  errorDetails(error: unknown): string;
};

function operationErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export class OperationService {
  constructor(
    private readonly operations: OperationsRepository,
    private readonly context: OperationServiceContext
  ) {}

  async run<T>(input: ForegroundOperationInput<T>, action: (operation: OperationRecord) => Promise<T>) {
    const operation = this.start(input, 5);
    try {
      const value = await action(operation);
      const affectedServerId = input.serverIdFromResult?.(value) ?? input.serverId;
      const restartEffect = typeof input.restartEffect === "function" ? input.restartEffect(value) : input.restartEffect;
      if (affectedServerId && restartEffect === "mark") this.context.markRestartRequired(affectedServerId);
      if (affectedServerId && restartEffect === "clear") this.context.clearRestartRequired(affectedServerId);
      await this.succeed(operation, input, value);
      return value;
    } catch (error) {
      this.fail(operation, error, "Operation failed", "Operation failed");
      throw error;
    }
  }

  enqueue<T>(
    input: QueuedOperationInput<T>,
    action: (operation: OperationRecord, report: (progress: number, task: string) => void) => Promise<T>
  ) {
    const operation = this.start(input, input.runningProgress ?? input.initialProgress ?? 0, input.initialProgress ?? 0);
    input.onStarted?.(operation);
    void action(operation, (progress, task) => this.operations.update(operation.id, { progress, task }))
      .then((value) => this.succeed(operation, input, value))
      .catch((error: unknown) => {
        input.onError?.(error, operation);
        this.fail(operation, error, input.failureTask, input.failureFallback);
      })
      .finally(() => input.onSettled?.(operation));
    return operation;
  }

  private start<T>(input: BaseOperationInput<T>, runningProgress: number, initialProgress = runningProgress) {
    const created = this.operations.create({
      type: input.type,
      serverId: input.serverId,
      nodeId: input.nodeId,
      createdBy: input.createdBy,
      progress: initialProgress,
      task: input.task
    });
    return this.operations.start(created.id, {
      progress: runningProgress,
      task: input.runningTask ?? input.task
    }) ?? created;
  }

  private async succeed<T>(operation: OperationRecord, input: BaseOperationInput<T>, value: T) {
    const resultServerId = input.serverIdFromResult?.(value);
    this.operations.succeed(operation.id, {
      serverId: resultServerId,
      progress: 100,
      task: input.successTask ?? "Operation complete",
      result: input.result ? await input.result(value) : value
    });
  }

  private fail(operation: OperationRecord, error: unknown, task: string, fallback: string) {
    this.operations.fail(operation.id, operationErrorMessage(error, fallback), {
      task,
      logSummary: this.context.errorDetails(error)
    });
  }
}
