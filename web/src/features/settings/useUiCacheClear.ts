import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { RequestConfirmation } from "../../components/ConfirmationModal";

type ServerCacheStatus = "checking" | "ready" | "blocked" | "unavailable";

export type UiCacheLocalActivity = {
  runningTasks: boolean;
  unsavedFileChanges: boolean;
  fileMutation: boolean;
  runtimeMutation: boolean;
  serverSettingsMutation: boolean;
  consoleCommand: boolean;
  nodeMutation: boolean;
  scheduleMutation: boolean;
  userMutation: boolean;
  integrationMutation: boolean;
  transferMutation: boolean;
  modMutation: boolean;
};

export function uiCacheLocalBlockedReason(activity: UiCacheLocalActivity) {
  if (activity.unsavedFileChanges) return "Save or discard the open file edit before clearing the UI cache.";
  if (activity.runningTasks) return "Wait for every running task to finish before clearing the UI cache.";
  if (activity.fileMutation) return "Wait for the current file action to finish before clearing the UI cache.";
  if (activity.runtimeMutation) return "Wait for the current server runtime action to finish before clearing the UI cache.";
  if (activity.serverSettingsMutation) return "Wait for the server settings change to finish before clearing the UI cache.";
  if (activity.consoleCommand) return "Wait for the console command to finish sending before clearing the UI cache.";
  if (activity.nodeMutation) return "Wait for the current node action to finish before clearing the UI cache.";
  if (activity.scheduleMutation) return "Wait for the schedule change to finish before clearing the UI cache.";
  if (activity.userMutation) return "Wait for the user account change to finish before clearing the UI cache.";
  if (activity.integrationMutation) return "Wait for the integration change to finish before clearing the UI cache.";
  if (activity.transferMutation) return "Wait for the import or export action to finish before clearing the UI cache.";
  if (activity.modMutation) return "Wait for the managed-content action to finish before clearing the UI cache.";
  return "";
}

export function uiCacheDisabledReason(localBlockedReason: string, serverStatus: ServerCacheStatus, clearing: boolean) {
  if (clearing) return "The UI cache is being cleared.";
  if (localBlockedReason) return localBlockedReason;
  if (serverStatus === "checking") return "Checking for running tasks before enabling this action.";
  if (serverStatus === "blocked") return "Wait for every running task to finish before clearing the UI cache.";
  if (serverStatus === "unavailable") return "The panel could not verify whether a task is running. Refresh System information and try again.";
  return "";
}

async function deleteIndexedDatabase(name: string) {
  await new Promise<void>((resolve) => {
    const request = window.indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

/** Best-effort fallback for browsers that ignore some Clear-Site-Data directives. */
export async function clearBrowserUiData() {
  try { window.localStorage.clear(); } catch { /* Storage can be denied by browser policy. */ }
  try { window.sessionStorage.clear(); } catch { /* Storage can be denied by browser policy. */ }

  const cleanup: Promise<unknown>[] = [];
  if (typeof window.caches !== "undefined") {
    cleanup.push(window.caches.keys().then((keys) => Promise.all(keys.map((key) => window.caches.delete(key)))));
  }
  if ("serviceWorker" in navigator) {
    cleanup.push(navigator.serviceWorker.getRegistrations().then((registrations) => Promise.all(registrations.map((registration) => registration.unregister()))));
  }
  if (window.indexedDB && typeof window.indexedDB.databases === "function") {
    cleanup.push(window.indexedDB.databases().then((databases) => Promise.all(databases.flatMap((database) => database.name ? [deleteIndexedDatabase(database.name)] : []))));
  }
  await Promise.allSettled(cleanup);
}

export function useUiCacheClear(inputs: {
  enabled: boolean;
  localBlockedReason: string;
  requestConfirmation: RequestConfirmation;
  notify: (type: "success" | "error" | "info" | "warning", text: string) => void;
}) {
  const { enabled, localBlockedReason, requestConfirmation, notify } = inputs;
  const [serverStatus, setServerStatus] = useState<ServerCacheStatus>("checking");
  const [clearing, setClearing] = useState(false);
  const disabledReason = uiCacheDisabledReason(localBlockedReason, serverStatus, clearing);
  const disabledReasonRef = useRef(disabledReason);
  disabledReasonRef.current = disabledReason;

  useEffect(() => {
    if (!enabled) {
      setServerStatus("checking");
      return;
    }
    let cancelled = false;
    const refreshStatus = async () => {
      try {
        const result = await api<{ activeOperationCount: number }>("/api/auth/ui-cache-status");
        if (!cancelled) setServerStatus(result.activeOperationCount > 0 ? "blocked" : "ready");
      } catch {
        if (!cancelled) setServerStatus("unavailable");
      }
    };
    setServerStatus("checking");
    void refreshStatus();
    const interval = window.setInterval(() => void refreshStatus(), 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [enabled]);

  async function clearUiCache() {
    if (disabledReasonRef.current) {
      notify("warning", disabledReasonRef.current);
      return;
    }
    const confirmed = await requestConfirmation({
      title: "Clear UI cache?",
      description: "This removes cached panel files and browser data stored by serverSENTINEL on this device.",
      details: "You will be signed out. Theme, regional formatting, console history, and other browser preferences will be reset.",
      warning: "Every open panel tab for this address will reload. Save file edits and wait for running tasks before continuing.",
      confirmLabel: "Clear UI cache",
      cancelLabel: "Keep cache",
      variant: "critical"
    });
    if (!confirmed) return;
    if (disabledReasonRef.current) {
      notify("warning", disabledReasonRef.current);
      return;
    }

    setClearing(true);
    try {
      await api<{ ok: true }>("/api/auth/clear-ui-cache", { method: "POST" });
      await clearBrowserUiData();
      const reloadUrl = new URL("/", window.location.origin);
      reloadUrl.searchParams.set("ui-cache-cleared", Date.now().toString(36));
      window.location.replace(reloadUrl);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "The UI cache could not be cleared.");
      setServerStatus("unavailable");
      setClearing(false);
    }
  }

  return { clearing, disabledReason, clearUiCache };
}
