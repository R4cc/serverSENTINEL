import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { validateDockerContainerName } from "../http/validation.js";
import type { ManagedServer } from "../types.js";

export function newServerId() {
  return randomUUID();
}

export function serverStorageName(serverId: string) {
  return serverId;
}

export function defaultServerContainerName(serverId: string) {
  return `serversentinel-${serverId}`;
}

/** The server's configured container name, or its default one, validated either way. */
export function dockerContainerName(server: Pick<ManagedServer, "id" | "dockerContainer">) {
  if (server.dockerContainer?.trim()) {
    return validateDockerContainerName(server.dockerContainer);
  }
  return validateDockerContainerName(defaultServerContainerName(server.id));
}

export function serverDirectory(serversDir: string, serverId: string) {
  return resolve(serversDir, serverStorageName(serverId));
}

export function isInsideServersDirectory(serversDir: string, serverDir: string) {
  const root = resolve(serversDir);
  const target = resolve(serverDir);
  const comparableRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const comparableTarget = process.platform === "win32" ? target.toLowerCase() : target;
  return comparableTarget === comparableRoot || comparableTarget.startsWith(comparableRoot + sep);
}
