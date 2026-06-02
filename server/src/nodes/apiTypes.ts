import type { PublicNode, PublicServer } from "../types.js";

export type NodeActionErrorCode =
  | "node_not_found"
  | "node_offline"
  | "node_incompatible"
  | "missing_capability"
  | "command_timeout"
  | "command_failed"
  | "node_runtime_unavailable"
  | "validation";

export type ApiErrorResponse = {
  error: string;
  code?: NodeActionErrorCode | string;
};

export type NodesResponse = {
  nodes: PublicNode[];
};

export type NodeResponse = PublicNode;

export type ContextNode = PublicNode & {
  servers: PublicServer[];
};

export type ContextResponse = {
  nodes: ContextNode[];
};

export type NodeInstallInstructions = {
  image: string;
  panelUrl: string;
  joinToken?: string;
  tokenRequired: boolean;
  dataMount: string;
  dockerSocketMount: string;
  dockerCompose: {
    image: string;
    environment: {
      SS_MODE: "node";
      SS_PANEL_URL: string;
      SS_NODE_NAME?: string;
      SS_JOIN_TOKEN?: string;
    };
    volumes: string[];
  };
  dockerRun: string;
};

export type CreateNodeResponse = {
  node: PublicNode;
  joinToken: string;
  expiresAt: string;
  install: NodeInstallInstructions;
};
