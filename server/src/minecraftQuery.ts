import dgram from "node:dgram";
import { randomBytes } from "node:crypto";

export type MinecraftQueryMetrics = {
  responding: boolean;
  playersOnline: number | null;
  maxPlayers: number | null;
  playerNames?: string[];
  diagnostics?: string[];
};

export function normalizePlayerNames(names?: string[]) {
  return names ? Array.from(new Set(names.map((name) => name.trim()).filter(Boolean))) : undefined;
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

function parsePlayers(payload: Buffer, offset: number) {
  const marker = Buffer.from([0, 1, 0]);
  const markerIndex = payload.indexOf(marker, Math.max(0, offset - 1));
  if (markerIndex === -1) return undefined;
  const label = readNullTerminated(payload, markerIndex + marker.length);
  if (label.value !== "player_") return undefined;
  const players = new Set<string>();
  let cursor = label.next;
  while (cursor < payload.length) {
    const player = readNullTerminated(payload, cursor);
    cursor = player.next;
    if (!player.value) break;
    const name = player.value.trim();
    if (name) players.add(name);
  }
  return normalizePlayerNames(Array.from(players));
}

export function parseMinecraftQueryResponse(packet: Buffer, expectedSessionId?: Buffer): MinecraftQueryMetrics {
  if (packet.length < 5 || packet[0] !== 0) {
    return { responding: false, playersOnline: null, maxPlayers: null };
  }
  if (expectedSessionId && !packet.subarray(1, 5).equals(expectedSessionId)) {
    return { responding: false, playersOnline: null, maxPlayers: null };
  }
  const payload = packet.subarray(16);
  const { values, offset } = parseKeyValuePayload(payload);
  const online = Number(values.numplayers);
  const max = Number(values.maxplayers);
  return {
    responding: true,
    playersOnline: Number.isFinite(online) ? online : null,
    maxPlayers: Number.isFinite(max) ? max : null,
    playerNames: parsePlayers(payload, offset)
  };
}

export function parseMinecraftQueryChallenge(packet: Buffer, expectedSessionId: Buffer) {
  if (packet.length < 6 || packet[0] !== 9 || !packet.subarray(1, 5).equals(expectedSessionId)) {
    throw new Error("Invalid Minecraft Query challenge response");
  }
  const token = readNullTerminated(packet, 5).value.trim();
  if (!/^-?\d+$/.test(token)) {
    throw new Error("Invalid Minecraft Query challenge token");
  }
  return Number(token);
}

function receiveOnce(socket: dgram.Socket, timeoutMs: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Minecraft Query timed out"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    const onMessage = (message: Buffer) => {
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
  });
}

export async function queryMinecraftServer(host: string, port: number, timeoutMs = 1500): Promise<MinecraftQueryMetrics> {
  const socket = dgram.createSocket("udp4");
  const sessionId = randomBytes(4);
  try {
    const handshake = Buffer.concat([Buffer.from([0xfe, 0xfd, 0x09]), sessionId]);
    await new Promise<void>((resolve, reject) => socket.send(handshake, port, host, (error) => error ? reject(error) : resolve()));
    const challenge = parseMinecraftQueryChallenge(await receiveOnce(socket, timeoutMs), sessionId);
    const challengeBytes = Buffer.alloc(4);
    challengeBytes.writeInt32BE(challenge);
    const packet = Buffer.concat([Buffer.from([0xfe, 0xfd, 0x00]), sessionId, challengeBytes, Buffer.alloc(4)]);
    await new Promise<void>((resolve, reject) => socket.send(packet, port, host, (error) => error ? reject(error) : resolve()));
    const response = await receiveOnce(socket, timeoutMs);
    return parseMinecraftQueryResponse(response, sessionId);
  } finally {
    socket.close();
  }
}
