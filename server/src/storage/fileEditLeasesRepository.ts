import { randomUUID } from "node:crypto";
import type { FileEditLease } from "../types.js";
import { normalizePublicFilePath } from "../core.js";
import type { StorageDatabase } from "./database.js";

export const fileEditLeaseTimeoutMs = 60_000;

type LeaseRow = {
  lease_id: string;
  server_id: string;
  path: string;
  user_id: string;
  session_id: string;
  display_name: string;
  acquired_at: number;
  refreshed_at: number;
  expires_at: number;
  file_revision: string;
};

type LeaseOwner = {
  userId: string;
  sessionId: string;
  displayName: string;
};

function leaseFromRow(row: LeaseRow): FileEditLease {
  return {
    leaseId: row.lease_id,
    serverId: row.server_id,
    path: row.path,
    userId: row.user_id,
    sessionId: row.session_id,
    displayName: row.display_name,
    acquiredAt: new Date(row.acquired_at).toISOString(),
    refreshedAt: new Date(row.refreshed_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    fileRevision: row.file_revision
  };
}

export class FileLeaseError extends Error {
  statusCode = 409;
  details?: { lease: Omit<FileEditLease, "sessionId"> };

  constructor(message: string, readonly code: "file_edit_lease_conflict" | "file_edit_lease_lost", lease?: FileEditLease) {
    super(message);
    this.name = "FileLeaseError";
    if (lease) {
      const { sessionId: _sessionId, ...publicLease } = lease;
      this.details = { lease: publicLease };
    }
  }
}

export class FileEditLeasesRepository {
  constructor(private readonly storage: StorageDatabase) {}

  acquire(input: { serverId: string; path: string; fileRevision: string; owner: LeaseOwner }, now = Date.now()) {
    return this.storage.transaction((database) => {
      this.removeExpired(now);
      const path = normalizePublicFilePath(input.path);
      const existing = this.findByPath(input.serverId, path);
      if (existing) {
        throw new FileLeaseError(
          `${existing.displayName || "Another user"} is already editing this file`,
          "file_edit_lease_conflict",
          existing
        );
      }
      const leaseId = randomUUID();
      const expiresAt = now + fileEditLeaseTimeoutMs;
      database.prepare(`
        INSERT INTO file_edit_leases (
          lease_id, server_id, path, user_id, session_id, display_name,
          acquired_at, refreshed_at, expires_at, file_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        leaseId, input.serverId, path, input.owner.userId, input.owner.sessionId,
        input.owner.displayName, now, now, expiresAt, input.fileRevision
      );
      return this.findById(leaseId)!;
    });
  }

  heartbeat(leaseId: string, owner: LeaseOwner, now = Date.now()) {
    return this.storage.transaction((database) => {
      this.removeExpired(now);
      const lease = this.findById(leaseId);
      this.assertOwner(lease, owner);
      database.prepare("UPDATE file_edit_leases SET refreshed_at = ?, expires_at = ? WHERE lease_id = ?")
        .run(now, now + fileEditLeaseTimeoutMs, leaseId);
      return this.findById(leaseId)!;
    });
  }

  requireOwned(leaseId: string, serverId: string, path: string, owner: LeaseOwner, now = Date.now()) {
    return this.storage.transaction(() => {
      this.removeExpired(now);
      const normalizedPath = normalizePublicFilePath(path);
      const lease = this.findById(leaseId);
      this.assertOwner(lease, owner);
      if (lease.serverId !== serverId || lease.path !== normalizedPath) {
        throw new FileLeaseError("The edit lease does not belong to this file", "file_edit_lease_lost");
      }
      return lease;
    });
  }

  release(leaseId: string, owner: LeaseOwner) {
    return this.storage.transaction((database) => {
      const lease = this.findById(leaseId);
      if (!lease) return false;
      this.assertOwner(lease, owner);
      return database.prepare("DELETE FROM file_edit_leases WHERE lease_id = ?").run(leaseId).changes > 0;
    });
  }

  forceRelease(leaseId: string, serverId: string, now = Date.now()) {
    return this.storage.transaction((database) => {
      this.removeExpired(now);
      return database.prepare("DELETE FROM file_edit_leases WHERE lease_id = ? AND server_id = ?").run(leaseId, serverId).changes > 0;
    });
  }

  pruneExpired(now = Date.now()) {
    return this.storage.connection.prepare("DELETE FROM file_edit_leases WHERE expires_at <= ?").run(now).changes;
  }

  private findById(leaseId: string) {
    const row = this.storage.connection.prepare<[string], LeaseRow>("SELECT * FROM file_edit_leases WHERE lease_id = ?").get(leaseId);
    return row ? leaseFromRow(row) : undefined;
  }

  private findByPath(serverId: string, path: string) {
    const row = this.storage.connection.prepare<[string, string], LeaseRow>(
      "SELECT * FROM file_edit_leases WHERE server_id = ? AND path = ?"
    ).get(serverId, path);
    return row ? leaseFromRow(row) : undefined;
  }

  private removeExpired(now: number) {
    this.storage.connection.prepare("DELETE FROM file_edit_leases WHERE expires_at <= ?").run(now);
  }

  private assertOwner(lease: FileEditLease | undefined, owner: LeaseOwner): asserts lease is FileEditLease {
    if (!lease || lease.userId !== owner.userId || lease.sessionId !== owner.sessionId) {
      throw new FileLeaseError("The file edit lease expired or is no longer owned by this session", "file_edit_lease_lost");
    }
  }
}
