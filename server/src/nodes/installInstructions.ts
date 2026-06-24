import type { NodeInstallInstructions } from "./apiTypes.js";
import { shellQuote } from "../docker/shell.js";
import { nodeProtocolVersion } from "./protocol.js";

export function nodeDataMount(hostPath?: string) {
  const value = hostPath?.trim() || "/var/lib/serversentinel";
  return value.includes(":") ? value : `${value}:/data`;
}

export function nodeDataMountParts(hostPath?: string) {
  const mount = nodeDataMount(hostPath);
  const separator = mount.indexOf(":");
  if (separator === -1) {
    return { mount, hostSource: mount, containerTarget: "/data" };
  }
  return {
    mount,
    hostSource: mount.slice(0, separator),
    containerTarget: mount.slice(separator + 1) || "/data"
  };
}

export function buildNodeInstallInstructions(input: {
  image: string;
  panelUrl?: string;
  defaultPanelPort: number;
  joinToken?: string;
  dataMount?: string;
  nodeName?: string;
}): NodeInstallInstructions {
  const panelUrl = input.panelUrl?.trim() || `http://<panel-host>:${input.defaultPanelPort}`;
  const { mount: dataMount, hostSource, containerTarget } = nodeDataMountParts(input.dataMount);
  const nodeName = input.nodeName?.trim();
  const dockerSocketMount = "/var/run/docker.sock:/var/run/docker.sock";
  const environment: NodeInstallInstructions["dockerCompose"]["environment"] = {
    SS_MODE: "node",
    SS_PANEL_URL: panelUrl,
    SERVERSENTINEL_DATA_DIR: containerTarget,
    SERVERSENTINEL_DOCKER_DATA_DIR: hostSource
  };
  if (nodeName) {
    environment.SS_NODE_NAME = nodeName;
  }
  if (input.joinToken) {
    environment.SS_JOIN_TOKEN = input.joinToken;
  }
  return {
    image: input.image,
    protocolVersion: nodeProtocolVersion,
    panelUrl,
    joinToken: input.joinToken,
    tokenRequired: !input.joinToken,
    dataMount,
    dockerSocketMount,
    dockerCompose: {
      image: input.image,
      restart: "unless-stopped",
      environment,
      volumes: [dockerSocketMount, dataMount]
    },
    dockerRun: `docker run -d --name serversentinel-node --restart unless-stopped --env SS_MODE=node --env SS_PANEL_URL=${shellQuote(panelUrl)} --env SERVERSENTINEL_DATA_DIR=${shellQuote(containerTarget)} --env SERVERSENTINEL_DOCKER_DATA_DIR=${shellQuote(hostSource)}${nodeName ? ` --env SS_NODE_NAME=${shellQuote(nodeName)}` : ""}${input.joinToken ? ` --env SS_JOIN_TOKEN=${shellQuote(input.joinToken)}` : ""} --volume ${shellQuote(dockerSocketMount)} --volume ${shellQuote(dataMount)} ${input.image}`
  };
}
