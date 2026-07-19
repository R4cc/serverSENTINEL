import { MinecraftQueryError, queryMinecraftServer } from "./minecraftQuery.js";
import type { PlayerObservation } from "./playerSnapshots.js";
import type { MinecraftQueryEndpoint } from "./queryEndpoint.js";

type ObservationInput = {
  running: boolean;
  instanceId?: string;
  props: Record<string, string>;
  endpoint: MinecraftQueryEndpoint | null;
  fallbackEndpoints?: MinecraftQueryEndpoint[];
  now?: () => Date;
  queryServer?: typeof queryMinecraftServer;
};

function configuredMaxPlayers(props: Record<string, string>) {
  const value = props["max-players"];
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function readMinecraftPlayerObservation(input: ObservationInput): Promise<PlayerObservation> {
  const sampledAt = (input.now?.() ?? new Date()).toISOString();
  const maxPlayers = configuredMaxPlayers(input.props);
  if (!input.running) {
    return { state: "stopped", instanceId: input.instanceId, maxPlayers, sampledAt };
  }
  const instanceId = input.instanceId?.trim();
  if (!instanceId) {
    return {
      state: "unavailable",
      maxPlayers,
      attemptedAt: sampledAt,
      code: "NODE_UNAVAILABLE",
      message: "The running Minecraft container identity could not be determined"
    };
  }
  if (input.props["enable-query"]?.trim().toLowerCase() !== "true") {
    return {
      state: "unavailable",
      instanceId,
      maxPlayers,
      attemptedAt: sampledAt,
      code: "QUERY_DISABLED",
      message: "Minecraft Query is disabled in server.properties"
    };
  }
  if (!input.endpoint) {
    return {
      state: "unavailable",
      instanceId,
      maxPlayers,
      attemptedAt: sampledAt,
      code: "QUERY_ENDPOINT_UNAVAILABLE",
      message: "The Minecraft Query endpoint could not be resolved"
    };
  }
  const queryServer = input.queryServer ?? queryMinecraftServer;
  let lastError: unknown;
  const endpoints = [input.endpoint, ...(input.fallbackEndpoints ?? [])]
    .filter((endpoint, index, candidates): endpoint is MinecraftQueryEndpoint => Boolean(endpoint)
      && candidates.findIndex((candidate) => candidate?.host === endpoint?.host && candidate?.port === endpoint?.port) === index);
  for (const endpoint of endpoints) {
    try {
      const result = await queryServer(endpoint.host, endpoint.port);
      return {
        state: "live",
        instanceId,
        online: result.playersOnline,
        maxPlayers: result.maxPlayers ?? maxPlayers,
        names: result.playerNames,
        sampledAt
      };
    } catch (error) {
      lastError = error;
    }
  }
  const code = lastError instanceof MinecraftQueryError ? lastError.code : "QUERY_TIMEOUT";
  return {
    state: "unavailable",
    instanceId,
    maxPlayers,
    attemptedAt: sampledAt,
    code,
    message: lastError instanceof Error ? lastError.message : "Minecraft Query failed"
  };
}
