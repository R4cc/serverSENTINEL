import { randomUUID } from "node:crypto";
import type { OperationRecord, OperationStatus, OperationType } from "../types.js";
import type { StorageDatabase } from "./database.js";

type OperationRow = {
  id: string;
  type: string;
  status: string;
  server_id: string | null;
  node_id: string | null;
  created_by: string | null;
  progress: number;
  task: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  result_json: string | null;
  log_summary: string | null;
};

type OperationCreateInput = {
  id?: string;
  type: OperationType;
  serverId?: string;
  nodeId?: string;
  createdBy?: string;
  progress?: number;
  task?: string;
  createdAt?: string;
};

type OperationPatch = {
  serverId?: string;
  nodeId?: string;
  progress?: number;
  task?: string;
  errorMessage?: string;
  result?: unknown;
  logSummary?: string;
};

type OperationListFilters = {
  serverId?: string;
  status?: OperationStatus;
  limit?: number;
};

function operationFromRow(row: OperationRow): OperationRecord {
  return {
    id: row.id,
    type: row.type as OperationType,
    status: row.status as OperationStatus,
    serverId: row.server_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    createdBy: row.created_by ?? undefined,
    progress: row.progress,
    task: row.task ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    errorMessage: row.error_message ?? undefined,
    result: row.result_json ? JSON.parse(row.result_json) : undefined,
    logSummary: row.log_summary ?? undefined
  };
}

function clampProgress(progress: number) {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

function resultJson(value: unknown) {
  return value === undefined ? null : JSON.stringify(value);
}

export class OperationsRepository {
  constructor(private readonly storage: StorageDatabase) {}

  create(input: OperationCreateInput) {
    const id = input.id ?? randomUUID();
    const now = input.createdAt ?? new Date().toISOString();
    this.storage.connection.prepare(`
      INSERT INTO operations (
        id, type, status, server_id, node_id, created_by, progress,
        task, created_at, started_at, finished_at, error_message, result_json, log_summary
      ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)
    `).run(
      id,
      input.type,
      input.serverId ?? null,
      input.nodeId ?? null,
      input.createdBy ?? null,
      clampProgress(input.progress ?? 0),
      input.task ?? null,
      now
    );
    return this.find(id)!;
  }

  find(id: string) {
    const row = this.storage.connection.prepare<[string], OperationRow>("SELECT * FROM operations WHERE id = ?").get(id);
    return row ? operationFromRow(row) : undefined;
  }

  list(filters: OperationListFilters = {}) {
    const limit = Math.max(1, Math.min(filters.limit ?? 100, 250));
    if (filters.serverId && filters.status) {
      return this.storage.connection.prepare<[string, string, number], OperationRow>(`
        SELECT * FROM operations
        WHERE server_id = ? AND status = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(filters.serverId, filters.status, limit).map(operationFromRow);
    }
    if (filters.serverId) {
      return this.storage.connection.prepare<[string, number], OperationRow>(`
        SELECT * FROM operations
        WHERE server_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(filters.serverId, limit).map(operationFromRow);
    }
    if (filters.status) {
      return this.storage.connection.prepare<[string, number], OperationRow>(`
        SELECT * FROM operations
        WHERE status = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(filters.status, limit).map(operationFromRow);
    }
    return this.storage.connection.prepare<[number], OperationRow>("SELECT * FROM operations ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map(operationFromRow);
  }

  start(id: string, patch: OperationPatch = {}, now = new Date().toISOString()) {
    this.storage.connection.prepare(`
      UPDATE operations
      SET status = 'running',
          started_at = COALESCE(started_at, ?),
          server_id = COALESCE(?, server_id),
          node_id = COALESCE(?, node_id),
          progress = COALESCE(?, progress),
          task = COALESCE(?, task),
          error_message = NULL
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(
      now,
      patch.serverId ?? null,
      patch.nodeId ?? null,
      patch.progress === undefined ? null : clampProgress(patch.progress),
      patch.task ?? null,
      id
    );
    return this.find(id);
  }

  update(id: string, patch: OperationPatch) {
    this.storage.connection.prepare(`
      UPDATE operations
      SET server_id = COALESCE(?, server_id),
          node_id = COALESCE(?, node_id),
          progress = COALESCE(?, progress),
          task = COALESCE(?, task),
          result_json = COALESCE(?, result_json),
          log_summary = COALESCE(?, log_summary)
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(
      patch.serverId ?? null,
      patch.nodeId ?? null,
      patch.progress === undefined ? null : clampProgress(patch.progress),
      patch.task ?? null,
      resultJson(patch.result),
      patch.logSummary ?? null,
      id
    );
    return this.find(id);
  }

  succeed(id: string, patch: OperationPatch = {}, now = new Date().toISOString()) {
    this.storage.connection.prepare(`
      UPDATE operations
      SET status = 'succeeded',
          server_id = COALESCE(?, server_id),
          node_id = COALESCE(?, node_id),
          progress = ?,
          task = COALESCE(?, task),
          finished_at = ?,
          error_message = NULL,
          result_json = ?,
          log_summary = COALESCE(?, log_summary)
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(
      patch.serverId ?? null,
      patch.nodeId ?? null,
      clampProgress(patch.progress ?? 100),
      patch.task ?? null,
      now,
      resultJson(patch.result),
      patch.logSummary ?? null,
      id
    );
    return this.find(id);
  }

  fail(id: string, errorMessage: string, patch: OperationPatch = {}, now = new Date().toISOString()) {
    this.storage.connection.prepare(`
      UPDATE operations
      SET status = 'failed',
          server_id = COALESCE(?, server_id),
          node_id = COALESCE(?, node_id),
          progress = COALESCE(?, progress),
          task = COALESCE(?, task),
          finished_at = ?,
          error_message = ?,
          result_json = COALESCE(?, result_json),
          log_summary = COALESCE(?, log_summary)
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(
      patch.serverId ?? null,
      patch.nodeId ?? null,
      patch.progress === undefined ? null : clampProgress(patch.progress),
      patch.task ?? null,
      now,
      errorMessage,
      resultJson(patch.result),
      patch.logSummary ?? null,
      id
    );
    return this.find(id);
  }

  cancel(id: string, message = "Operation cancelled", now = new Date().toISOString()) {
    this.storage.connection.prepare(`
      UPDATE operations
      SET status = 'cancelled',
          finished_at = ?,
          error_message = ?,
          task = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(now, message, message, id);
    return this.find(id);
  }

  failIncompleteOnStartup(message = "Operation did not complete before serverSENTINEL restarted", now = new Date().toISOString()) {
    return this.storage.connection.prepare(`
      UPDATE operations
      SET status = 'failed',
          finished_at = ?,
          error_message = ?,
          task = COALESCE(task, ?)
      WHERE status IN ('queued', 'running')
    `).run(now, message, message).changes;
  }

  deleteFinishedBefore(cutoffIso: string) {
    return this.storage.connection.prepare(`
      DELETE FROM operations
      WHERE finished_at IS NOT NULL AND finished_at < ?
    `).run(cutoffIso).changes;
  }

  trimFinished(maxRows: number) {
    const limit = Math.max(1, Math.floor(maxRows));
    return this.storage.connection.prepare(`
      DELETE FROM operations
      WHERE finished_at IS NOT NULL
        AND id NOT IN (
          SELECT id FROM operations
          WHERE finished_at IS NOT NULL
          ORDER BY finished_at DESC, created_at DESC, id DESC
          LIMIT ?
        )
    `).run(limit).changes;
  }
}
