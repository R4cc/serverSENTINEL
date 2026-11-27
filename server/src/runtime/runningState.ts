/**
 * Whether a runtime status reports the server as running: `true`/`false` when the status says so,
 * `undefined` when it does not know. Accepts either a full status (`{ docker: { running } }`) or
 * the Docker part on its own.
 */
export function runtimeRunning(status: unknown) {
  if (!status || typeof status !== "object") return undefined;
  const docker = "docker" in status ? (status as { docker?: { running?: unknown } }).docker : status as { running?: unknown };
  return typeof docker?.running === "boolean" ? docker.running : undefined;
}
