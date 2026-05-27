import { existsSync } from "node:fs";
import { resolve } from "node:path";

const defaultServersDir = "/data/servers";
export const legacyDefaultServersDockerVolume = "serversentinel-minecraft-servers";

function defaultServersDockerVolume(serversDir: string) {
  const configuredVolume = process.env.SERVERSENTINEL_SERVERS_DOCKER_VOLUME?.trim();
  if (configuredVolume !== undefined) {
    return configuredVolume;
  }
  const usesDefaultContainerLayout = serversDir === resolve(defaultServersDir)
    && (existsSync("/.dockerenv") || process.env.SERVERSENTINEL_CONFIG_DIR === "/config");
  return usesDefaultContainerLayout ? legacyDefaultServersDockerVolume : "";
}

const configuredServersDir = resolve(process.env.SERVERSENTINEL_SERVERS_DIR ?? defaultServersDir);

export const config = {
  configDir: resolve(process.env.SERVERSENTINEL_CONFIG_DIR ?? "/config"),
  serversDir: configuredServersDir,
  serversDockerVolume: defaultServersDockerVolume(configuredServersDir),
  dockerSocket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
  port: Number(process.env.PORT ?? "8080")
};

export const minServerPort = 1000;
export const maxServerPort = 65000;
