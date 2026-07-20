import type { ManagedNode, ManagedServer } from "../types.js";

export const nodeProtocolVersion = "3.1";
export const nodeFallbackProtocolVersion = "3.0";
export const nodeUpgradeProtocolVersion = "2.0";
export const nodeProtocolControlMessageMaxBytes = 8 * 1024 * 1024;
export const nodeProtocolMaxActiveRequests = 64;
export const nodeProtocolMaxActiveStreams = 32;
export const nodeProtocolMaxActiveTransfers = 4;
export const nodeProtocolObservationBatchSize = 32;
export const nodeProtocolTransferChunkBytes = 256 * 1024;

export const nodeCapabilities = [
  "node.update",
  "node.restart",
  "node.remove",
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
  "server.observe",
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
  "mods.liveMutation",
  "content.list",
  "content.install",
  "content.upload",
  "content.enableDisable",
  "content.remove",
  "content.liveMutation"
] as const;

export const nodeFeatures = ["request-cancel", "binary-transfer"] as const;

export type NodeCapability = typeof nodeCapabilities[number];
export type NodeFeature = typeof nodeFeatures[number];
export type NodeProtocolMode = "current" | "fallback" | "update-only" | "incompatible";

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
  features: NodeFeature[];
  dockerStatus: string;
  dataPathStatus: string;
  totalMemory: number;
};

export type PanelWelcome = {
  type: "welcome";
  nodeId: string;
  nodeSecret?: string;
  accepted: boolean;
  protocolVersion?: string;
  features?: NodeFeature[];
  timeZone?: string;
  error?: string;
};

export type NodeRequestMessage = {
  type: "request";
  id: string;
  command: string;
  payload?: unknown;
  deadlineMs?: number;
};

export type NodeCancelMessage = {
  type: "cancel";
  id: string;
  reason?: string;
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
  | { type: "log"; source: string; text: string; at: string }
  | { type: "unavailable"; message: string; code?: string; retryable?: boolean }
  | { type: "empty"; message?: string }
  | { type: "progress"; progress: number; task: string }
  | { type: "result"; result: unknown };

export type NodeStreamDataMessage = { type: "streamData"; id: string; event: NodeStreamEvent };
export type NodeStreamEndMessage = { type: "streamEnd"; id: string; error?: NodeWireError };

export type NodeWireError = {
  code: string;
  message: string;
  details?: string;
  retryable?: boolean;
};

export type NodeResponseMessage = {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: NodeWireError;
};

export type ServerObservationSection = "status" | "stats" | "players" | "logs" | "overviewFiles";

export type NodeServerSpec = Pick<ManagedServer,
  | "id" | "nodeId" | "displayName" | "serverDir" | "storageName"
  | "dockerContainer" | "dockerImage" | "dockerMountSource" | "dockerWorkingDir" | "dockerPorts" | "managedPorts" | "javaArgs"
  | "runtimeProfile"
>;

export type ServerLogCursor = {
  source: "logs/latest.log" | "docker";
  identity?: string;
  offset?: number;
};

export type ServerObservationItem = {
  server: NodeServerSpec;
  sections: ServerObservationSection[];
  logCursor?: ServerLogCursor;
};

export type ServerObservationRequest = { items: ServerObservationItem[] };
export type ServerObservationResultItem = {
  serverId: string;
  status?: unknown;
  stats?: unknown;
  players?: unknown;
  logs?: { text: string; source: "logs/latest.log" | "docker"; cursor?: ServerLogCursor; reset?: boolean };
  overviewFiles?: { properties?: string; eula?: string };
  errors?: Partial<Record<ServerObservationSection, NodeWireError>>;
};
export type ServerObservationResponse = { observedAt: string; items: ServerObservationResultItem[] };

export function compactNodeServerSpec(server: ManagedServer): NodeServerSpec {
  return {
    id: server.id, nodeId: server.nodeId, displayName: server.displayName, serverDir: server.serverDir, storageName: server.storageName,
    dockerContainer: server.dockerContainer, dockerImage: server.dockerImage, dockerMountSource: server.dockerMountSource, dockerWorkingDir: server.dockerWorkingDir,
    dockerPorts: server.dockerPorts, managedPorts: server.managedPorts, javaArgs: server.javaArgs, runtimeProfile: server.runtimeProfile
  };
}

export function normalizeServerObservationRequest(value: unknown): ServerObservationRequest {
  const request = objectValue(value, "server.observe payload");
  if (!Array.isArray(request.items) || request.items.length < 1 || request.items.length > nodeProtocolObservationBatchSize) {
    throw new Error(`server.observe requires between 1 and ${nodeProtocolObservationBatchSize} items`);
  }
  return { items: request.items.map((raw, index) => {
    const item = objectValue(raw, `server.observe item ${index}`);
    const server = objectValue(item.server, `server.observe item ${index}.server`) as NodeServerSpec;
    wireId(server.id);
    requiredString(server.nodeId, `server.observe item ${index}.server.nodeId`);
    requiredString(server.serverDir, `server.observe item ${index}.server.serverDir`);
    const sections = requiredStringArray(item.sections, `server.observe item ${index}.sections`);
    if (sections.length < 1 || sections.some((section) => !["status", "stats", "players", "logs", "overviewFiles"].includes(section))) throw new Error(`server.observe item ${index} has invalid sections`);
    let logCursor: ServerLogCursor | undefined;
    if (item.logCursor !== undefined) {
      const cursor = objectValue(item.logCursor, `server.observe item ${index}.logCursor`);
      if (cursor.source !== "logs/latest.log" && cursor.source !== "docker") throw new Error("logCursor.source is invalid");
      logCursor = { source: cursor.source, identity: optionalString(cursor.identity, "logCursor.identity"), offset: optionalNonNegativeNumber(cursor.offset, "logCursor.offset") };
    }
    return { server, sections: [...new Set(sections)] as ServerObservationSection[], logCursor };
  }) };
}

export function normalizeServerObservationResponse(value: unknown): ServerObservationResponse {
  const response = objectValue(value, "server.observe response");
  requiredString(response.observedAt, "observedAt");
  if (!Array.isArray(response.items) || response.items.length > nodeProtocolObservationBatchSize) throw new Error("server.observe response items are invalid");
  return { observedAt: response.observedAt as string, items: response.items.map((raw, index) => {
    const item = objectValue(raw, `server.observe response item ${index}`);
    const result: ServerObservationResultItem = { serverId: wireId(item.serverId), status: item.status, stats: item.stats, players: item.players, overviewFiles: item.overviewFiles as ServerObservationResultItem["overviewFiles"] };
    if (item.logs !== undefined) {
      const logs = objectValue(item.logs, `server.observe response item ${index}.logs`);
      if (logs.source !== "logs/latest.log" && logs.source !== "docker") throw new Error("observation logs source is invalid");
      result.logs = { text: wireText(logs.text, "logs.text"), source: logs.source, reset: logs.reset === undefined ? undefined : requiredBoolean(logs.reset, "logs.reset") };
      if (logs.cursor !== undefined) {
        const cursor = objectValue(logs.cursor, "logs.cursor");
        if (cursor.source !== "logs/latest.log" && cursor.source !== "docker") throw new Error("logs.cursor.source is invalid");
        result.logs.cursor = { source: cursor.source, identity: optionalString(cursor.identity, "logs.cursor.identity"), offset: optionalNonNegativeNumber(cursor.offset, "logs.cursor.offset") };
      }
    }
    if (item.errors !== undefined) {
      const errors = objectValue(item.errors, `server.observe response item ${index}.errors`);
      result.errors = {};
      for (const [section, error] of Object.entries(errors)) {
        if (!["status", "stats", "players", "logs", "overviewFiles"].includes(section)) throw new Error(`Unknown observation error section ${section}`);
        const normalizedError = optionalWireError(error);
        if (!normalizedError) throw new Error(`Observation error ${section} is invalid`);
        result.errors[section as ServerObservationSection] = normalizedError;
      }
    }
    return result;
  }) };
}

export type NodeTransferDirection = "upload" | "download";
export type NodeTransferStartMessage = {
  type: "transferStart";
  id: string;
  direction: NodeTransferDirection;
  command: "files.upload" | "files.download" | "files.archive.download" | "mods.upload" | "content.upload";
  payload: unknown;
  size?: number;
  sha256?: string;
  maxBytes?: number;
};
export type NodeTransferReadyMessage = { type: "transferReady"; id: string; size?: number; filename?: string };
export type NodeTransferFinishMessage = { type: "transferFinish"; id: string; size: number; sha256: string };
export type NodeTransferResultMessage = { type: "transferResult"; id: string; ok: boolean; result?: unknown; error?: NodeWireError };
export type NodeTransferCancelMessage = { type: "transferCancel"; id: string; reason?: string };

export type PanelToNodeMessage = PanelWelcome | NodeRequestMessage | NodeCancelMessage | NodeStreamStartMessage | NodeStreamStopMessage | NodeTransferStartMessage | NodeTransferFinishMessage | NodeTransferResultMessage | NodeTransferCancelMessage;
export type NodeToPanelMessage = NodeResponseMessage | NodeStreamDataMessage | NodeStreamEndMessage | NodeTransferReadyMessage | NodeTransferFinishMessage | NodeTransferResultMessage | NodeTransferCancelMessage;

const nodeCapabilitySet = new Set<string>(nodeCapabilities);
const nodeFeatureSet = new Set<string>(nodeFeatures);
const fallbackNodeCapabilitySet = new Set<string>([
  ...nodeCapabilities.filter((capability) => capability !== "server.observe"),
  "node.health",
  "docker.info"
]);
const upgradeNodeCapabilitySet = new Set<string>([
  ...[...fallbackNodeCapabilitySet].filter((capability) => capability !== "server.players.read"),
  "server.queryMetrics"
]);

export function nodeProtocolMode(version?: string): NodeProtocolMode {
  if (version === nodeProtocolVersion) return "current";
  if (version === nodeFallbackProtocolVersion) return "fallback";
  if (version === nodeUpgradeProtocolVersion) return "update-only";
  return "incompatible";
}

export function protocolCompatible(version?: string) {
  const mode = nodeProtocolMode(version);
  return mode === "current" || mode === "fallback";
}

export function protocolCanSelfUpdate(version?: string) {
  return nodeProtocolMode(version) !== "incompatible";
}

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
    throw structuredNodeProtocolError("node_incompatible", `Node ${node.name} uses unsupported protocol ${node.protocolVersion ?? "unknown"}; protocol ${nodeProtocolVersion} or ${nodeFallbackProtocolVersion} is required`);
  }
  if (!node.capabilities?.includes(command)) {
    throw structuredNodeProtocolError("missing_capability", `Node ${node.name} does not advertise ${command}`);
  }
}

export function nodeAdvertisesCapability(node: ManagedNode, command: NodeCapability) {
  if (command === "node.update" && protocolCanSelfUpdate(node.protocolVersion)) return node.capabilities?.includes(command) === true;
  return protocolCompatible(node.protocolVersion) && node.capabilities?.includes(command) === true;
}

export function nodeAdvertisesFeature(node: ManagedNode, feature: NodeFeature) {
  return node.protocolVersion === nodeProtocolVersion && node.features?.includes(feature) === true;
}

export function normalizeNodeHello(value: unknown): NodeHello {
  const hello = objectValue(value, "Node hello");
  if (hello.type !== "hello") throw new Error("Node hello type must be hello");
  const protocolVersion = requiredString(hello.protocolVersion, "protocolVersion");
  const mode = nodeProtocolMode(protocolVersion);
  if (mode === "incompatible") throw new Error(`Unsupported node protocol ${protocolVersion}; protocol ${nodeProtocolVersion} or ${nodeFallbackProtocolVersion} is required`);
  const nodeId = hello.nodeId === null ? null : optionalString(hello.nodeId, "nodeId") ?? null;
  const capabilities = requiredStringArray(hello.capabilities, "capabilities");
  const allowedCapabilities = mode === "current" ? nodeCapabilitySet : mode === "fallback" ? fallbackNodeCapabilitySet : upgradeNodeCapabilitySet;
  const unsupportedCapabilities = capabilities.filter((capability) => !allowedCapabilities.has(capability));
  if (unsupportedCapabilities.length) throw new Error(`Node advertised unsupported capabilities: ${unsupportedCapabilities.join(", ")}`);
  if (mode === "update-only" && !capabilities.includes("node.update")) {
    throw new Error(`Node protocol ${nodeUpgradeProtocolVersion} is accepted only for self-update and must advertise node.update`);
  }
  const rawFeatures = hello.features === undefined && mode !== "current" ? [] : requiredStringArray(hello.features, "features");
  const unsupportedFeatures = rawFeatures.filter((feature) => !nodeFeatureSet.has(feature));
  if (unsupportedFeatures.length) throw new Error(`Node advertised unsupported features: ${unsupportedFeatures.join(", ")}`);
  const normalized: NodeHello = {
    type: "hello",
    nodeId,
    nodeSecret: optionalString(hello.nodeSecret, "nodeSecret"),
    joinToken: optionalString(hello.joinToken, "joinToken"),
    nodeName: requiredString(hello.nodeName, "nodeName"),
    agentVersion: requiredString(hello.agentVersion, "agentVersion"),
    buildId: optionalString(hello.buildId, "buildId"),
    startupId: optionalString(hello.startupId, "startupId"),
    protocolVersion,
    capabilities,
    features: rawFeatures as NodeFeature[],
    dockerStatus: requiredString(hello.dockerStatus, "dockerStatus"),
    dataPathStatus: requiredString(hello.dataPathStatus, "dataPathStatus"),
    totalMemory: positiveNumber(hello.totalMemory, "totalMemory")
  };
  if (!nodeId && !normalized.joinToken) throw new Error("Node hello requires nodeId or joinToken");
  if (nodeId && !normalized.nodeSecret) throw new Error("Node hello requires nodeSecret when nodeId is present");
  return normalized;
}

export function normalizePanelWelcome(value: unknown): PanelWelcome {
  const welcome = objectValue(value, "Panel welcome");
  if (welcome.type !== "welcome") throw new Error("Panel welcome type must be welcome");
  const accepted = requiredBoolean(welcome.accepted, "accepted");
  const rawFeatures = welcome.features === undefined ? [] : requiredStringArray(welcome.features, "features");
  if (rawFeatures.some((feature) => !nodeFeatureSet.has(feature))) throw new Error("Panel welcome contains unsupported features");
  return {
    type: "welcome",
    nodeId: accepted ? requiredString(welcome.nodeId, "nodeId") : optionalString(welcome.nodeId, "nodeId") ?? "",
    nodeSecret: optionalString(welcome.nodeSecret, "nodeSecret"),
    accepted,
    protocolVersion: optionalString(welcome.protocolVersion, "protocolVersion"),
    features: rawFeatures as NodeFeature[],
    timeZone: optionalString(welcome.timeZone, "timeZone"),
    error: optionalString(welcome.error, "error")
  };
}

export function normalizePanelToNodeMessage(value: unknown): PanelToNodeMessage {
  const message = objectValue(value, "Panel message");
  if (message.type === "welcome") return normalizePanelWelcome(message);
  const id = wireId(message.id);
  if (message.type === "request") {
    const command = requiredString(message.command, "command");
    return { type: "request", id, command, payload: command === "server.observe" ? normalizeServerObservationRequest(message.payload) : message.payload, deadlineMs: optionalDuration(message.deadlineMs) };
  }
  if (message.type === "cancel") return { type: "cancel", id, reason: optionalString(message.reason, "reason") };
  if (message.type === "streamStart") return { type: "streamStart", id, command: requiredString(message.command, "command"), payload: message.payload };
  if (message.type === "streamStop") return { type: "streamStop", id };
  if (message.type === "transferStart") {
    const command = requiredString(message.command, "command") as NodeTransferStartMessage["command"];
    if (!["files.upload", "files.download", "files.archive.download", "mods.upload", "content.upload"].includes(command)) throw new Error(`Unsupported transfer command ${command}`);
    const direction = message.direction;
    if (direction !== "upload" && direction !== "download") throw new Error("transfer direction must be upload or download");
    return { type: "transferStart", id, direction, command, payload: message.payload, size: optionalNonNegativeNumber(message.size, "size"), sha256: optionalSha256(message.sha256), maxBytes: optionalPositiveNumber(message.maxBytes, "maxBytes") };
  }
  if (message.type === "transferFinish") return { type: "transferFinish", id, size: nonNegativeNumber(message.size, "size"), sha256: requiredSha256(message.sha256) };
  if (message.type === "transferResult") return { type: "transferResult", id, ok: requiredBoolean(message.ok, "ok"), result: message.result, error: optionalWireError(message.error) };
  if (message.type === "transferCancel") return { type: "transferCancel", id, reason: optionalString(message.reason, "reason") };
  throw new Error(`Unsupported panel message type ${String(message.type)}`);
}

export function encodeTransferChunk(id: string, payload: Buffer) {
  if (payload.byteLength > nodeProtocolTransferChunkBytes) throw new Error("Transfer chunk exceeds the 256 KiB protocol limit");
  const uuid = Buffer.from(id.replaceAll("-", ""), "hex");
  if (uuid.byteLength !== 16) throw new Error("Transfer id must be a UUID");
  return Buffer.concat([Buffer.from([0x01]), uuid, payload]);
}

export function decodeTransferChunk(frame: Buffer) {
  if (frame.byteLength < 17 || frame[0] !== 0x01 || frame.byteLength > 17 + nodeProtocolTransferChunkBytes) {
    throw new Error("Invalid binary transfer frame");
  }
  const hex = frame.subarray(1, 17).toString("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { id, payload: frame.subarray(17) };
}

export function normalizeNodeToPanelMessage(value: unknown): NodeToPanelMessage {
  const message = objectValue(value, "Node message");
  const id = wireId(message.id);
  if (message.type === "response") return { type: "response", id, ok: requiredBoolean(message.ok, "ok"), result: message.result, error: optionalWireError(message.error) };
  if (message.type === "streamData") return { type: "streamData", id, event: normalizeNodeStreamEvent(message.event) };
  if (message.type === "streamEnd") return { type: "streamEnd", id, error: optionalWireError(message.error) };
  if (message.type === "transferReady") return { type: "transferReady", id, size: optionalNonNegativeNumber(message.size, "size"), filename: optionalString(message.filename, "filename") };
  if (message.type === "transferFinish") return { type: "transferFinish", id, size: nonNegativeNumber(message.size, "size"), sha256: requiredSha256(message.sha256) };
  if (message.type === "transferResult") return { type: "transferResult", id, ok: requiredBoolean(message.ok, "ok"), result: message.result, error: optionalWireError(message.error) };
  if (message.type === "transferCancel") return { type: "transferCancel", id, reason: optionalString(message.reason, "reason") };
  throw new Error(`Unsupported node message type ${String(message.type)}`);
}

export function structuredNodeProtocolError(code: string, message: string, details?: string) {
  const error = new Error(message) as Error & { code?: string; statusCode?: number; details?: string };
  error.code = code;
  error.statusCode = 400;
  if (details) error.details = details;
  return error;
}

function optionalWireError(value: unknown): NodeWireError | undefined {
  if (value === undefined || value === null) return undefined;
  const error = objectValue(value, "error");
  return { code: requiredString(error.code, "error.code"), message: requiredString(error.message, "error.message"), details: optionalString(error.details, "error.details"), retryable: error.retryable === undefined ? undefined : requiredBoolean(error.retryable, "error.retryable") };
}

function normalizeNodeStreamEvent(value: unknown): NodeStreamEvent {
  const event = objectValue(value, "stream event");
  if (event.type === "log") return { type: "log", source: requiredString(event.source, "event.source"), text: wireText(event.text, "event.text"), at: requiredString(event.at, "event.at") };
  if (event.type === "unavailable") return { type: "unavailable", message: requiredString(event.message, "event.message"), code: optionalString(event.code, "event.code"), retryable: event.retryable === undefined ? undefined : requiredBoolean(event.retryable, "event.retryable") };
  if (event.type === "empty") return { type: "empty", message: optionalString(event.message, "event.message") };
  if (event.type === "progress") {
    if (typeof event.progress !== "number" || !Number.isFinite(event.progress) || event.progress < 0 || event.progress > 100) throw new Error("event.progress must be between 0 and 100");
    return { type: "progress", progress: event.progress, task: requiredString(event.task, "event.task") };
  }
  if (event.type === "result") return { type: "result", result: event.result };
  throw new Error(`Unsupported stream event type ${String(event.type)}`);
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be a JSON object`);
  return value as Record<string, unknown>;
}

function requiredStringArray(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => requiredString(item, `${field}[${index}]`));
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > 16_384) throw new Error(`${field} is too long`);
  return normalized;
}

function optionalString(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, field);
}

function wireText(value: unknown, field: string) {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  if (value.length > nodeProtocolControlMessageMaxBytes) throw new Error(`${field} is too long`);
  return value;
}

function requiredBoolean(value: unknown, field: string) {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function positiveNumber(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${field} must be a positive number`);
  return value;
}

function nonNegativeNumber(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative whole number`);
  return value;
}

function optionalNonNegativeNumber(value: unknown, field: string) {
  return value === undefined ? undefined : nonNegativeNumber(value, field);
}

function optionalPositiveNumber(value: unknown, field: string) {
  return value === undefined ? undefined : positiveNumber(value, field);
}

function optionalDuration(value: unknown) {
  if (value === undefined) return undefined;
  const duration = nonNegativeNumber(value, "deadlineMs");
  if (duration > 30 * 60 * 1000) throw new Error("deadlineMs exceeds the protocol limit");
  return duration;
}

function wireId(value: unknown) {
  const id = requiredString(value, "id");
  if (id.length > 80 || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("id is invalid");
  return id;
}

function requiredSha256(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) throw new Error("sha256 must be a 64-character hexadecimal hash");
  return value.toLowerCase();
}

function optionalSha256(value: unknown) {
  return value === undefined ? undefined : requiredSha256(value);
}
