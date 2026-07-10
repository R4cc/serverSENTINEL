import type { PublicNode } from "../types.js";

export type NodeInstallInstructions = {
  image: string;
  protocolVersion: string;
  panelUrl: string;
  joinToken?: string;
  tokenRequired: boolean;
  dataMount: string;
  dockerSocketMount: string;
  dockerCompose: {
    image: string;
    restart: "unless-stopped";
    environment: {
      SS_MODE: "node";
      SS_PANEL_URL: string;
      SERVERSENTINEL_DATA_DIR: string;
      SERVERSENTINEL_DOCKER_DATA_DIR: string;
      TZ: string;
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
