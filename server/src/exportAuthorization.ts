import { hasPermission } from "./permissions.js";
import type { StoredUser } from "./types.js";

type ExportUser = Pick<StoredUser, "permissions" | "serverAccess">;

function exportForbidden(message: string): never {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = 403;
  throw error;
}

function uniqueServerIds(serverIds: readonly string[]) {
  return [...new Set(serverIds)];
}

export function scopedExportServerIds(
  user: ExportUser,
  requestedServerIds: readonly string[] | undefined,
  availableServerIds: readonly string[]
): string[] | undefined {
  const requested = requestedServerIds === undefined ? undefined : uniqueServerIds(requestedServerIds);
  if (user.serverAccess?.mode !== "selected") return requested;

  const allowed = new Set(user.serverAccess.serverIds);
  if (requested?.some((serverId) => !allowed.has(serverId))) {
    exportForbidden("You do not have access to one or more selected servers");
  }
  if (requested) return requested;
  return uniqueServerIds(availableServerIds.filter((serverId) => allowed.has(serverId)));
}

export function assertExportServerAccess(user: ExportUser, serverIds: readonly string[]) {
  if (user.serverAccess?.mode !== "selected") return;
  const allowed = new Set(user.serverAccess.serverIds);
  if (serverIds.some((serverId) => !allowed.has(serverId))) {
    exportForbidden("You no longer have access to every server in this export");
  }
}

export function assertInstanceExportAllowed(user: ExportUser) {
  if (!hasPermission(user, "integrations.manage")) {
    exportForbidden("You need permission to manage integrations before exporting instance configuration");
  }
  if (user.serverAccess?.mode === "selected") {
    exportForbidden("Server-scoped users cannot export instance-wide configuration");
  }
}
