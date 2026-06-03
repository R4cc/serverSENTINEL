export const nodeProtocolVersion = "1.1";

export const nodeCapabilities = [
  "node.health",
  "docker.info",
  "server.create",
  "server.delete",
  "server.start",
  "server.stop",
  "server.restart",
  "server.inspect",
  "server.stats",
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

export type NodeHello = {
  type: "hello";
  nodeId?: string;
  nodeSecret?: string;
  joinToken?: string;
  nodeName?: string;
  agentVersion?: string;
  protocolVersion?: string;
  capabilities?: string[];
  dockerStatus?: string;
  dataPathStatus?: string;
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
  };
};

export function protocolCompatible(version?: string) {
  return version === nodeProtocolVersion;
}
