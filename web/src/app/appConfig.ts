import type { ActivePage, AppState, ManagedNode } from "../types";

export const appVersion = "0.6.0";
export const defaultNodeDataPath = "/var/lib/serversentinel";
export const serverWorkspacePages: ActivePage[] = ["overview", "console", "files", "mods", "schedule", "properties"];

export const emptyApp: AppState = {
  servers: [],
  nodes: [],
  runtimeMode: "all-in-one",
  modrinthApiConfigured: false,
  dockerSocketMounted: false,
  totalMemory: 0
};

export const defaultContextNode: ManagedNode = {
  id: "local",
  name: "Internal Node",
  type: "local",
  status: "online",
  isInternal: true
};

export const emptyPanelContextNode: ManagedNode = {
  id: "",
  name: "No node selected",
  type: "remote",
  status: "unknown",
  isInternal: false
};

export function isServerWorkspacePage(page: ActivePage) {
  return serverWorkspacePages.includes(page);
}
