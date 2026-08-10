import type { ActivePage, ServerStatus } from "../types";
import type { ConsoleConnectionState } from "../utils/consolePipeline";
import type { ManagedContentTerminology } from "../features/mods/contentTerminology";
import type { ServerStripAlert, ServerStripHealth } from "../components/ActiveServerStrip";

export const stoppedServerMutationMessage = "Stop the server before changing mods, plugins, or server properties.";

/**
 * The alert and health line shown in the active server strip. An alert (node
 * unavailable) takes precedence — when one is showing, the health line is
 * suppressed so the strip never reports two conflicting states at once.
 */
export function resolveServerStripStatus(input: {
  activeNodeRuntimeBlocked: boolean;
  activeNodeStatus: string;
  activeNodeBlockReason: string;
  activeNodeBlockMessage: string;
  statusError: string;
  activePage: ActivePage;
  consoleConnectionState: ConsoleConnectionState;
  consoleError: string;
  consoleLoading: boolean;
  activeStatus: ServerStatus | null;
}): { alert: ServerStripAlert; health: ServerStripHealth } {
  const {
    activeNodeRuntimeBlocked, activeNodeStatus, activeNodeBlockReason, activeNodeBlockMessage,
    statusError, activePage, consoleConnectionState, consoleError, consoleLoading, activeStatus
  } = input;

  const blockDetail = activeNodeBlockReason && activeNodeBlockMessage.startsWith(`${activeNodeBlockReason}. `)
    ? activeNodeBlockMessage.slice(activeNodeBlockReason.length + 2)
    : activeNodeBlockMessage;

  const alert: ServerStripAlert = activeNodeRuntimeBlocked && activeNodeStatus !== "offline"
    ? {
        title: activeNodeBlockReason || "Node unavailable",
        message: blockDetail
      }
    : null;

  const health: ServerStripHealth = alert
    ? null
    : statusError
      ? { tone: "warning", message: "Status temporarily unavailable — retrying automatically." }
      : activePage === "console" && consoleConnectionState === "reconnecting"
        ? { tone: "warning", message: "Reconnecting console…" }
        : activePage === "console" && consoleConnectionState === "polling"
          ? { tone: "warning", message: "Live stream unavailable — polling console logs." }
        : activePage === "console" && consoleConnectionState === "error"
          ? { tone: "error", message: consoleError || "Console stream is unavailable." }
          : activePage === "console" && (consoleConnectionState === "connecting" || consoleLoading)
            ? { tone: "loading", message: "Connecting to live console…" }
            : !activeStatus
              ? { tone: "loading", message: "Loading server status…" }
              : null;

  return { alert, health };
}

/**
 * Why the runtime controls are unavailable, and whether the server is settled
 * enough for config that only applies to a stopped container to be edited.
 */
export function resolveRuntimeGuards(input: {
  authOperationalLock: boolean;
  canBasic: boolean;
  activeNodeRuntimeBlocked: boolean;
  nodeOfflineDetected: boolean;
  activeNodeBlockMessage: string;
  activeNodeName: string;
  activeServerUsesInternalNode: boolean;
  dockerSocketMounted: boolean;
  lifecycleTransitionRunning: boolean;
  isProvisioning: boolean;
  activeStatus: ServerStatus | null;
  runtimeAction: "start" | "stop" | "restart" | null;
  exportMutationLocked?: boolean;
  exportMutationBlockedReason?: string;
}) {
  const {
    authOperationalLock, canBasic, activeNodeRuntimeBlocked, nodeOfflineDetected, activeNodeBlockMessage,
    activeNodeName, activeServerUsesInternalNode, dockerSocketMounted, lifecycleTransitionRunning,
    isProvisioning, activeStatus, runtimeAction, exportMutationLocked = false, exportMutationBlockedReason = ""
  } = input;

  const runtimeControlsDisabledReason = authOperationalLock
    ? "Sign in before using runtime controls."
    : !canBasic
      ? "Servers control permission is required."
    : activeNodeRuntimeBlocked || nodeOfflineDetected
        ? activeNodeBlockMessage
          || `${activeNodeName} is offline. Runtime controls will return when it reconnects.`
        : activeServerUsesInternalNode && !dockerSocketMounted
          ? "Docker socket is not mounted. Runtime controls are unavailable for the internal node."
          : lifecycleTransitionRunning
            ? activeStatus?.lifecycle.message || "A server restart is already in progress."
          : isProvisioning
            ? "Server setup is still running."
            : exportMutationLocked
              ? exportMutationBlockedReason
            : "";

  const activeDockerState = activeStatus?.docker.state;
  const activeDockerUnknownStopped = activeDockerState === "unknown"
    && (
      activeStatus?.docker.configured === false
      || (activeStatus?.docker.available === true && /container (?:will be created|not found|does not exist)|configured container does not exist/i.test(activeStatus.docker.message || ""))
    );
  const serverRequiresStoppedForMutableConfig = Boolean(
    activeStatus && (
      activeStatus.docker.running
      || runtimeAction !== null
      || (activeDockerState && !["created", "dead", "exited"].includes(activeDockerState) && !activeDockerUnknownStopped)
    )
  );

  return { runtimeControlsDisabledReason, serverRequiresStoppedForMutableConfig };
}

/** Whether the properties form and its danger zone accept edits, and why not. */
export function resolveServerSettingsGuards(input: {
  isProvisioning: boolean;
  dockerOperationalLock: boolean;
  serverRequiresStoppedForMutableConfig: boolean;
  canEditServerSettings: boolean;
  canDeleteServers: boolean;
  serverSettingsSaving: boolean;
  runtimeControlsDisabledReason: string;
  activeStatus: ServerStatus | null;
  exportMutationLocked?: boolean;
  exportMutationBlockedReason?: string;
}) {
  const {
    isProvisioning, dockerOperationalLock, serverRequiresStoppedForMutableConfig, canEditServerSettings,
    canDeleteServers, serverSettingsSaving, runtimeControlsDisabledReason, activeStatus,
    exportMutationLocked = false, exportMutationBlockedReason = ""
  } = input;

  return {
    serverSettingsLocked: isProvisioning || dockerOperationalLock || exportMutationLocked || serverRequiresStoppedForMutableConfig || !canEditServerSettings,
    deleteServerLocked: isProvisioning || dockerOperationalLock || exportMutationLocked || !canDeleteServers || Boolean(activeStatus?.docker.running),
    serverSettingsLockedReason: isProvisioning
      ? "Server setup is still running."
      : dockerOperationalLock
        ? runtimeControlsDisabledReason || "Server settings are unavailable until the runtime reconnects."
        : exportMutationLocked
          ? exportMutationBlockedReason
        : serverRequiresStoppedForMutableConfig
          ? stoppedServerMutationMessage
          : !canEditServerSettings
            ? "Edit server settings permission is required."
            : serverSettingsSaving
              ? "Server settings are saving."
              : ""
  };
}

/** Which mod/plugin actions are available on the mods page, and why not. */
export function resolveModGuards(input: {
  isProvisioning: boolean;
  dockerOperationalLock: boolean;
  canManageMods: boolean;
  canInstallMods: boolean;
  activeStatus: ServerStatus | null;
  isAnyModJobRunning: boolean;
  modrinthApiConfigured: boolean;
  runtimeControlsDisabledReason: string;
  managedContent: ManagedContentTerminology;
  exportMutationLocked?: boolean;
  exportMutationBlockedReason?: string;
}) {
  const {
    isProvisioning, dockerOperationalLock, canManageMods, canInstallMods, activeStatus,
    isAnyModJobRunning, modrinthApiConfigured, runtimeControlsDisabledReason, managedContent,
    exportMutationLocked = false, exportMutationBlockedReason = ""
  } = input;

  const modsLocked = isProvisioning || dockerOperationalLock || exportMutationLocked || !canManageMods || !activeStatus || isAnyModJobRunning;

  return {
    modsLocked,
    modReviewAcknowledgementLocked: isProvisioning || dockerOperationalLock || exportMutationLocked || !canManageMods || !activeStatus || isAnyModJobRunning,
    modToggleLocked: modsLocked,
    addModFromModrinthDisabled: isProvisioning || dockerOperationalLock || exportMutationLocked || !activeStatus || isAnyModJobRunning || !canInstallMods || !modrinthApiConfigured,
    uploadModDisabled: modsLocked,
    addModFromModrinthDisabledReason: isProvisioning
      ? "Server setup is still running."
      : dockerOperationalLock
        ? runtimeControlsDisabledReason || "Server runtime is unavailable."
        : exportMutationLocked
          ? exportMutationBlockedReason
        : !activeStatus
          ? "Server status is still loading."
          : isAnyModJobRunning
            ? `A ${managedContent.singular} operation is already running.`
            : !canInstallMods
              ? "Server management permission is required."
              : !modrinthApiConfigured
                ? `Add a Modrinth API key in Settings before searching for ${managedContent.plural}.`
                : `Search Modrinth for compatible ${managedContent.runtimeName} ${managedContent.plural}.`,
    uploadModDisabledReason: isProvisioning
      ? "Server setup is still running."
      : dockerOperationalLock
        ? runtimeControlsDisabledReason || "Server runtime is unavailable."
        : exportMutationLocked
          ? exportMutationBlockedReason
        : !canManageMods
          ? "Server management permission is required."
          : !activeStatus
            ? "Server status is still loading."
            : isAnyModJobRunning
              ? `A ${managedContent.singular} operation is already running.`
              : `Upload a local ${managedContent.runtimeName} ${managedContent.singular} file.`
  };
}
