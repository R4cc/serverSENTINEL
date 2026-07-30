import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import type { Stats } from "node:fs";

export type ServerPathScope = {
  serverDir: string;
};

export function ensureInsideServer(server: ServerPathScope, userPath = ".") {
  const serverDir = resolve(server.serverDir);
  const target = isAbsolute(userPath)
    ? resolve(userPath)
    : resolve(serverDir, userPath || ".");
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

/**
 * A node flattens filesystem errors onto the wire as `command_failed` and keeps only the message, so
 * the panel cannot read `ENOENT` off an error a node raised. Callers that tolerate a missing path
 * match these instead of the prose, which keeps the two ends from drifting apart.
 */
export const missingPathMessage = "Path does not exist inside the managed server directory";
export const missingParentMessage = "Parent directory does not exist inside the managed server directory";
export const inaccessibleServerRootMessage = "Managed server root directory is not accessible";

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
    throw pathSafetyError(inaccessibleServerRootMessage, "ENOENT");
  }
}

async function ensureWritableTargetInsideServer(server: ServerPathScope, target: string) {
  const serverDir = await realServerDir(server);
  let realParent: string;
  try {
    realParent = await realpath(dirname(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw pathSafetyError(missingParentMessage, "ENOENT");
    }
    throw error;
  }
  if (normalizedPath(realParent) !== normalizedPath(serverDir)) {
    assertPathInside(serverDir, realParent, "Path escapes the managed server directory through a symlink");
  }
  try {
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink()) {
      throw pathSafetyError("Refusing to write through a symbolic link inside the managed server directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
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
      throw pathSafetyError(missingPathMessage, "ENOENT");
    }
    throw error;
  }
  assertPathInside(serverDir, realTarget, "Path escapes the managed server directory through a symlink");
  return target;
}

export async function ensureWritableInsideServer(server: ServerPathScope, userPath = ".") {
  const target = ensureInsideServer(server, userPath);
  return ensureWritableTargetInsideServer(server, target);
}

export async function ensureWritableResolvedInsideServer(server: ServerPathScope, targetPath: string) {
  const target = ensureResolvedInsideServer(server, targetPath);
  return ensureWritableTargetInsideServer(server, target);
}

/**
 * Containment validation and the filesystem call that follows are two separate resolutions of the same
 * pathname, and a managed workload has write access inside its own server root. Between the two it can
 * replace the final component with a symlink, so the panel validates one inode and reads another.
 *
 * These helpers close that window by resolving the path exactly once: open the file, then answer every
 * later question (size, type, contents) from the resulting handle. `O_NOFOLLOW` additionally refuses a
 * final-component symlink outright; it is POSIX-only, and the panel image is Linux, so on Windows the
 * single-resolution property still holds while the explicit refusal does not.
 *
 * An ancestor *directory* swapped between validation and open is not covered — that needs per-component
 * `openat`, which Node does not expose. `validateExistingInsideServer` still realpath-checks ancestors,
 * so this narrows the window to a directory rename racing a single open.
 */
const openNoFollowSupported = typeof fsConstants.O_NOFOLLOW === "number";

function noFollowReadFlags() {
  return openNoFollowSupported ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW : fsConstants.O_RDONLY;
}

function symlinkRefusal(): never {
  throw pathSafetyError("Refusing to read through a symbolic link inside the managed server directory", "ELOOP");
}

/**
 * The opened inode is not a regular file. Either the path was swapped for a directory or device node
 * after validation, or the caller was handed something it should not read in the first place.
 */
function notRegularFileRefusal(): never {
  throw pathSafetyError("Path inside the managed server directory is not a regular file", "EINVAL");
}

/** Opens a validated path without following a final-component symlink. Caller must close the handle. */
export async function openContainedFile(target: string): Promise<FileHandle> {
  try {
    return await open(target, noFollowReadFlags());
  } catch (error) {
    // Linux reports ELOOP for O_NOFOLLOW on a symlink; some filesystems report EMLINK.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") symlinkRefusal();
    throw error;
  }
}

/**
 * Stats a validated path through an open handle so the stat and any later read cannot disagree. Rejects
 * anything that is not a regular file, which also covers a swap to a directory or device node.
 */
export async function statContainedFile(target: string): Promise<Stats> {
  const handle = await openContainedFile(target);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) notRegularFileRefusal();
    return stats;
  } finally {
    await handle.close();
  }
}

/** Reads a validated path in one resolution, enforcing `maxBytes` against the opened inode's own size. */
export async function readContainedFile(target: string, maxBytes?: number): Promise<Buffer> {
  const handle = await openContainedFile(target);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) notRegularFileRefusal();
    if (maxBytes !== undefined && stats.size > maxBytes) {
      throw pathSafetyError(`File is larger than the ${maxBytes} byte limit`, "EFBIG");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Opens a validated path for streaming and reports the size of the inode actually opened, so callers
 * enforce download limits against the bytes they are about to send rather than a prior `stat`.
 */
export async function openContainedReadStream(target: string): Promise<{ stream: Readable; size: number; mtime: Date }> {
  const handle = await openContainedFile(target);
  let stats: Stats;
  try {
    stats = await handle.stat();
    if (!stats.isFile()) notRegularFileRefusal();
  } catch (error) {
    await handle.close();
    throw error;
  }
  // The stream owns the handle and closes it when it ends or is destroyed, so the descriptor is never
  // reopened by name and never double-closed.
  return { stream: handle.createReadStream(), size: stats.size, mtime: stats.mtime };
}

export function normalizePublicFilePath(path: string) {
  if (typeof path !== "string" || path.includes("\0") || path.includes("\\") || /[\r\n]/.test(path)) {
    throw new Error("File path contains invalid characters");
  }
  if (!path.startsWith("/")) {
    throw new Error("File path must be absolute");
  }
  if (path === "/") return "/";
  if (path.endsWith("/")) {
    throw new Error("File path must not have a trailing slash");
  }
  const segments = path.slice(1).split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("File path must be normalized");
  }
  return `/${segments.join("/")}`;
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

type ParsedCron = {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
};

const parsedCronCache = new Map<string, ParsedCron | null>();
const parsedCronCacheLimit = 500;

function parseCron(cron: string) {
  const cached = parsedCronCache.get(cron);
  if (cached !== undefined) return cached;
  const parts = cron.trim().split(/\s+/);
  let parsed: ParsedCron | null = null;
  if (parts.length === 5) {
    const minutes = parseCronField(parts[0], 0, 59);
    const hours = parseCronField(parts[1], 0, 23);
    const daysOfMonth = parseCronField(parts[2], 1, 31);
    const months = parseCronField(parts[3], 1, 12);
    const daysOfWeek = parseCronField(parts[4], 0, 7);
    if (minutes && hours && daysOfMonth && months && daysOfWeek) {
      parsed = { minutes, hours, daysOfMonth, months, daysOfWeek };
    }
  }
  if (parsedCronCache.size >= parsedCronCacheLimit) parsedCronCache.clear();
  parsedCronCache.set(cron, parsed);
  return parsed;
}

function cronDateMatches(parsed: ParsedCron, date: Date) {
  const normalizedDay = date.getDay();
  return parsed.minutes.has(date.getMinutes())
    && parsed.hours.has(date.getHours())
    && parsed.daysOfMonth.has(date.getDate())
    && parsed.months.has(date.getMonth() + 1)
    && (parsed.daysOfWeek.has(normalizedDay) || (normalizedDay === 0 && parsed.daysOfWeek.has(7)));
}

export function validateCron(cron: string) {
  if (cron.trim().split(/\s+/).length !== 5) {
    throw new Error("Cron schedule must use five fields: minute hour day month weekday");
  }
  if (!parseCron(cron)) {
    throw new Error("Cron schedule contains an invalid field");
  }
}

export function cronMatches(cron: string, date: Date) {
  validateCron(cron);
  return cronDateMatches(parseCron(cron)!, date);
}

export function timeZoneMinuteKey(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

export function nextCronRun(cron: string, from = new Date(), maxDays = 366) {
  validateCron(cron);
  const parsed = parseCron(cron)!;
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const maxChecks = Math.max(1, maxDays * 24 * 60);
  for (let checked = 0; checked < maxChecks; checked += 1) {
    if (cronDateMatches(parsed, cursor)) {
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
    const portParts = port.split(":");
    if (portParts.length > 2) {
      throw new Error(`Invalid Docker port binding: ${port}`);
    }
    const [hostPort, containerPortWithProtocol] = portParts.length === 2 ? portParts : [port, port];
    const protocolParts = containerPortWithProtocol.split("/");
    if (protocolParts.length > 2) {
      throw new Error(`Invalid Docker port binding: ${port}`);
    }
    const [containerPortNumber, protocol = "tcp"] = protocolParts;
    if (!isValidPort(hostPort) || !isValidPort(containerPortNumber) || (protocol !== "tcp" && protocol !== "udp")) {
      throw new Error(`Invalid Docker port binding: ${port}`);
    }
    const containerPort = `${containerPortNumber}/${protocol}`;
    exposedPorts[containerPort] = {};
    portBindings[containerPort] = [...(portBindings[containerPort] ?? []), { HostPort: hostPort }];
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

export type DockerHostPortBinding = {
  port: string;
  protocol: string;
  key: string;
};

export function dockerHostPortBindings(dockerPorts?: string): DockerHostPortBinding[] {
  const { portBindings } = parseDockerPorts(dockerPorts);
  return Object.entries(portBindings).flatMap(([containerPort, bindings]) => {
    const [, protocol = "tcp"] = containerPort.split("/", 2);
    return bindings.map((binding) => ({
      port: binding.HostPort,
      protocol,
      key: `${binding.HostPort}/${protocol}`
    }));
  });
}
