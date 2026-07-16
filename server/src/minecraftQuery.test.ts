import dgram from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { MinecraftQueryError, parseMinecraftQueryPayload, queryMinecraftServer } from "./minecraftQuery.js";

const sockets: dgram.Socket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
});

function fullPayload(online = 2, names = ["Alex", "Steve"]) {
  return Buffer.concat([
    Buffer.from(`hostname\x00Test Server\x00numplayers\x00${online}\x00maxplayers\x0020\x00`, "utf8"),
    Buffer.from("\0\x01player_\0\0", "latin1"),
    Buffer.from(`${names.join("\0")}\0\0`, "utf8")
  ]);
}

function fragment(sessionId: Buffer, index: number, final: boolean, payload: Buffer) {
  return Buffer.concat([
    Buffer.from([0]),
    sessionId,
    Buffer.from("splitnum\0", "latin1"),
    Buffer.from([(final ? 0x80 : 0) | index, 0]),
    payload
  ]);
}

async function udpServer(onMessage: (server: dgram.Socket, packet: Buffer, port: number, address: string) => void) {
  const server = dgram.createSocket("udp4");
  sockets.push(server);
  server.on("message", (packet, remote) => onMessage(server, packet, remote.port, remote.address));
  await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

describe("Minecraft Query full-stat transport", () => {
  it("reassembles fragmented responses that arrive out of order", async () => {
    const payload = fullPayload();
    const splitAt = payload.indexOf(Buffer.from("\0\0\x01player_", "latin1"));
    const port = await udpServer((server, packet, remotePort, address) => {
      const sessionId = packet.subarray(3, 7);
      if (packet[2] === 9) {
        server.send(Buffer.concat([Buffer.from([9]), sessionId, Buffer.from("123\0")]), remotePort, address);
      } else if (packet[2] === 0) {
        server.send(fragment(sessionId, 1, true, payload.subarray(splitAt)), remotePort, address);
        server.send(fragment(sessionId, 0, false, payload.subarray(0, splitAt)), remotePort, address);
      }
    });

    await expect(queryMinecraftServer("127.0.0.1", port, 250, 1)).resolves.toEqual({
      responding: true,
      playersOnline: 2,
      maxPlayers: 20,
      playerNames: ["Alex", "Steve"]
    });
  });

  it("retries the complete transaction after a dropped handshake", async () => {
    let handshakes = 0;
    const payload = fullPayload(0, []);
    const port = await udpServer((server, packet, remotePort, address) => {
      const sessionId = packet.subarray(3, 7);
      if (packet[2] === 9) {
        handshakes += 1;
        if (handshakes === 1) return;
        server.send(Buffer.concat([Buffer.from([9]), sessionId, Buffer.from("123\0")]), remotePort, address);
      } else if (packet[2] === 0) {
        server.send(fragment(sessionId, 0, true, payload), remotePort, address);
      }
    });

    await expect(queryMinecraftServer("127.0.0.1", port, 100, 2)).resolves.toMatchObject({ playersOnline: 0, playerNames: [] });
    expect(handshakes).toBe(2);
  });

  it("rejects partial rosters instead of publishing count-only data", () => {
    expect(() => parseMinecraftQueryPayload(fullPayload(3, ["Alex", "Steve"]))).toThrowError(MinecraftQueryError);
    expect(() => parseMinecraftQueryPayload(fullPayload(0, []))).not.toThrow();
  });
});
