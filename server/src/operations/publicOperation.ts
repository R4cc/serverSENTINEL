import { hasPermission } from "../permissions.js";
import type { OperationRecord, Permission, StoredUser } from "../types.js";

const resultPermissions: Record<OperationRecord["type"], Permission> = {
  "server.create": "servers.create", "server.start": "servers.control", "server.stop": "servers.control", "server.restart": "servers.control",
  "mod.upload": "mods.view", "mod.install": "mods.view", "mod.update": "mods.view", "mod.remove": "mods.view", "mod.toggle": "mods.view", "mod.batchUpdate": "mods.view",
  "schedule.run": "schedules.view", "file.extract": "files.view", "import.run": "servers.create", "export.run": "servers.export"
};

/** Stored results are internal. Project them on every response, including cancellation. */
export function publicOperation(operation: OperationRecord, user: StoredUser): OperationRecord {
  const { logSummary: _diagnostics, result, ...summary } = operation;
  if (result === undefined || !hasPermission(user, resultPermissions[operation.type])) return summary;
  // Console output can appear in scheduled steps and runtime results. Host paths remain internal.
  const filter = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(filter);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => {
      if (["artifactPath", "serverDir", "dockerMountSource", "dockerWorkingDir", "logSummary", "errorDetails", "configurationUpdate", "configurationRevision"].includes(key)) return false;
      if (["logs", "text", "logTail"].includes(key) && !hasPermission(user, "console.view")) return false;
      if (key === "schedules" && !hasPermission(user, "schedules.view")) return false;
      if (key === "downloadUrl" && operation.type === "export.run" && operation.createdBy !== user.id) return false;
      return true;
    }).map(([key, entry]) => [key, filter(entry)]));
  };
  return { ...summary, result: filter(result) };
}
