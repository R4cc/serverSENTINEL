import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { dockerAvailable, dockerBufferRequest, dockerJsonRequest, dockerRequest } from "../docker/dockerClient.js";
import type { ManagedServer } from "../types.js";
import { nodeCapabilities, nodeProtocolVersion } from "./protocol.js";
import type { NodeHello, NodeRequestMessage, NodeResponseMessage, PanelWelcome } from "./protocol.js";

type NodeConfig = {
  nodeId: string;
  nodeSecret: string;
};

const nodeConfigPath = join(config.nodeDataDir, "node", "config.json");

async function readNodeConfig() {
  try {
    return JSON.parse(await readFile(nodeConfigPath, "utf8")) as NodeConfig;
  } catch {
    return null;
  }
}

async function writeNodeConfig(nodeConfig: NodeConfig) {
  await mkdir(join(config.nodeDataDir, "node"), { recursive: true });
  await writeFile(nodeConfigPath, `${JSON.stringify(nodeConfig, null, 2)}\n`, "utf8");
}

function panelWebSocketUrl() {
  if (!config.panelUrl) {
    throw new Error("SS_PANEL_URL is required in SS_MODE=node");
  }
  const url = new URL(config.panelUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/nodes/connect";
  url.search = "";
  return url.toString();
}

function containerName(server: ManagedServer) {
  return server.dockerContainer || `serversentinel-${server.id}`;
}

async function inspect(server: ManagedServer) {
  return dockerRequest("GET", `/containers/${encodeURIComponent(containerName(server))}/json`);
}

async function dockerInfo() {
  return {
    available: dockerAvailable(),
    info: dockerAvailable() ? await dockerRequest("GET", "/info").catch((error) => ({ error: (error as Error).message })) : undefined
  };
}

async function handleCommand(command: string, payload: any) {
  const server = payload?.server as ManagedServer | undefined;
  if (command === "node.health") return { ok: true, dockerAvailable: dockerAvailable(), dataPath: config.nodeDataDir };
  if (command === "docker.info") return dockerInfo();
  if (!server) throw new Error("server payload is required");
  const name = encodeURIComponent(containerName(server));
  if (command === "server.inspect") return { server, docker: await inspect(server).catch((error) => ({ error: (error as Error).message })) };
  if (command === "server.start") return dockerRequest("POST", `/containers/${name}/start`, [204, 304]).then(() => ({ ok: true, action: "start" }));
  if (command === "server.stop") return dockerRequest("POST", `/containers/${name}/stop?t=10`, [204, 304]).then(() => ({ ok: true, action: "stop" }));
  if (command === "server.restart") return dockerRequest("POST", `/containers/${name}/restart?t=10`, 204).then(() => ({ ok: true, action: "restart" }));
  if (command === "server.stats") return dockerRequest("GET", `/containers/${name}/stats?stream=false`);
  if (command === "server.logs.recent") {
    const text = (await dockerBufferRequest("GET", `/containers/${name}/logs?stdout=1&stderr=1&tail=300`)).toString("utf8");
    return { text, source: "docker" };
  }
  if (command === "server.console.send") {
    const commandText = typeof payload?.command === "string" ? payload.command.trim() : "";
    if (!commandText) throw new Error("Console command is required");
    const exec = await dockerJsonRequest<{ Id: string }>("POST", `/containers/${name}/exec`, {
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Cmd: ["sh", "-lc", `printf '%s\\n' "$SS_CMD" > /proc/1/fd/0`],
      Env: [`SS_CMD=${commandText}`]
    }, 201);
    await dockerJsonRequest("POST", `/exec/${encodeURIComponent(exec.Id)}/start`, { Detach: false, Tty: false }, 200);
    return { ok: true };
  }
  throw new Error(`Unsupported node command ${command}`);
}

export async function startNodeAgent() {
  await mkdir(config.nodeDataDir, { recursive: true });
  let persisted = await readNodeConfig();
  if (!persisted && !config.joinToken) {
    throw new Error("SS_JOIN_TOKEN is required for first node registration");
  }

  const connect = async () => {
    persisted = await readNodeConfig();
    const socket = new WebSocket(panelWebSocketUrl());
    socket.on("open", () => {
      const hello: NodeHello = {
        type: "hello",
        nodeId: persisted?.nodeId,
        nodeSecret: persisted?.nodeSecret,
        joinToken: persisted ? undefined : config.joinToken,
        nodeName: config.nodeName || basename(config.nodeDataDir) || "Remote Node",
        agentVersion: process.env.npm_package_version ?? "0.2.0",
        protocolVersion: nodeProtocolVersion,
        capabilities: [...nodeCapabilities],
        dockerStatus: dockerAvailable() ? "available" : "unavailable",
        dataPathStatus: existsSync(config.nodeDataDir) ? "ready" : "missing"
      };
      socket.send(JSON.stringify(hello));
    });
    socket.on("message", async (raw) => {
      const message = JSON.parse(raw.toString()) as PanelWelcome | NodeRequestMessage;
      if (message.type === "welcome") {
        if (!message.accepted) throw new Error(message.error ?? "Node registration rejected");
        if (message.nodeSecret) {
          await writeNodeConfig({ nodeId: message.nodeId, nodeSecret: message.nodeSecret });
        }
        return;
      }
      if (message.type !== "request") return;
      const response = async (): Promise<NodeResponseMessage> => {
        try {
          return { type: "response", id: message.id, ok: true, result: await handleCommand(message.command, message.payload) };
        } catch (error) {
          return { type: "response", id: message.id, ok: false, error: { code: "command_failed", message: (error as Error).message } };
        }
      };
      socket.send(JSON.stringify(await response()));
    });
    socket.on("close", () => setTimeout(() => void connect(), 5000).unref());
    socket.on("error", () => socket.close());
  };

  await connect();
}

export function newNodeSecret() {
  return randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
}
