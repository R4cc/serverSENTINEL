import type { ManagedNode } from "../types.js";

export const nodeProtocolVersion = "2.0";

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
  "server.queryMetrics",
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
  "files.copy",
  "files.mkdir",
  "mods.list",
  "mods.install",
  "mods.upload",
  "mods.enableDisable",
  "mods.remove"
] as const;

export type NodeCapability = typeof nodeCapabilities[number];

export type NodeRuntimeMode = "node";

export type NodeOperationContract = {
  server: NodeCapability[];
  files: NodeCapability[];
  mods: NodeCapability[];
};

export type NodeDockerStatus = {
  available: boolean;
  status: "available" | "unavailable";
};

export type NodeDataRootStatus = {
  root: string;
  dockerRoot: string;
  status: "ready" | "missing";
};

export type NodeHello = {
  type: "hello";
  nodeId: string | null;
  nodeSecret?: string;
  joinToken?: string;
  nodeName: string;
  agentVersion: string;
  buildId?: string;
  protocolVersion: string;
  capabilities: string[];
  runtimeMode: NodeRuntimeMode;
  dataRoot: NodeDataRootStatus;
  docker: NodeDockerStatus;
  dockerStatus: string;
  dataPathStatus: string;
  totalMemory: number;
  operations: NodeOperationContract;
};

export type PanelWelcome = {
  type: "welcome";
  nodeId: string;
  nodeSecret?: string;
  protocolVersion: string;
  accepted: boolean;
  compatibility: "compatible" | "incompatible";
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
    }
  | {
      type: "empty";
      message?: string;
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

export const nodeOperationContract: NodeOperationContract = {
  server: [
    "server.create",
    "server.update",
    "server.delete",
    "server.start",
    "server.stop",
    "server.restart",
    "server.inspect",
    "server.stats",
    "server.queryMetrics",
    "server.logs.recent",
    "server.console.send",
    "server.console.stream"
  ],
  files: [
    "files.list",
    "files.read",
    "files.write",
    "files.upload",
    "files.download",
    "files.delete",
    "files.rename",
    "files.copy",
    "files.mkdir"
  ],
  mods: [
    "mods.list",
    "mods.install",
    "mods.upload",
    "mods.enableDisable",
    "mods.remove"
  ]
};

const nodeCapabilitySet = new Set<string>(nodeCapabilities);

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
  if (!protocolCompatible(node.protocolVersion)) {
    throw structuredNodeProtocolError("node_incompatible", `Node ${node.name} uses unsupported protocol ${node.protocolVersion ?? "unknown"}; protocol ${nodeProtocolVersion} is required`);
  }
  if (!node.capabilities?.includes(command)) {
    throw structuredNodeProtocolError("missing_capability", `Node ${node.name} does not advertise ${command}`);
  }
}

export function nodeAdvertisesCapability(node: ManagedNode, command: NodeCapability) {
  return protocolCompatible(node.protocolVersion) && node.capabilities?.includes(command) === true;
}

export function normalizeNodeHello(value: unknown): NodeHello {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Node hello must be a JSON object");
  }
  const hello = value as Record<string, unknown>;
  if (hello.type !== "hello") throw new Error("Node hello type must be hello");
  const protocolVersion = requiredString(hello.protocolVersion, "protocolVersion");
  if (!protocolCompatible(protocolVersion)) {
    throw new Error(`Unsupported node protocol ${protocolVersion}; protocol ${nodeProtocolVersion} is required`);
  }
  const nodeId = hello.nodeId === null ? null : optionalString(hello.nodeId, "nodeId") ?? null;
  const nodeName = requiredString(hello.nodeName, "nodeName");
  const agentVersion = requiredString(hello.agentVersion, "agentVersion");
  const buildId = optionalString(hello.buildId, "buildId");
  const capabilities = requiredStringArray(hello.capabilities, "capabilities");
  const unsupportedCapabilities = capabilities.filter((capability) => !isNodeCapability(capability));
  if (unsupportedCapabilities.length) {
    throw new Error(`Node advertised unsupported capabilities: ${unsupportedCapabilities.join(", ")}`);
  }
  if (hello.runtimeMode !== "node") throw new Error("Node runtimeMode must be node");
  const dataRoot = objectValue(hello.dataRoot, "dataRoot");
  const docker = objectValue(hello.docker, "docker");
  const operations = objectValue(hello.operations, "operations");
  const normalized: NodeHello = {
    type: "hello",
    nodeId,
    nodeSecret: optionalString(hello.nodeSecret, "nodeSecret"),
    joinToken: optionalString(hello.joinToken, "joinToken"),
    nodeName,
    agentVersion,
    buildId,
    protocolVersion,
    capabilities,
    runtimeMode: "node",
    dataRoot: {
      root: requiredString(dataRoot.root, "dataRoot.root"),
      dockerRoot: requiredString(dataRoot.dockerRoot, "dataRoot.dockerRoot"),
      status: dataRoot.status === "ready" || dataRoot.status === "missing" ? dataRoot.status : (() => { throw new Error("dataRoot.status must be ready or missing"); })()
    },
    docker: {
      available: typeof docker.available === "boolean" ? docker.available : (() => { throw new Error("docker.available must be a boolean"); })(),
      status: docker.status === "available" || docker.status === "unavailable" ? docker.status : (() => { throw new Error("docker.status must be available or unavailable"); })()
    },
    dockerStatus: requiredString(hello.dockerStatus, "dockerStatus"),
    dataPathStatus: requiredString(hello.dataPathStatus, "dataPathStatus"),
    totalMemory: positiveNumber(hello.totalMemory, "totalMemory"),
    operations: {
      server: requiredCapabilities(operations.server, "operations.server"),
      files: requiredCapabilities(operations.files, "operations.files"),
      mods: requiredCapabilities(operations.mods, "operations.mods")
    }
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

function requiredCapabilities(value: unknown, field: string): NodeCapability[] {
  return requiredStringArray(value, field).map(requireNodeCapability);
}

function requiredStringArray(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => requiredString(item, `${field}[${index}]`));
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
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
