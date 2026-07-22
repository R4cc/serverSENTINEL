import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defaultRuntimeDataDir, runtimeDataPaths } from "./storage/runtimePaths.js";

export const defaultServersDockerVolumeName = "serversentinel-minecraft-servers";

function configuredRuntimeTimeZone() {
  const value = process.env.TZ?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "UTC";
  }
}

export const runtimeTimeZone = configuredRuntimeTimeZone();
process.env.TZ = runtimeTimeZone;

function defaultServersDockerVolume(dataDir: string) {
  const configuredVolume = process.env.SERVERSENTINEL_SERVERS_DOCKER_VOLUME?.trim();
  if (configuredVolume !== undefined) {
    return configuredVolume;
  }
  const usesDefaultContainerLayout = dataDir === resolve(defaultRuntimeDataDir)
    && (existsSync("/.dockerenv") || process.env.SERVERSENTINEL_DATA_DIR === defaultRuntimeDataDir);
  return usesDefaultContainerLayout ? defaultServersDockerVolumeName : "";
}

const runtimeMode = process.env.SS_MODE?.trim() || "all-in-one";
if (!["all-in-one", "panel", "node"].includes(runtimeMode)) {
  throw new Error("SS_MODE must be all-in-one, panel, or node");
}

function parseHttpPort(value: string | undefined) {
  const raw = value?.trim() || "8080";
  if (!/^\d+$/.test(raw)) {
    throw new Error("PORT must be a whole number between 1 and 65535");
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a whole number between 1 and 65535");
  }
  return port;
}

function parseByteLimitEnv(name: string, defaultValue: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a whole number of bytes`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive whole number of bytes`);
  }
  return value;
}

function parseCountLimitEnv(name: string, defaultValue: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a whole number`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive whole number`);
  }
  return value;
}

function parseHourDurationEnv(name: string, defaultValue: number) {
  const hours = parseCountLimitEnv(name, defaultValue);
  if (hours > 24 * 365) {
    throw new Error(`${name} must not exceed 8760 hours`);
  }
  return hours * 60 * 60 * 1000;
}

function parseBooleanEnv(name: string, defaultValue = false) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function optionalSecretEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (value.length < 16 || value.length > 256 || /[\r\n\u0000]/.test(value)) {
    throw new Error(`${name} must be 16-256 characters without control characters`);
  }
  return value;
}

const paths = runtimeDataPaths(process.env.SERVERSENTINEL_DATA_DIR);
const panelUrl = process.env.SS_PANEL_URL?.trim();
const nodeDockerDataDir = process.env.SERVERSENTINEL_DOCKER_DATA_DIR?.trim();
if (runtimeMode === "node") {
  if (!panelUrl) {
    throw new Error("SS_PANEL_URL is required when SS_MODE=node");
  }
  if (!nodeDockerDataDir) {
    throw new Error("SERVERSENTINEL_DOCKER_DATA_DIR is required when SS_MODE=node so sibling Minecraft containers can mount the host data root");
  }
  let parsedPanelUrl: URL;
  try {
    parsedPanelUrl = new URL(panelUrl);
  } catch {
    throw new Error("SS_PANEL_URL must be a valid http or https URL");
  }
  if (!["http:", "https:"].includes(parsedPanelUrl.protocol) || parsedPanelUrl.username || parsedPanelUrl.password) {
    throw new Error("SS_PANEL_URL must be a credential-free http or https URL");
  }
}

export const config = {
  runtimeMode: runtimeMode as "all-in-one" | "panel" | "node",
  timeZone: runtimeTimeZone,
  paths,
  dataDir: paths.dataDir,
  databasePath: paths.databasePath,
  serversDir: paths.serversDir,
  backupsDir: paths.backupsDir,
  importsDir: paths.importsDir,
  exportsDir: paths.exportsDir,
  tmpDir: paths.tmpDir,
  serversDockerVolume: defaultServersDockerVolume(paths.dataDir),
  dockerSocket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
  logLevel: process.env.LOG_LEVEL?.trim() || "info",
  port: parseHttpPort(process.env.PORT),
  panelUrl,
  joinToken: process.env.SS_JOIN_TOKEN?.trim(),
  nodeName: process.env.SS_NODE_NAME?.trim(),
  nodeDataDir: paths.dataDir,
  nodeDockerDataDir: nodeDockerDataDir || paths.dataDir,
  nodeImage: process.env.SERVERSENTINEL_NODE_IMAGE?.trim(),
  enableDemo: parseBooleanEnv("SERVERSENTINEL_ENABLE_DEMO"),
  trustProxy: parseBooleanEnv("SERVERSENTINEL_TRUST_PROXY"),
  setupToken: optionalSecretEnv("SERVERSENTINEL_SETUP_TOKEN"),
  exportRetentionMs: parseHourDurationEnv("SERVERSENTINEL_EXPORT_RETENTION_HOURS", 24),
  fileDownloadMaxBytes: parseByteLimitEnv("SERVERSENTINEL_FILE_DOWNLOAD_MAX_BYTES", 512 * 1024 * 1024),
  fileDownloadZipThresholdBytes: parseByteLimitEnv("SERVERSENTINEL_FILE_DOWNLOAD_ZIP_THRESHOLD_BYTES", 128 * 1024 * 1024),
  fileDownloadZipThresholdCount: parseCountLimitEnv("SERVERSENTINEL_FILE_DOWNLOAD_ZIP_THRESHOLD_COUNT", 10),
  fileZipMaxEntries: parseCountLimitEnv("SERVERSENTINEL_FILE_ZIP_MAX_ENTRIES", 10_000),
  fileZipMaxExpandedBytes: parseByteLimitEnv("SERVERSENTINEL_FILE_ZIP_MAX_EXPANDED_BYTES", 512 * 1024 * 1024),
  mcjarsBaseUrl: process.env.MCJARS_BASE_URL?.trim() || "https://mcjars.app",
  mcjarsApiKey: process.env.MCJARS_API_KEY?.trim()
};

export const minServerPort = 1000;
export const maxServerPort = 65000;
