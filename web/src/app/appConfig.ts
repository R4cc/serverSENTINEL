import type { ActivePage, AppState, PlaceholderNode } from "../types";

export const appVersion = "26.9.2";
export const defaultNodeDataPath = "/var/lib/serversentinel";
const serverWorkspacePages: ActivePage[] = ["overview", "console", "files", "mods", "schedule", "players", "properties"];
export const demoLocalStorageKey = "serversentinel-demo-mode";
const signedInLocalStorageKey = "serversentinel-signed-in";

export const emptyApp: AppState = {
  servers: [],
  nodes: [],
  appVersion,
  runtimeMode: "all-in-one",
  timeZone: "UTC",
  modrinthApiConfigured: false,
  geoIpConfigured: false,
  playerHeads: {
    enabled: false,
    onboardingRequired: false,
    provider: "mc-heads.net",
    cacheEntries: 0,
    cacheBytes: 0
  },
  onboarding: {
    currentVersion: 1,
    completedVersion: 1
  },
  dockerSocketMounted: false,
  totalMemory: 0
};

export const defaultContextNode: PlaceholderNode = {
  id: "local",
  name: "Internal Node",
  type: "local",
  status: "online",
  isInternal: true
};

export const emptyPanelContextNode: PlaceholderNode = {
  id: "",
  name: "No node selected",
  type: "remote",
  status: "unknown",
  isInternal: false
};

export function isServerWorkspacePage(page: ActivePage) {
  return serverWorkspacePages.includes(page);
}
export function shouldLoadPlayerSnapshots(page: ActivePage) {
  return page === "nodes" || isServerWorkspacePage(page);
}
export function shouldShowApplicationLoadingSkeleton(page: ActivePage) {
  return page !== "settings";
}

export function shouldShowInitialOverviewLoading(loading: boolean, eventCount: number, activityFieldCount: number) {
  return loading && eventCount === 0 && activityFieldCount === 0;
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

/**
 * Whether the session that resolved last time was signed in. Confirming the session
 * costs a network round trip, so the first paint has to guess which surface to show.
 * Guessing the sign-in form for a signed-in visitor means the entire shell replaces a
 * centred panel a moment later, which is the layout shift that dominates CLS on reload.
 */
export function readStoredSignedIn(storage: Storage = window.localStorage) {
  try {
    return storage.getItem(signedInLocalStorageKey) === "true";
  } catch {
    return false;
  }
}

export function writeStoredSignedIn(value: boolean, storage: Storage = window.localStorage) {
  try {
    if (value) storage.setItem(signedInLocalStorageKey, "true");
    else storage.removeItem(signedInLocalStorageKey);
  } catch {
    // Ignore unavailable browser storage; the next boot falls back to the sign-in skeleton.
  }
}

/**
 * The workspace header title for a page. Mods/plugins follow the active
 * server's runtime terminology, so the title is derived rather than fixed.
 */
export function pageTitle(page: ActivePage, contentPluralTitle: string, applicationReady: boolean) {
  const titles: Record<ActivePage, string> = {
    create: "Create new managed server",
    overview: "Overview",
    console: "Console",
    files: "Files",
    mods: contentPluralTitle,
    schedule: "Schedules",
    players: "Players",
    properties: "Properties",
    settings: "Settings",
    nodes: "Nodes"
  };
  return titles[page] ?? (!applicationReady ? "Loading" : "Welcome");
}
