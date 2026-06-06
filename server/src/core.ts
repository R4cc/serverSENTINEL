import { realpath } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";

export type ServerPathScope = {
  serverDir: string;
};

export function ensureInsideServer(server: ServerPathScope, userPath = ".") {
  const serverDir = resolve(server.serverDir);
  const trimmed = userPath.replace(/^[/\\]+/, "");
  const target = resolve(serverDir, trimmed || ".");
  assertPathInside(serverDir, target, "Path escapes the registered server directory");
  return target;
}

function normalizedPath(value: string) {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertPathInside(root: string, target: string, message: string) {
  const normalizedRoot = normalizedPath(root);
  const normalizedTarget = normalizedPath(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(normalizedRoot + sep)) {
    throw new Error(message);
  }
}

function pathSafetyError(message: string, code?: string) {
  const error = new Error(message) as NodeJS.ErrnoException;
  if (code) error.code = code;
  return error;
}

function ensureResolvedInsideServer(server: ServerPathScope, targetPath: string) {
  const serverDir = resolve(server.serverDir);
  const target = resolve(targetPath);
  assertPathInside(serverDir, target, "Path escapes the registered server directory");
  return target;
}

async function realServerDir(server: ServerPathScope) {
  try {
    return await realpath(server.serverDir);
  } catch {
    throw pathSafetyError("Managed server root directory is not accessible", "ENOENT");
  }
}

export async function validateExistingInsideServer(server: ServerPathScope, userPath = ".") {
  const target = ensureInsideServer(server, userPath);
  return validateExistingResolvedInsideServer(server, target);
}

export async function validateExistingResolvedInsideServer(server: ServerPathScope, targetPath: string) {
  const target = ensureResolvedInsideServer(server, targetPath);
  const serverDir = await realServerDir(server);
  let realTarget: string;
  try {
    realTarget = await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw pathSafetyError("Path does not exist inside the managed server directory", "ENOENT");
    }
    throw error;
  }
  assertPathInside(serverDir, realTarget, "Path escapes the managed server directory through a symlink");
  return target;
}

export async function ensureWritableInsideServer(server: ServerPathScope, userPath = ".") {
  const target = ensureInsideServer(server, userPath);
  const serverDir = await realServerDir(server);
  let realParent: string;
  try {
    realParent = await realpath(dirname(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw pathSafetyError("Parent directory does not exist inside the managed server directory", "ENOENT");
    }
    throw error;
  }
  if (normalizedPath(realParent) !== normalizedPath(serverDir)) {
    assertPathInside(serverDir, realParent, "Path escapes the managed server directory through a symlink");
  }
  return target;
}

export async function ensureWritableResolvedInsideServer(server: ServerPathScope, targetPath: string) {
  const target = ensureResolvedInsideServer(server, targetPath);
  const serverDir = await realServerDir(server);
  let realParent: string;
  try {
    realParent = await realpath(dirname(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw pathSafetyError("Parent directory does not exist inside the managed server directory", "ENOENT");
    }
    throw error;
  }
  if (normalizedPath(realParent) !== normalizedPath(serverDir)) {
    assertPathInside(serverDir, realParent, "Path escapes the managed server directory through a symlink");
  }
  return target;
}

export function safeModFilename(name: string) {
  return basename(name).replace(/[^a-zA-Z0-9._ -]/g, "_");
}

export function safeInstalledModFilename(name?: string) {
  const filename = basename(name ?? "").trim();
  if (!filename || filename !== name || (!filename.endsWith(".jar") && !filename.endsWith(".jar.disabled"))) {
    throw new Error("A valid mod filename is required");
  }
  return filename;
}

export function parseCronField(field: string, min: number, max: number) {
  const values = new Set<number>();
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) return null;
    const [rangePart, stepPart] = part.split("/", 2);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;

    let start = min;
    let end = max;
    if (rangePart !== "*") {
      if (rangePart.includes("-")) {
        const [rawStart, rawEnd] = rangePart.split("-", 2).map(Number);
        if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) return null;
        start = rawStart;
        end = rawEnd;
      } else {
        const exact = Number(rangePart);
        if (!Number.isInteger(exact)) return null;
        start = exact;
        end = exact;
      }
    }

    if (start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return values;
}

export function validateCron(cron: string) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("Cron schedule must use five fields: minute hour day month weekday");
  }
  const valid = [
    parseCronField(parts[0], 0, 59),
    parseCronField(parts[1], 0, 23),
    parseCronField(parts[2], 1, 31),
    parseCronField(parts[3], 1, 12),
    parseCronField(parts[4], 0, 7)
  ].every(Boolean);
  if (!valid) {
    throw new Error("Cron schedule contains an invalid field");
  }
}

export function cronMatches(cron: string, date: Date) {
  validateCron(cron);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.trim().split(/\s+/);
  const normalizedDay = date.getDay();
  const days = parseCronField(dayOfWeek, 0, 7)!;
  return parseCronField(minute, 0, 59)!.has(date.getMinutes())
    && parseCronField(hour, 0, 23)!.has(date.getHours())
    && parseCronField(dayOfMonth, 1, 31)!.has(date.getDate())
    && parseCronField(month, 1, 12)!.has(date.getMonth() + 1)
    && (days.has(normalizedDay) || (normalizedDay === 0 && days.has(7)));
}

export function nextCronRun(cron: string, from = new Date(), maxDays = 366) {
  validateCron(cron);
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const maxChecks = Math.max(1, maxDays * 24 * 60);
  for (let checked = 0; checked < maxChecks; checked += 1) {
    if (cronMatches(cron, cursor)) {
      return new Date(cursor);
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

export function parseDockerPorts(ports?: string) {
  const exposedPorts: Record<string, Record<string, never>> = {};
  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  for (const rawPort of ports?.split(",") ?? []) {
    const port = rawPort.trim();
    if (!port) continue;
    const [hostPort, containerPortWithProtocol] = port.includes(":") ? port.split(":", 2) : [port, port];
    const [containerPortNumber, protocol = "tcp"] = containerPortWithProtocol.split("/", 2);
    if (!isValidPort(hostPort) || !isValidPort(containerPortNumber) || (protocol !== "tcp" && protocol !== "udp")) {
      throw new Error(`Invalid Docker port binding: ${port}`);
    }
    const containerPort = `${containerPortNumber}/${protocol}`;
    exposedPorts[containerPort] = {};
    portBindings[containerPort] = [{ HostPort: hostPort }];
  }
  return { exposedPorts, portBindings };
}

function isValidPort(value: string) {
  if (!/^\d+$/.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65535;
}

export class AsyncQueue {
  private promise: Promise<unknown> = Promise.resolve();
  enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.promise.then(task);
    this.promise = next.catch(() => {});
    return next;
  }
}
