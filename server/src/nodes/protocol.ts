export const nodeProtocolVersion = "1.0";

export const nodeCapabilities = [
  "node.health",
  "docker.info",
  "server.start",
  "server.stop",
  "server.restart",
  "server.inspect",
  "server.stats",
  "server.logs.recent",
  "server.console.send"
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
