import type { ManagedNode } from "../types.js";

export const nodeProtocolVersion = "3.0";
export const nodeUpgradeProtocolVersion = "2.0";

export const nodeCapabilities = [
  "node.health",
  "node.update",
  "node.restart",
  "node.remove",
  "docker.info",
  "server.create",
  "server.update",
  "server.delete",
  "server.start",
  "server.stop",
  "server.restart",
  "server.inspect",
  "server.stats",
  "server.players.read",
  "server.logs.recent",
  "server.console.send",
  "server.console.stream",
  "files.list",
  "files.read",
  "files.write",
  "files.upload",
  "files.download",
  "files.delete",
  "files.rename",
  "files.move",
  "files.copy",
  "files.mkdir",
  "files.archive.list",
  "files.archive.read",
  "files.archive.download",
  "files.archive.plan",
  "files.archive.extract",
  "mods.list",
  "mods.install",
  "mods.upload",
  "mods.enableDisable",
  "mods.remove",
  "mods.liveMutation"
] as const;

export type NodeCapability = typeof nodeCapabilities[number];

export type NodeHello = {
  type: "hello";
  nodeId: string | null;
  nodeSecret?: string;
  joinToken?: string;
  nodeName: string;
  agentVersion: string;
  buildId?: string;
  startupId?: string;
  protocolVersion: string;
  capabilities: string[];
  dockerStatus: string;
  dataPathStatus: string;
  totalMemory: number;
};

export type PanelWelcome = {
  type: "welcome";
  nodeId: string;
  nodeSecret?: string;
  accepted: boolean;
  timeZone?: string;
  error?: string;
};

export type NodeRequestMessage = {
  type: "request";
  id: string;
  command: string;
  payload?: unknown;
};

export type NodeStreamStartMessage = {
  type: "streamStart";
  id: string;
  command: string;
  payload?: unknown;
};

export type NodeStreamStopMessage = {
  type: "streamStop";
  id: string;
};

export type NodeStreamEvent =
  | {
      type: "log";
      source: string;
      text: string;
      at: string;
    }
  | {
      type: "unavailable";
      message: string;
      code?: string;
      retryable?: boolean;
    }
  | {
      type: "empty";
      message?: string;
    }
  | {
      type: "progress";
      progress: number;
      task: string;
    }
  | {
      type: "result";
      result: unknown;
    };

export type NodeStreamDataMessage = {
  type: "streamData";
  id: string;
  event: NodeStreamEvent;
};

export type NodeStreamEndMessage = {
  type: "streamEnd";
  id: string;
  error?: {
    code: string;
    message: string;
    details?: string;
  };
};

export type NodeResponseMessage = {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    details?: string;
  };
};

export function protocolCompatible(version?: string) {
  return version === nodeProtocolVersion;
}

export function protocolCanSelfUpdate(version?: string) {
  return version === nodeProtocolVersion || version === nodeUpgradeProtocolVersion;
}

const nodeCapabilitySet = new Set<string>(nodeCapabilities);
const legacyNodeCapabilitySet = new Set<string>([
  ...nodeCapabilities.filter((capability) => capability !== "server.players.read"),
  "server.queryMetrics"
]);

export function isNodeCapability(value: unknown): value is NodeCapability {
  return typeof value === "string" && nodeCapabilitySet.has(value);
}

export function requireNodeCapability(value: string): NodeCapability {
  if (!isNodeCapability(value)) {
    throw structuredNodeProtocolError("unsupported_node_command", `Command ${value} is not supported by this panel`);
  }
  return value;
}

export function assertNodeSupports(node: ManagedNode, command: NodeCapability) {
  if (command === "node.update" && protocolCanSelfUpdate(node.protocolVersion) && node.capabilities?.includes(command)) return;
  if (!protocolCompatible(node.protocolVersion)) {
    throw structuredNodeProtocolError("node_incompatible", `Node ${node.name} uses unsupported protocol ${node.protocolVersion ?? "unknown"}; protocol ${nodeProtocolVersion} is required`);
  }
  if (!node.capabilities?.includes(command)) {
    throw structuredNodeProtocolError("missing_capability", `Node ${node.name} does not advertise ${command}`);
  }
}

export function nodeAdvertisesCapability(node: ManagedNode, command: NodeCapability) {
  if (command === "node.update" && protocolCanSelfUpdate(node.protocolVersion)) return node.capabilities?.includes(command) === true;
  return protocolCompatible(node.protocolVersion) && node.capabilities?.includes(command) === true;
}

export function normalizeNodeHello(value: unknown): NodeHello {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Node hello must be a JSON object");
  }
  const hello = value as Record<string, unknown>;
  if (hello.type !== "hello") throw new Error("Node hello type must be hello");
  const protocolVersion = requiredString(hello.protocolVersion, "protocolVersion");
  if (!protocolCompatible(protocolVersion) && protocolVersion !== nodeUpgradeProtocolVersion) {
    throw new Error(`Unsupported node protocol ${protocolVersion}; protocol ${nodeProtocolVersion} is required`);
  }
  const nodeId = hello.nodeId === null ? null : optionalString(hello.nodeId, "nodeId") ?? null;
  const nodeName = requiredString(hello.nodeName, "nodeName");
  const agentVersion = requiredString(hello.agentVersion, "agentVersion");
  const buildId = optionalString(hello.buildId, "buildId");
  const startupId = optionalString(hello.startupId, "startupId");
  const capabilities = requiredStringArray(hello.capabilities, "capabilities");
  const allowedCapabilities = protocolVersion === nodeUpgradeProtocolVersion ? legacyNodeCapabilitySet : nodeCapabilitySet;
  const unsupportedCapabilities = capabilities.filter((capability) => !allowedCapabilities.has(capability));
  if (unsupportedCapabilities.length) {
    throw new Error(`Node advertised unsupported capabilities: ${unsupportedCapabilities.join(", ")}`);
  }
  if (protocolVersion === nodeUpgradeProtocolVersion && !capabilities.includes("node.update")) {
    throw new Error(`Node protocol ${nodeUpgradeProtocolVersion} is accepted only for self-update and must advertise node.update`);
  }
  const normalized: NodeHello = {
    type: "hello",
    nodeId,
    nodeSecret: optionalString(hello.nodeSecret, "nodeSecret"),
    joinToken: optionalString(hello.joinToken, "joinToken"),
    nodeName,
    agentVersion,
    buildId,
    startupId,
    protocolVersion,
    capabilities,
    dockerStatus: requiredString(hello.dockerStatus, "dockerStatus"),
    dataPathStatus: requiredString(hello.dataPathStatus, "dataPathStatus"),
    totalMemory: positiveNumber(hello.totalMemory, "totalMemory")
  };
  if (!nodeId && !normalized.joinToken) {
    throw new Error("Node hello requires nodeId or joinToken");
  }
  if (nodeId && !normalized.nodeSecret) {
    throw new Error("Node hello requires nodeSecret when nodeId is present");
  }
  return normalized;
}

export function structuredNodeProtocolError(code: string, message: string, details?: string) {
  const error = new Error(message) as Error & { code?: string; statusCode?: number; details?: string };
  error.code = code;
  error.statusCode = 400;
  if (details) error.details = details;
  return error;
}

function requiredStringArray(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => requiredString(item, `${field}[${index}]`));
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalString(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a string`);
  return value.trim();
}

function positiveNumber(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${field} must be a positive number`);
  return value;
}
