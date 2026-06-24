import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defaultRuntimeDataDir, runtimeDataPaths } from "./storage/runtimePaths.js";

export const defaultServersDockerVolumeName = "serversentinel-minecraft-servers";

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
}

export const config = {
  runtimeMode: runtimeMode as "all-in-one" | "panel" | "node",
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
  port: Number(process.env.PORT ?? "8080"),
  panelUrl,
  joinToken: process.env.SS_JOIN_TOKEN?.trim(),
  nodeName: process.env.SS_NODE_NAME?.trim(),
  nodeDataDir: paths.dataDir,
  nodeDockerDataDir: nodeDockerDataDir || paths.dataDir,
  nodeImage: process.env.SERVERSENTINEL_NODE_IMAGE?.trim(),
  mcjarsBaseUrl: process.env.MCJARS_BASE_URL?.trim() || "https://mcjars.app",
  mcjarsApiKey: process.env.MCJARS_API_KEY?.trim()
};

export const minServerPort = 1000;
export const maxServerPort = 65000;
