import { forbidden } from "./http/errors.js";
import { hasPermission } from "./permissions.js";
import type { StoredUser } from "./types.js";

/**
 * Per-user server scoping was removed: `serverAccess` was persisted and enforced here, but nothing
 * could ever set it to "selected" — no route, no UI, no import path — so the boundary existed only in
 * export while every other API ignored it. Rather than leave a half-built boundary that reads as
 * enforced, exports now authorize on permissions alone, like the rest of the API.
 */

type ExportUser = Pick<StoredUser, "permissions">;

function exportForbidden(message: string): never {
  forbidden(message);
}

function uniqueServerIds(serverIds: readonly string[]) {
  return [...new Set(serverIds)];
}

/** Normalizes the requested server list; `undefined` still means "every server in the instance". */
export function selectedExportServerIdsOrAll(requestedServerIds: readonly string[] | undefined) {
  return requestedServerIds === undefined ? undefined : uniqueServerIds(requestedServerIds);
}

export function assertInstanceExportAllowed(user: ExportUser) {
  if (!hasPermission(user, "integrations.manage")) {
    exportForbidden("You need permission to manage integrations before exporting instance configuration");
  }
}
