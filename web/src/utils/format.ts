import type { ManagedServer, ModCompatibility, ServerStatus, ThemePreference, LocalePreference, VersionResolution, VersionSource } from '../types';

export const defaultServerPort = 25565;

export const defaultQueryPort = 25566;

export const minServerPort = 1000;

export const maxServerPort = 65000;

export const resourcePollMs = 5_000;

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export function compatibilityLabel(compatibility?: ModCompatibility) {
  if (!compatibility) return "Unknown server support";
  if (compatibility.serverSide === "unsupported") return "Client-only";
  if (compatibility.serverSide === "unknown") return "Unknown server support";
  if (compatibility.status === "unknown") return "Unknown server support";
  if (compatibility.compatible) return "Compatible";
  return "Incompatible";
}

export function compatibilityClass(compatibility?: ModCompatibility) {
  if (!compatibility) return "unknown";
  if (compatibility.serverSide === "unsupported") return "danger";
  if (compatibility.serverSide === "unknown") return "unknown";
  if (compatibility.status === "unknown") return "unknown";
  if (compatibility.compatible) return "ok";
  return "danger";
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

export function defaultDockerImageForMinecraftVersion(version?: string) {
  const [major, minor, patch] = (version ?? "").split(".").map((part) => Number(part));
  if (Number.isFinite(major) && major >= 26) return "eclipse-temurin:25-jre";
  if (major === 1 && Number.isFinite(minor) && minor >= 20 && (minor > 20 || (patch ?? 0) >= 5)) return "eclipse-temurin:21-jre";
  return "eclipse-temurin:17-jre";
}

export function replaceMemoryArgs(javaArgs: string, memoryGb: number, options: { updateInitialHeap?: boolean } = {}) {
  const memory = Math.max(1, Math.round(memoryGb));
  const updateInitialHeap = options.updateInitialHeap ?? true;
  const existingXms = javaArgs.match(/(^|\s)(-Xms\S+)/)?.[2] ?? "";
  const xms = updateInitialHeap ? `-Xms${memory}G` : existingXms;
  const xmx = `-Xmx${memory}G`;
  const withoutXms = javaArgs.replace(/(^|\s)-Xms\S+/g, "").trim();
  const withoutMemory = withoutXms.replace(/(^|\s)-Xmx\S+/g, "").trim();
  return [xms, xmx, withoutMemory].filter(Boolean).join(" ");
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
  return bestVersion(server.resolvedVersions?.minecraftVersion, server.minecraftVersion);
}

export function fabricLoaderVersionInfo(server: ManagedServer) {
  return bestVersion(server.resolvedVersions?.fabricLoaderVersion, server.loaderVersion);
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
  const saved = window.localStorage.getItem("serversentinel-theme");
  return saved === "dark" || saved === "system" || saved === "light" ? saved : "light";
}

export function readLocalePreference(key: "serversentinel-date-locale" | "serversentinel-number-locale"): LocalePreference {
  const saved = window.localStorage.getItem(key);
  return saved === "en-US" || saved === "en-GB" || saved === "de-DE" || saved === "fr-FR" || saved === "ja-JP" || saved === "user"
    ? saved
    : "user";
}
