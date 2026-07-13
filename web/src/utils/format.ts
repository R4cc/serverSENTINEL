import type { DisplayTimeZonePreference, ManagedServer, ServerStatus, ThemePreference, LocalePreference, VersionResolution, VersionSource } from '../types';

export const defaultServerPort = 25565;

export const defaultQueryPort = 25566;

export const minServerPort = 1000;

export const maxServerPort = 65000;

export const resourcePollMs = 5_000;

const resourceHistoryWindowMs = 60 * 60 * 1000;

export const resourceHistorySampleLimit = Math.ceil(resourceHistoryWindowMs / resourcePollMs) + 1;

export function formatTimestampForFilename(value: string | number | Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}-${part("minute")}-${part("second")}`;
}

export function detectedBrowserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function resolveDisplayTimeZone(
  preference: DisplayTimeZonePreference,
  panelTimeZone: string,
  browserTimeZone = detectedBrowserTimeZone()
) {
  if (preference === "browser") return browserTimeZone;
  if (preference === "utc") return "UTC";
  return panelTimeZone;
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export function totalMemoryGb(totalMemory: number) {
  return Math.max(1, totalMemory ? Math.round(totalMemory / (1024 * 1024 * 1024)) : 16);
}

export function parseMaxMemoryGb(javaArgs?: string) {
  return parseJavaMemoryArgs(javaArgs).xmxGb ?? 4;
}

function parseMemoryToken(javaArgs: string, flag: "Xms" | "Xmx") {
  const match = javaArgs.match(new RegExp(`-${flag}(\\d+)([gGmM])`));
  if (!match) return null;
  const value = parseInt(match[1], 10);
  if (!Number.isFinite(value)) return null;
  return match[2].toLowerCase() === "m" ? Math.max(1, Math.round(value / 1024)) : value;
}

export function parseJavaMemoryArgs(javaArgs?: string) {
  const args = javaArgs || "";
  return {
    xmsGb: parseMemoryToken(args, "Xms"),
    xmxGb: parseMemoryToken(args, "Xmx")
  };
}

export function memoryArgs(memoryGb: number) {
  const memory = Math.max(1, Math.round(memoryGb));
  return `-Xms${memory}G -Xmx${memory}G`;
}

export function javaMajorVersionForMinecraft(version: string): 17 | 21 | 25 {
  const modernMajor = version.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (modernMajor && Number(modernMajor[1]) >= 26) return 25;
  const match = version.trim().match(/^1\.(\d+)(?:\.(\d+))?/);
  const minor = Number(match?.[1] ?? "21");
  const patch = Number(match?.[2] ?? "0");
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  return 17;
}

export function defaultDockerImageForMinecraftVersion(version?: string) {
  return `eclipse-temurin:${javaMajorVersionForMinecraft(version ?? "")}-jre`;
}

export function isValidServerPort(port: string) {
  if (!/^\d+$/.test(port)) return false;
  const value = Number(port);
  return value >= minServerPort && value <= maxServerPort;
}

export function runtimeLabel(status: ServerStatus | null, dockerSocketMounted: boolean) {
  if (!status) return "Checking container";
  if (status.docker.container === "serversentinel-demo") return status.docker.running ? "Demo server running" : "Demo server stopped";
  if (!dockerSocketMounted) return "Docker socket not mounted";
  if (!status.docker.configured) return "Container control not configured";
  if (!status.docker.available) return status.docker.message || "Container unavailable";

  const state = status.docker.state?.toLowerCase();
  if (state === "running") return "Container running";
  if (state === "restarting" || state === "starting") return "Container starting";
  if (state === "exited") return "Container exited";
  if (state === "paused") return "Container paused";
  if (state === "dead") return "Container dead";
  if (state === "created" || !status.docker.running) return "Container stopped";

  if (status.docker.state && status.docker.state !== "unknown") return `Container ${status.docker.state}`;
  return "Container status unavailable";
}

export function runtimeTone(status: ServerStatus | null, dockerSocketMounted: boolean) {
  if (!status || !dockerSocketMounted || !status.docker.configured || !status.docker.available) return "neutral";

  const state = status.docker.state?.toLowerCase();
  if (state === "running") return "running";
  if (state === "restarting" || state === "starting") return "starting";
  if (state === "paused") return "neutral";
  if (state === "exited" || state === "dead") return "exited";
  if (state === "created" || !status.docker.running) return "stopped";

  return status.docker.running ? "running" : "stopped";
}

function bestVersion(resolved: VersionResolution | undefined, profileVersion: string | undefined): VersionResolution {
  if (resolved) return resolved;
  return {
    version: profileVersion || undefined,
    source: profileVersion ? "profile" : "unknown",
    lastCheckedAt: ""
  };
}

export function minecraftVersionInfo(server: ManagedServer) {
  return bestVersion(server.resolvedVersions?.minecraftVersion, server.runtimeProfile.minecraftVersion);
}

export function fabricLoaderVersionInfo(server: ManagedServer) {
  return bestVersion(server.resolvedVersions?.fabricLoaderVersion, server.runtimeProfile.loaderVersion);
}

export function versionValue(version: VersionResolution | undefined) {
  return version?.version || "Unknown";
}

export function versionSourceLabel(source: VersionSource) {
  switch (source) {
    case "detected":
      return "Detected from server files";
    case "log":
      return "Detected from logs";
    case "profile":
      return "Runtime profile";
    case "demo":
      return "Demo value";
    default:
      return "Unknown";
  }
}

export function readThemePreference(): ThemePreference {
  try {
    const saved = window.localStorage.getItem("serversentinel-theme");
    return saved === "dark" || saved === "system" || saved === "light" ? saved : "light";
  } catch {
    return "light";
  }
}

export function readLocalePreference(key: "serversentinel-date-locale" | "serversentinel-number-locale"): LocalePreference {
  try {
    const saved = window.localStorage.getItem(key);
    return saved === "en-US" || saved === "en-GB" || saved === "de-DE" || saved === "fr-FR" || saved === "ja-JP" || saved === "user"
      ? saved
      : "user";
  } catch {
    return "user";
  }
}

export function readDisplayTimeZonePreference(): DisplayTimeZonePreference {
  try {
    const saved = window.localStorage.getItem("serversentinel-display-time-zone");
    return saved === "browser" || saved === "utc" || saved === "panel" ? saved : "panel";
  } catch {
    return "panel";
  }
}
