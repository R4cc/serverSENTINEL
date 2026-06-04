import { existsSync } from "node:fs";
import { resolve } from "node:path";

const defaultServersDir = "/data/servers";
export const defaultServersDockerVolumeName = "serversentinel-minecraft-servers";

function defaultServersDockerVolume(serversDir: string) {
  const configuredVolume = process.env.SERVERSENTINEL_SERVERS_DOCKER_VOLUME?.trim();
  if (configuredVolume !== undefined) {
    return configuredVolume;
  }
  const usesDefaultContainerLayout = serversDir === resolve(defaultServersDir)
    && (existsSync("/.dockerenv") || process.env.SERVERSENTINEL_CONFIG_DIR === "/config");
  return usesDefaultContainerLayout ? defaultServersDockerVolumeName : "";
}

const configuredServersDir = resolve(process.env.SERVERSENTINEL_SERVERS_DIR ?? defaultServersDir);
const runtimeMode = process.env.SS_MODE?.trim() || "all-in-one";
if (!["all-in-one", "panel", "node"].includes(runtimeMode)) {
  throw new Error("SS_MODE must be all-in-one, panel, or node");
}

export const config = {
  runtimeMode: runtimeMode as "all-in-one" | "panel" | "node",
  configDir: resolve(process.env.SERVERSENTINEL_CONFIG_DIR ?? "/config"),
  serversDir: configuredServersDir,
  serversDockerVolume: defaultServersDockerVolume(configuredServersDir),
  dockerSocket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
  logLevel: process.env.LOG_LEVEL?.trim() || "info",
  port: Number(process.env.PORT ?? "8080"),
  panelUrl: process.env.SS_PANEL_URL?.trim(),
  joinToken: process.env.SS_JOIN_TOKEN?.trim(),
  nodeName: process.env.SS_NODE_NAME?.trim(),
  nodeDataDir: resolve(process.env.SS_NODE_DATA_DIR ?? "/data"),
  nodeDockerDataDir: process.env.SS_NODE_DOCKER_DATA_DIR?.trim() || resolve(process.env.SS_NODE_DATA_DIR ?? "/data"),
  nodeImage: process.env.SERVERSENTINEL_NODE_IMAGE?.trim()
};

export const minServerPort = 1000;
export const maxServerPort = 65000;
