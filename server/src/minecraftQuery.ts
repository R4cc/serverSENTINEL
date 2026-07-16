import dgram from "node:dgram";
import { randomBytes } from "node:crypto";

export type MinecraftQueryMetrics = {
  responding: true;
  playersOnline: number;
  maxPlayers: number | null;
  playerNames: string[];
};

export type MinecraftQueryErrorCode = "QUERY_TIMEOUT" | "QUERY_RESPONSE_INCOMPLETE" | "QUERY_RESPONSE_INVALID";

export class MinecraftQueryError extends Error {
  constructor(readonly code: MinecraftQueryErrorCode, message: string) {
    super(message);
    this.name = "MinecraftQueryError";
  }
}

type QueryFragment = {
  index: number;
  final: boolean;
  payload: Buffer;
};

const splitHeader = Buffer.from("splitnum\0", "latin1");
const playerMarker = Buffer.from("\0\0\x01player_\0\0", "latin1");
const maximumFragments = 32;
const maximumResponseBytes = 64 * 1024;

export function normalizePlayerNames(names: string[] = []) {
  const unique = new Map<string, string>();
  for (const value of names) {
    const name = value.trim();
    if (name) unique.set(name.toLowerCase(), name);
  }
  return [...unique.values()];
}

function readNullTerminated(buffer: Buffer, start: number) {
  const end = buffer.indexOf(0, start);
  if (end === -1) return { value: buffer.subarray(start).toString("utf8"), next: buffer.length };
  return { value: buffer.subarray(start, end).toString("utf8"), next: end + 1 };
}

function parseKeyValuePayload(payload: Buffer) {
  const values: Record<string, string> = {};
  let offset = 0;
  while (offset < payload.length) {
    const key = readNullTerminated(payload, offset);
    offset = key.next;
    if (!key.value) break;
    const value = readNullTerminated(payload, offset);
    offset = value.next;
    values[key.value] = value.value;
  }
  return { values, offset };
}

function parseNonNegativeInteger(value: string | undefined, field: string, required: boolean) {
  if (value === undefined && !required) return null;
  if (value === undefined || !/^\d+$/.test(value.trim())) {
    throw new MinecraftQueryError("QUERY_RESPONSE_INVALID", `Minecraft Query returned an invalid ${field}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new MinecraftQueryError("QUERY_RESPONSE_INVALID", `Minecraft Query returned an invalid ${field}`);
  }
  return parsed;
}

function parsePlayers(payload: Buffer, offset: number) {
  const markerIndex = payload.indexOf(playerMarker, Math.max(0, offset - 2));
  if (markerIndex === -1) {
    throw new MinecraftQueryError("QUERY_RESPONSE_INCOMPLETE", "Minecraft Query did not return a complete player roster");
  }
  const players: string[] = [];
  let cursor = markerIndex + playerMarker.length;
  let terminated = false;
  while (cursor < payload.length) {
    const player = readNullTerminated(payload, cursor);
    if (player.next === payload.length && payload[payload.length - 1] !== 0) break;
    cursor = player.next;
    if (!player.value) {
      terminated = true;
      break;
    }
    players.push(player.value);
  }
  if (!terminated) {
    throw new MinecraftQueryError("QUERY_RESPONSE_INCOMPLETE", "Minecraft Query returned a truncated player roster");
  }
  return normalizePlayerNames(players);
}

export function parseMinecraftQueryPayload(payload: Buffer): MinecraftQueryMetrics {
  const { values, offset } = parseKeyValuePayload(payload);
  const playersOnline = parseNonNegativeInteger(values.numplayers, "online player count", true)!;
  const maxPlayers = parseNonNegativeInteger(values.maxplayers, "maximum player count", false);
  const playerNames = parsePlayers(payload, offset);
  if (playerNames.length !== playersOnline) {
    throw new MinecraftQueryError(
      "QUERY_RESPONSE_INCOMPLETE",
      `Minecraft Query returned ${playersOnline} online players but ${playerNames.length} player names`
    );
  }
  if (maxPlayers !== null && maxPlayers < playersOnline) {
    throw new MinecraftQueryError("QUERY_RESPONSE_INVALID", "Minecraft Query returned a maximum below the online player count");
  }
  return { responding: true, playersOnline, maxPlayers, playerNames };
}

export function parseMinecraftQueryFragment(packet: Buffer, expectedSessionId: Buffer): QueryFragment {
  if (packet.length < 16 || packet[0] !== 0 || !packet.subarray(1, 5).equals(expectedSessionId)) {
    throw new MinecraftQueryError("QUERY_RESPONSE_INVALID", "Invalid Minecraft Query stat response");
  }
  if (!packet.subarray(5, 14).equals(splitHeader)) {
    throw new MinecraftQueryError("QUERY_RESPONSE_INVALID", "Minecraft Query stat response is missing its split header");
  }
  const sequence = packet[14];
  return { index: sequence & 0x7f, final: (sequence & 0x80) !== 0, payload: packet.subarray(16) };
}

// Kept as a packet-level parser for focused tests and callers that already have
// one complete full-stat datagram. Network queries use fragment reassembly.
export function parseMinecraftQueryResponse(packet: Buffer, expectedSessionId?: Buffer): MinecraftQueryMetrics {
  if (packet.length < 16 || packet[0] !== 0) {
    throw new MinecraftQueryError("QUERY_RESPONSE_INVALID", "Invalid Minecraft Query stat response");
  }
  if (expectedSessionId && !packet.subarray(1, 5).equals(expectedSessionId)) {
    throw new MinecraftQueryError("QUERY_RESPONSE_INVALID", "Minecraft Query stat response used the wrong session");
  }
  return parseMinecraftQueryPayload(packet.subarray(16));
}

export function parseMinecraftQueryChallenge(packet: Buffer, expectedSessionId: Buffer) {
  if (packet.length < 6 || packet[0] !== 9 || !packet.subarray(1, 5).equals(expectedSessionId)) {
    throw new MinecraftQueryError("QUERY_RESPONSE_INVALID", "Invalid Minecraft Query challenge response");
  }
  const token = readNullTerminated(packet, 5).value.trim();
  if (!/^-?\d+$/.test(token)) {
    throw new MinecraftQueryError("QUERY_RESPONSE_INVALID", "Invalid Minecraft Query challenge token");
  }
  return Number(token);
}

function connectSocket(socket: dgram.Socket, port: number, host: string) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      socket.off("connect", onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.off("error", onError);
      resolve();
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
    socket.connect(port, host);
  });
}

function sendPacket(socket: dgram.Socket, packet: Buffer) {
  return new Promise<void>((resolve, reject) => socket.send(packet, (error) => error ? reject(error) : resolve()));
}

function receiveMatching<T>(socket: dgram.Socket, deadline: number, parse: (packet: Buffer) => T | undefined) {
  return new Promise<T>((resolve, reject) => {
    const remaining = Math.max(1, deadline - Date.now());
    const timeout = setTimeout(() => {
      cleanup();
      reject(new MinecraftQueryError("QUERY_TIMEOUT", "Minecraft Query timed out"));
    }, remaining);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    const onMessage = (packet: Buffer) => {
      try {
        const result = parse(packet);
        if (result === undefined) return;
        cleanup();
        resolve(result);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.on("message", onMessage);
    socket.once("error", onError);
  });
}

async function receiveChallenge(socket: dgram.Socket, sessionId: Buffer, deadline: number, handshake: Buffer) {
  const response = receiveMatching(socket, deadline, (packet) => {
    if (packet.length < 5 || packet[0] !== 9 || !packet.subarray(1, 5).equals(sessionId)) return undefined;
    return parseMinecraftQueryChallenge(packet, sessionId);
  });
  await sendPacket(socket, handshake);
  return response;
}

async function receiveFullStat(socket: dgram.Socket, sessionId: Buffer, deadline: number, request: Buffer) {
  const fragments = new Map<number, Buffer>();
  let finalIndex: number | undefined;
  let totalBytes = 0;
  const response = receiveMatching(socket, deadline, (packet) => {
    if (packet.length < 5 || packet[0] !== 0 || !packet.subarray(1, 5).equals(sessionId)) return undefined;
    const fragment = parseMinecraftQueryFragment(packet, sessionId);
    if (fragment.index >= maximumFragments) {
      throw new MinecraftQueryError("QUERY_RESPONSE_INVALID", "Minecraft Query returned too many response fragments");
    }
    const previous = fragments.get(fragment.index);
    if (previous && !previous.equals(fragment.payload)) {
      throw new MinecraftQueryError("QUERY_RESPONSE_INVALID", "Minecraft Query returned conflicting response fragments");
    }
    if (!previous) {
      fragments.set(fragment.index, fragment.payload);
      totalBytes += fragment.payload.length;
      if (totalBytes > maximumResponseBytes) {
        throw new MinecraftQueryError("QUERY_RESPONSE_INVALID", "Minecraft Query response exceeded the size limit");
      }
    }
    if (fragment.final) {
      if (finalIndex !== undefined && finalIndex !== fragment.index) {
        throw new MinecraftQueryError("QUERY_RESPONSE_INVALID", "Minecraft Query returned conflicting final fragments");
      }
      finalIndex = fragment.index;
    }
    if (finalIndex === undefined) return undefined;
    const ordered: Buffer[] = [];
    for (let index = 0; index <= finalIndex; index += 1) {
      const part = fragments.get(index);
      if (!part) return undefined;
      ordered.push(part);
    }
    return Buffer.concat(ordered);
  });
  await sendPacket(socket, request);
  try {
    return await response;
  } catch (error) {
    if (error instanceof MinecraftQueryError && error.code === "QUERY_TIMEOUT" && fragments.size > 0) {
      throw new MinecraftQueryError("QUERY_RESPONSE_INCOMPLETE", "Minecraft Query returned an incomplete fragmented response");
    }
    throw error;
  }
}

async function queryAttempt(host: string, port: number, timeoutMs: number) {
  const socket = dgram.createSocket("udp4");
  const sessionId = randomBytes(4);
  const deadline = Date.now() + timeoutMs;
  try {
    await connectSocket(socket, port, host);
    const handshake = Buffer.concat([Buffer.from([0xfe, 0xfd, 0x09]), sessionId]);
    const challenge = await receiveChallenge(socket, sessionId, deadline, handshake);
    const challengeBytes = Buffer.alloc(4);
    challengeBytes.writeInt32BE(challenge);
    const request = Buffer.concat([Buffer.from([0xfe, 0xfd, 0x00]), sessionId, challengeBytes, Buffer.alloc(4)]);
    const payload = await receiveFullStat(socket, sessionId, deadline, request);
    return parseMinecraftQueryPayload(payload);
  } finally {
    socket.close();
  }
}

export async function queryMinecraftServer(host: string, port: number, timeoutMs = 1500, attempts = 3): Promise<MinecraftQueryMetrics> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await queryAttempt(host, port, timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof MinecraftQueryError) throw lastError;
  throw new MinecraftQueryError("QUERY_TIMEOUT", lastError instanceof Error ? lastError.message : "Minecraft Query failed");
}
