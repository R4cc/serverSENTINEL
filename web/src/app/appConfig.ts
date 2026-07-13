import type { ActivePage, AppState, ManagedNode } from "../types";

export const appVersion = "1.2.0";
export const defaultNodeDataPath = "/var/lib/serversentinel";
const serverWorkspacePages: ActivePage[] = ["overview", "console", "files", "mods", "schedule", "properties"];
export const demoLocalStorageKey = "serversentinel-demo-mode";

export const emptyApp: AppState = {
  servers: [],
  nodes: [],
  appVersion,
  runtimeMode: "all-in-one",
  timeZone: "UTC",
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
export function shouldShowApplicationLoadingSkeleton(page: ActivePage) {
  return page !== "settings";
}

export function readStoredDemoMode(storage: Storage = window.localStorage, enabled = true) {
  if (!enabled) {
    try {
      storage.removeItem(demoLocalStorageKey);
    } catch {
      // Ignore unavailable browser storage; demo mode should remain off.
    }
    return false;
  }
  try {
    return storage.getItem(demoLocalStorageKey) === "true";
  } catch {
    return false;
  }
}

export function writeStoredDemoMode(value: boolean, storage: Storage = window.localStorage, enabled = true) {
  try {
    if (!enabled) {
      storage.removeItem(demoLocalStorageKey);
      return;
    }
    storage.setItem(demoLocalStorageKey, String(value));
  } catch {
    // Ignore unavailable browser storage; in-memory state still reflects the toggle.
  }
}
