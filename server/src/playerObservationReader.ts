import { MinecraftQueryError, queryMinecraftServer } from "./minecraftQuery.js";
import type { PlayerObservation } from "./playerSnapshots.js";
import type { MinecraftQueryEndpoint } from "./queryEndpoint.js";

type ObservationInput = {
  running: boolean;
  instanceId?: string;
  props: Record<string, string>;
  endpoint: MinecraftQueryEndpoint | null;
  now?: () => Date;
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
  try {
    const result = await queryMinecraftServer(input.endpoint.host, input.endpoint.port);
    return {
      state: "live",
      instanceId,
      online: result.playersOnline,
      maxPlayers: result.maxPlayers ?? maxPlayers,
      names: result.playerNames,
      sampledAt
    };
  } catch (error) {
    const code = error instanceof MinecraftQueryError ? error.code : "QUERY_TIMEOUT";
    return {
      state: "unavailable",
      instanceId,
      maxPlayers,
      attemptedAt: sampledAt,
      code,
      message: error instanceof Error ? error.message : "Minecraft Query failed"
    };
  }
}
