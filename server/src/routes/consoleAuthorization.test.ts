import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { Session, StoredUser } from "../types.js";
import { registerServerRoutes } from "./serverRoutes.js";

const state = vi.hoisted(() => ({
  session: undefined as Session | undefined,
  user: undefined as StoredUser | undefined,
  attach: vi.fn(),
  detach: vi.fn(),
  start: vi.fn()
}));
vi.mock("../appServices.js", () => ({
  runtimeForNodeId: vi.fn(), runtimeForServer: vi.fn(),
  services: {
    sessionsRepository: { find: () => state.session, delete: () => { state.session = undefined; } },
    usersRepository: { findById: () => state.user }
  }
}));
vi.mock("../servers/store.js", () => ({ getServer: async () => ({ id: "server" }), listManagedServers: async () => [] }));
vi.mock("../servers/consoleService.js", () => ({ consoleHub: { attach: state.attach } }));

let app: FastifyInstance;
let socket: WebSocket | undefined;
beforeEach(async () => {
  state.session = { id: "token", userId: "user", createdAt: new Date().toISOString() };
  state.user = { id: "user", username: "viewer", permissions: ["console.view"] } as StoredUser;
  state.start.mockReset();
  state.detach.mockReset();
  state.attach.mockReset().mockResolvedValue({ backlog: { epoch: "epoch", lines: [] }, start: state.start, detach: state.detach });
  app = Fastify();
  await app.register(websocket);
  registerServerRoutes(app);
  await app.ready();
});
afterEach(async () => {
  socket?.terminate();
  socket = undefined;
  await app.close();
});

async function connect() {
  socket = await app.injectWS("/ws/console?serverId=server", { headers: { cookie: "serversentinel_session=token" } });
  return socket;
}

describe("console socket session revocation", () => {
  it.each(["missing session", "missing permission"])("rejects and closes an unauthorized console socket with %s", async (reason) => {
    if (reason === "missing session") state.session = undefined;
    else state.user!.permissions = [];
    const closed = Promise.withResolvers<number>();
    socket = await app.injectWS("/ws/console?serverId=server", { headers: { cookie: "serversentinel_session=token" } }, {
      onInit: (client) => { client.once("close", (code) => closed.resolve(code)); }
    });
    expect(await closed.promise).toBe(1008);
    expect(state.attach).not.toHaveBeenCalled();
  });

  it.each(["logout", "permission removal"])("closes a live socket and suppresses subsequent output after %s", async (reason) => {
    const client = await connect();
    await vi.waitFor(() => expect(state.start).toHaveBeenCalledOnce());
    const messages: string[] = [];
    client.on("message", (raw) => { messages.push(raw.toString()); });
    const closed = new Promise<number>((resolve) => client.once("close", (code) => resolve(code)));
    if (reason === "logout") state.session = undefined;
    else state.user!.permissions = [];
    const subscriber = state.attach.mock.calls[0][1];
    subscriber.lines([{ seq: 1, text: "private output after revocation" }], "epoch");
    expect(await closed).toBe(1008);
    expect(messages.join("")).not.toContain("private output after revocation");
    await vi.waitFor(() => expect(state.detach).toHaveBeenCalledOnce());
  });

  it("detaches an upstream that finishes connecting after the session was revoked", async () => {
    const pending = Promise.withResolvers<{ backlog: { epoch: string; lines: unknown[] }; start: () => void; detach: () => void }>();
    state.attach.mockReturnValue(pending.promise);
    const client = await connect();
    await vi.waitFor(() => expect(state.attach).toHaveBeenCalledOnce());
    const closed = new Promise<number>((resolve) => client.once("close", (code) => resolve(code)));
    state.session = undefined;
    pending.resolve({ backlog: { epoch: "epoch", lines: [] }, start: state.start, detach: state.detach });
    expect(await closed).toBe(1008);
    expect(state.start).not.toHaveBeenCalled();
    // The close listener and the attachment completion can both detach; it is idempotent in the hub.
    expect(state.detach).toHaveBeenCalled();
  });
});
