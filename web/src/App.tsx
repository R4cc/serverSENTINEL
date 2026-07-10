import { FormEvent, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { ApiError, api } from "./api";
import { demoOverviewData, demoServer, demoServerId, demoStats, demoStatus } from "./demo";
import type { ActivePage, AppState, AuthSession, ContextNode, CreateNodeResponse, FabricVersions, LocalePreference, ManagedNode, ManagedServer, NodeInstallResponse, NodeUpdateResponse, OperationRecord, PermissionKey, PublicUser, ResourceSample, ResourceStatsHistory, ScheduledExecution, ServerActivity, ServerOverviewData, ServerStatus, ThemePreference, GeneralJob } from "./types";
import { clientId } from "./utils/files";
import { formatTimestampForFilename, minecraftVersionInfo, resourceHistorySampleLimit, resourcePollMs, runtimeTone, versionValue } from "./utils/format";
import { hasPermission, normalizePermissions } from "./utils/permissions";
import { trimFormValue, validateCommandList, validateCronExpression, validatePassword, validateUsername } from "./utils/validation";
import { isNodeRuntimeUsable } from "./utils/nodes";
import { appVersion, defaultNodeDataPath, demoModeEnabled, emptyApp, isServerWorkspacePage, writeStoredDemoMode } from "./app/appConfig";
import { usePreferencesState } from "./app/appState";
import { useServerContext } from "./app/serverContext";
import { errorMessage, hasPotentialEvent, readCommandHistory, serverConfigValidation, setValidationNotice } from "./utils/appHelpers";
import { appendCommandHistory } from "./utils/minecraftTerminal";
import { AuthPanel, UserManagement } from "./components/AuthPanel";
import { AppIcon, SidebarIcon, SidebarToggleIcon } from "./components/FileTypeIcon";
import { InlineState } from "./components/InlineState";
import { ResourcePanel } from "./components/ResourcePanel";
import { RuntimeControls } from "./components/RuntimeControls";
import { ModrinthKeyForm } from "./components/SettingsPanels";
import { Button, EmptyState, PanelHeader, StatusBadge } from "./components/UiPrimitives";
import { ActivityHealthPanel, OverviewSummary, RecentEventsPanel } from "./pages/OverviewPage";
import { SchedulePage } from "./pages/SchedulesPage";
import { NodesPage } from "./pages/NodesPage";
import { DeleteServerPanel, ManagedServerForm, ServerEditForm } from "./pages/ServerSettingsPage";
import { ModsPage } from "./pages/ModsPage";
import { useModsWorkspace } from "./features/mods/useModsWorkspace";
import { FilesPage } from "./features/files/FilesPage";
import { useFilesWorkspace } from "./features/files/useFilesWorkspace";

const MinecraftTerminal = lazy(() => import("./components/MinecraftTerminal").then((module) => ({ default: module.MinecraftTerminal })));

function consoleLine(text: string) {
  return `${text}\n`;
}

function mergeConsoleLogTail(current: string[], next: string[]) {
  if (!next.length) return current.length ? current : next;
  if (!current.length) return next;

  for (let start = Math.max(0, current.length - next.length); start < current.length; start += 1) {
    if (next.every((line, index) => current[start + index] === line)) {
      return current;
    }
  }

  const maxOverlap = Math.min(current.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const currentTail = current.slice(current.length - overlap);
    const nextHead = next.slice(0, overlap);
    if (currentTail.every((line, index) => line === nextHead[index])) {
      return [...current, ...next.slice(overlap)].slice(-500);
    }
  }

  return current;
}

const provisionJobPollMs = 1_500;
const serverStatusPollMs = 10_000;
const stoppedServerMutationMessage = "Stop the server before changing mods or server properties.";
const nodeUpdateGraceMs = 5 * 60 * 1000;
const activePageStorageKey = "serversentinel-active-page";
const activePages = new Set<ActivePage>(["servers", "settings", "nodes", "create", "overview", "console", "files", "mods", "schedule", "properties"]);
const playerMetricsStorageKey = "serversentinel-player-metrics";
const playerMetricsMaxAgeMs = 15 * 60 * 1000;

type StoredPlayerMetrics = {
  playersOnline: number;
  maxPlayers?: number | null;
  savedAt: number;
};

function isReconnectableConsoleUnavailable(message?: string) {
  return /node .*offline|node disconnected|disconnected before command/i.test(message ?? "");
}

function mergeTransientPlayerMetrics(incoming: ServerActivity, previous: ServerActivity | undefined, preservePrevious: boolean): ServerActivity {
  if (!preservePrevious || incoming.playersOnline !== null && incoming.playersOnline !== undefined) return incoming;
  if (previous?.playersOnline === null || previous?.playersOnline === undefined) return incoming;
  return {
    ...incoming,
    playersOnline: previous.playersOnline,
    maxPlayers: incoming.maxPlayers ?? previous.maxPlayers
  };
}

function readStoredPlayerMetrics() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(playerMetricsStorageKey) || "{}") as Record<string, StoredPlayerMetrics>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredPlayerMetrics(serverId: string, activity: ServerActivity) {
  if (activity.playersOnline === null || activity.playersOnline === undefined) return;
  try {
    const current = readStoredPlayerMetrics();
    current[serverId] = {
      playersOnline: activity.playersOnline,
      maxPlayers: activity.maxPlayers,
      savedAt: Date.now()
    };
    window.localStorage.setItem(playerMetricsStorageKey, JSON.stringify(current));
  } catch {
    // Ignore unavailable browser storage; overview will fall back to live data.
  }
}

function clearStoredPlayerMetrics(serverId: string) {
  try {
    const current = readStoredPlayerMetrics();
    if (!(serverId in current)) return;
    delete current[serverId];
    window.localStorage.setItem(playerMetricsStorageKey, JSON.stringify(current));
  } catch {
    // Ignore unavailable browser storage.
  }
}

function storedPlayerMetricsActivity(serverId: string): ServerActivity | null {
  const stored = readStoredPlayerMetrics()[serverId];
  if (!stored || Date.now() - stored.savedAt > playerMetricsMaxAgeMs) return null;
  return {
    playersOnline: stored.playersOnline,
    maxPlayers: stored.maxPlayers
  };
}

function readStoredActivePage() {
  try {
    const stored = window.localStorage.getItem(activePageStorageKey);
    return activePages.has(stored as ActivePage) ? stored as ActivePage : "overview";
  } catch {
    return "overview";
  }
}

function ToastSeverityIcon({ type }: { type: "success" | "info" | "warning" | "error" }) {
  if (type === "warning") {
    return (
      <svg aria-hidden="true" className="toastSeverityIcon" viewBox="0 0 24 24" fill="none">
        <path d="M12 3.25 22 20.5H2L12 3.25Z" fill="currentColor" />
        <path d="M12 8.5v5.25" stroke="var(--surface-raised)" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M12 17.25h.01" stroke="var(--surface-raised)" strokeWidth="2.8" strokeLinecap="round" />
      </svg>
    );
  }

  const isError = type === "error";
  const isInfo = type === "info";

  return (
    <svg aria-hidden="true" className="toastSeverityIcon" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      {type === "success" ? (
        <path d="m7.75 12.2 2.65 2.65 5.85-6" stroke="var(--surface-raised)" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
      ) : null}
      {isInfo ? (
        <>
          <path d="M12 10.5v6" stroke="var(--surface-raised)" strokeWidth="2.3" strokeLinecap="round" />
          <path d="M12 7.2h.01" stroke="var(--surface-raised)" strokeWidth="2.8" strokeLinecap="round" />
        </>
      ) : null}
      {isError ? (
        <>
          <path d="m8.75 8.75 6.5 6.5" stroke="var(--surface-raised)" strokeWidth="2.3" strokeLinecap="round" />
          <path d="m15.25 8.75-6.5 6.5" stroke="var(--surface-raised)" strokeWidth="2.3" strokeLinecap="round" />
        </>
      ) : null}
    </svg>
  );
}

function AppToaster({ darkMode }: { darkMode: boolean }) {
  return (
    <Toaster
      closeButton
      expand
      gap={8}
      icons={{
        success: <ToastSeverityIcon type="success" />,
        info: <ToastSeverityIcon type="info" />,
        warning: <ToastSeverityIcon type="warning" />,
        error: <ToastSeverityIcon type="error" />
      }}
      position="top-center"
      theme={darkMode ? "dark" : "light"}
      toastOptions={{
        className: "sonnerToast",
        descriptionClassName: "sonnerToastDescription"
      }}
      visibleToasts={5}
    />
  );
}

export default function App() {
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [authNotice, setAuthNotice] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [userModal, setUserModal] = useState<"create" | PublicUser | null>(null);
  const [appState, setAppState] = useState<AppState>(emptyApp);
  const [activeServerId, setActiveServerId] = useState("");
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [appStateLoaded, setAppStateLoaded] = useState(false);
  const [appLoadError, setAppLoadError] = useState("");
  const [appRefreshing, setAppRefreshing] = useState(false);
  const [resourceSamples, setResourceSamples] = useState<ResourceSample[]>([]);
  const [overviewData, setOverviewData] = useState<ServerOverviewData>({ events: [], activity: {} });
  const [serverActivities, setServerActivities] = useState<Record<string, ServerActivity>>({});
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [consoleLoading, setConsoleLoading] = useState(false);
  const [consoleError, setConsoleError] = useState("");
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState("");
  const [userSaving, setUserSaving] = useState(false);
  const [commandSending, setCommandSending] = useState(false);
  const [commandHistory, setCommandHistory] = useState<string[]>(() => readCommandHistory());
  const [fabricVersions, setFabricVersions] = useState<FabricVersions>({ game: [], loader: [], installer: [] });
  const [notice, setNotice] = useState("");
  const [activeJobs, setActiveJobs] = useState<GeneralJob[]>([]);
  const [provisioningError, setProvisioningError] = useState("");
  const [provisioningErrorDetails, setProvisioningErrorDetails] = useState("");
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [serverSettingsSaving, setServerSettingsSaving] = useState(false);
  const [consoleStreamVersion, setConsoleStreamVersion] = useState(0);
  const [runtimeAction, setRuntimeAction] = useState<"start" | "stop" | "restart" | null>(null);
  const [activePage, setActivePage] = useState<ActivePage>(() => readStoredActivePage());
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [nodeBusyId, setNodeBusyId] = useState("");
  const [nodeDetails, setNodeDetails] = useState<ManagedNode | null>(null);
  const [nodeUpdatingSince, setNodeUpdatingSince] = useState<Record<string, number>>({});
  const [nodeUpdateNow, setNodeUpdateNow] = useState(() => Date.now());
  const [nodeInstallResult, setNodeInstallResult] = useState<NodeInstallResponse | CreateNodeResponse | null>(null);
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [addNodeResult, setAddNodeResult] = useState<CreateNodeResponse | null>(null);
  const [nodeInstallMethod, setNodeInstallMethod] = useState<"compose" | "run">("run");
  const [preferredCreateNodeId, setPreferredCreateNodeId] = useState("");
  const {
    themePreference,
    setThemePreference,
    demoMode,
    setDemoMode,
    dateLocalePreference,
    setDateLocalePreference,
    numberLocalePreference,
    setNumberLocalePreference,
    demoRunning,
    setDemoRunning,
    demoFiles,
    setDemoFiles,
    demoInstalledMods,
    setDemoInstalledMods,
    demoSchedules,
    setDemoSchedules,
    systemDark
  } = usePreferencesState();
  const consoleLogServerIdRef = useRef("");
  const fileWorkspaceServerIdRef = useRef("");
  const refreshModsAfterFileMutationRef = useRef<() => Promise<unknown> | unknown>(() => undefined);
  const activeServerIdRef = useRef("");
  const panelFirstRunPromptedRef = useRef(false);
  const provisionSubmitLockRef = useRef(false);
  const appRefreshInFlightRef = useRef(false);
  const statusRefreshInFlightRef = useRef<Set<string>>(new Set());
  const consoleReconnectTimeoutRef = useRef<number | null>(null);
  const consoleCommandRefreshTimeoutRef = useRef<number | null>(null);

  const overviewRefreshTimeoutRef = useRef<number | null>(null);
  const activeJobToastIdsRef = useRef<Set<string>>(new Set());
  const staleSessionLogoutRef = useRef(false);
  const authSubmittingRef = useRef(false);
  const staleSessionSuppressUntilRef = useRef(0);

  const refreshOverviewData = useCallback(async (serverId: string, options: { showLoading?: boolean } = {}) => {
    if (demoMode && serverId === demoServerId) {
      setOverviewData(demoOverviewData(demoRunning));
      setOverviewError("");
      setOverviewLoading(false);
      return;
    }
    if (options.showLoading) setOverviewLoading(true);
    setOverviewError("");
    try {
      const data = await api<ServerOverviewData>(`/api/servers/${serverId}/events`);
      const preservePlayerMetrics = Boolean(status?.server.id === serverId && status.docker.running);
      const cachedPlayerMetrics = storedPlayerMetricsActivity(serverId);
      setServerActivities((current) => {
        const previousActivity = current[serverId] ?? cachedPlayerMetrics ?? undefined;
        const activity = mergeTransientPlayerMetrics(data.activity, previousActivity, preservePlayerMetrics);
        if (activity.playersOnline !== null && activity.playersOnline !== undefined) writeStoredPlayerMetrics(serverId, activity);
        else if (!preservePlayerMetrics) clearStoredPlayerMetrics(serverId);
        return { ...current, [serverId]: activity };
      });
      if (activeServerIdRef.current === serverId) {
        setOverviewData((current) => ({
          ...data,
          activity: mergeTransientPlayerMetrics(
            data.activity,
            current.activity.playersOnline !== null && current.activity.playersOnline !== undefined ? current.activity : cachedPlayerMetrics ?? undefined,
            preservePlayerMetrics
          )
        }));
        setOverviewError("");
      }
    } catch (error) {
      if (handleStaleSession(error)) return;
      if (activeServerIdRef.current === serverId) {
        setOverviewError(errorMessage(error, "Could not load overview activity. Previously loaded data is preserved."));
      }
    } finally {
      if (activeServerIdRef.current === serverId) setOverviewLoading(false);
    }
  }, [demoMode, demoRunning, status]);

  const triggerOverviewRefresh = useCallback((serverId: string) => {
    if (overviewRefreshTimeoutRef.current !== null) {
      window.clearTimeout(overviewRefreshTimeoutRef.current);
    }
    overviewRefreshTimeoutRef.current = window.setTimeout(async () => {
      overviewRefreshTimeoutRef.current = null;
      await refreshOverviewData(serverId);
    }, 500);
  }, [refreshOverviewData]);

  const triggerOverviewRefreshRef = useRef(triggerOverviewRefresh);
  useEffect(() => {
    triggerOverviewRefreshRef.current = triggerOverviewRefresh;
  }, [triggerOverviewRefresh]);

  const darkMode = themePreference === "dark" || (themePreference === "system" && systemDark);
  const isProvisioning = activeJobs.some((job) => job.type === "provision" && (job.status === "queued" || job.status === "running"));
  const currentProvisionOperation = activeJobs.find((job) => job.type === "provision");
  const isAnyModJobRunning = activeJobs.some((job) => (job.type === "mod-install" || job.type === "mod-upload") && job.status === "running");
  const panelVersion = appState.appVersion ?? appVersion;
  const panelBuildId = appState.buildId;
  const {
    effectiveAppState,
    panelOnlyMode,
    contextNodes,
    activeServer,
    activeServerIsDemo,
    activeNode,
    usableContextNodes,
    activeMinecraftVersion,
    activeModContext,
    activeModVersionsUnknown,
    activeStatus,
    activeNodeRuntimeBlocked,
    activeNodeBlockReason,
    activeNodeBlockMessage,
    activeServerUsesInternalNode,
    activeServerDockerSocketMounted
  } = useServerContext({ appState, activeServerId, status, demoMode, demoSchedules });
  const applicationReady = appStateLoaded || demoMode;
  const permissionUser = appState.currentUser ?? authSession?.user ?? null;
  const canBasic = activeServerIsDemo || hasPermission(permissionUser, "servers.control");
  const canExpanded = activeServerIsDemo || hasPermission(permissionUser, "console.command");
  const canEditServerSettings = activeServerIsDemo || hasPermission(permissionUser, "servers.editSettings");
  const canDeleteServers = activeServerIsDemo || hasPermission(permissionUser, "servers.delete");
  const canInstallMods = activeServerIsDemo || hasPermission(permissionUser, "mods.install");
  const canManageMods = activeServerIsDemo || hasPermission(permissionUser, "mods.install") || hasPermission(permissionUser, "mods.upload") || hasPermission(permissionUser, "mods.enableDisable") || hasPermission(permissionUser, "mods.remove") || hasPermission(permissionUser, "mods.update");
  const canManageSchedules = activeServerIsDemo || hasPermission(permissionUser, "schedules.manage");
  const canCreateServers = !demoMode && hasPermission(permissionUser, "servers.create");
  const canManageIntegrations = !demoMode && hasPermission(permissionUser, "integrations.manage");
  const canViewUsers = hasPermission(permissionUser, "users.view");
  const canManageUsers = hasPermission(permissionUser, "users.manage");
  const canAdmin = canViewUsers;
  const authOperationalLock = !demoMode && !authSession?.authenticated;
  const dockerOperationalLock = authOperationalLock || activeNodeRuntimeBlocked || (activeServerUsesInternalNode && !effectiveAppState.dockerSocketMounted);
  const serverCommandTone = runtimeTone(activeStatus, activeServerDockerSocketMounted);
  const serverCommandStatusLabel = serverCommandTone === "running"
    ? "Running"
    : serverCommandTone === "starting"
      ? "Starting"
      : serverCommandTone === "stopped" || serverCommandTone === "exited"
        ? "Offline"
        : "Unavailable";
  const runtimeControlsDisabledReason = authOperationalLock
    ? "Sign in before using runtime controls."
    : !canBasic
      ? "Servers control permission is required."
      : activeNodeRuntimeBlocked
        ? activeNodeBlockMessage
        : activeServerUsesInternalNode && !effectiveAppState.dockerSocketMounted
          ? "Docker socket is not mounted. Runtime controls are unavailable for the internal node."
          : isProvisioning
            ? "Server setup is still running."
            : "";
  const serverCreationBlocked = authOperationalLock || usableContextNodes.length === 0;
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
  const serverSettingsLocked = isProvisioning || dockerOperationalLock || serverRequiresStoppedForMutableConfig || !canEditServerSettings;
  const deleteServerLocked = isProvisioning || dockerOperationalLock || !canDeleteServers || Boolean(activeStatus?.docker.running);
  const serverSettingsLockedReason = isProvisioning
    ? "Server setup is still running."
    : dockerOperationalLock
      ? runtimeControlsDisabledReason || "Server settings are unavailable until the runtime reconnects."
      : serverRequiresStoppedForMutableConfig
        ? stoppedServerMutationMessage
        : !canEditServerSettings
          ? "Edit server settings permission is required."
          : serverSettingsSaving
            ? "Server settings are saving."
            : "";
  const modsLocked = isProvisioning || dockerOperationalLock || serverRequiresStoppedForMutableConfig || !canManageMods || !activeStatus || isAnyModJobRunning;
  const modReviewAcknowledgementLocked = isProvisioning || dockerOperationalLock || !canManageMods || !activeStatus || isAnyModJobRunning;
  const modToggleLocked = modsLocked;
  const addModFromModrinthDisabled = isProvisioning || serverRequiresStoppedForMutableConfig || !canInstallMods || !effectiveAppState.modrinthApiConfigured;
  const uploadModDisabled = modsLocked;
  const addModFromModrinthDisabledReason = isProvisioning
      ? "Server setup is still running."
      : serverRequiresStoppedForMutableConfig
        ? stoppedServerMutationMessage
        : !canInstallMods
          ? "Server management permission is required."
          : !effectiveAppState.modrinthApiConfigured
            ? "Add a Modrinth API key in Settings before searching for mods."
            : "Search Modrinth for compatible Fabric mods.";
  const uploadModDisabledReason = isProvisioning
      ? "Server setup is still running."
      : dockerOperationalLock
        ? runtimeControlsDisabledReason || "Server runtime is unavailable."
        : serverRequiresStoppedForMutableConfig
          ? stoppedServerMutationMessage
          : !canManageMods
            ? "Server management permission is required."
            : !activeStatus
              ? "Server status is still loading."
              : isAnyModJobRunning
                ? "A mod operation is already running."
                : "Upload a local Fabric mod file.";
  const resolvedDateLocale = dateLocalePreference === "user" ? undefined : dateLocalePreference;
  const resolvedNumberLocale = numberLocalePreference === "user" ? undefined : numberLocalePreference;
  const runtimeTimeZone = effectiveAppState.timeZone || "UTC";
  const dateTimeFormatter = useMemo(() => new Intl.DateTimeFormat(resolvedDateLocale, { dateStyle: "medium", timeStyle: "short", timeZone: runtimeTimeZone }), [resolvedDateLocale, runtimeTimeZone]);
  const timeFormatter = useMemo(() => new Intl.DateTimeFormat(resolvedDateLocale, { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: runtimeTimeZone }), [resolvedDateLocale, runtimeTimeZone]);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(resolvedNumberLocale), [resolvedNumberLocale]);

  function formatDisplayDate(value: string | number | Date) {
    return dateTimeFormatter.format(new Date(value));
  }

  function formatDisplayTime(value: string | number | Date) {
    return timeFormatter.format(new Date(value));
  }

  const filesWorkspace = useFilesWorkspace({
    activeServer,
    activeServerIsDemo,
    activeServerIdRef,
    demoMode,
    demoFiles,
    setDemoFiles,
    demoInstalledMods,
    setDemoInstalledMods,
    isProvisioning,
    dockerOperationalLock,
    runtimeControlsDisabledReason,
    serverRequiresStoppedForMutableConfig,
    stoppedServerMutationMessage,
    permissionUser,
    formatDisplayDate,
    notify,
    setNotice,
    handleStaleSession,
    setActiveJobs,
    refreshModsAfterFilesChange: () => refreshModsAfterFileMutationRef.current()
  });
  const modsWorkspace = useModsWorkspace({
    activeServer,
    activePage,
    activeServerIsDemo,
    activeServerUsesInternalNode,
    activeNodeRuntimeBlocked,
    activeNodeBlockMessage,
    demoMode,
    demoInstalledMods,
    setDemoInstalledMods,
    modrinthConfigured: effectiveAppState.modrinthApiConfigured,
    isProvisioning,
    canManage: canManageMods,
    modsLocked,
    toggleLocked: modToggleLocked,
    notify,
    setNotice,
    setActiveJobs,
    handleStaleSession,
    refreshFiles: filesWorkspace.actions.loadFiles
  });
  useEffect(() => {
    if (!activeServer || demoMode || !authSession?.authenticated) return;
    void api<{ operations: OperationRecord[] }>(`/api/operations?serverId=${encodeURIComponent(activeServer.id)}&limit=25`)
      .then(({ operations }) => operations.filter((operation) => operation.type === "file.extract" && (operation.status === "queued" || operation.status === "running")).forEach(filesWorkspace.actions.resumeZipOperation))
      .catch(() => undefined);
  }, [activeServer?.id, authSession?.authenticated, demoMode]);
  useEffect(() => {
    refreshModsAfterFileMutationRef.current = () => modsWorkspace.actions.refresh(false);
  }, [modsWorkspace.actions]);
  const scheduleDisabledReason = scheduleBusy
    ? "Schedule changes are still saving."
    : isProvisioning
      ? "Server setup is still running."
      : !canManageSchedules
        ? "Manage schedules permission is required."
        : dockerOperationalLock
          ? runtimeControlsDisabledReason || "Server runtime is unavailable."
          : "";
  const consoleCommandDisabledReason = isProvisioning
      ? "Server setup is still running."
      : dockerOperationalLock
        ? runtimeControlsDisabledReason || "Server runtime is unavailable."
        : !canExpanded
          ? "Console command permission is required."
          : !activeStatus?.commandInputAvailable
            ? activeStatus?.commandInputMessage || "Console command input is unavailable."
            : "";
  const canSendConsoleCommands = !isProvisioning
    && !dockerOperationalLock
    && canExpanded
    && Boolean(activeStatus?.commandInputAvailable);

  function formatDisplayNumber(value: number) {
    return numberFormatter.format(value);
  }

  useEffect(() => {
    void refreshAuth();
  }, []);

  useEffect(() => {
    return () => {
      if (consoleReconnectTimeoutRef.current !== null) {
        window.clearTimeout(consoleReconnectTimeoutRef.current);
      }
      if (consoleCommandRefreshTimeoutRef.current !== null) {
        window.clearTimeout(consoleCommandRefreshTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    activeServerIdRef.current = activeServer?.id ?? "";
  }, [activeServer?.id]);

  useEffect(() => {
    if (!appStateLoaded || demoMode || !panelOnlyMode || panelFirstRunPromptedRef.current) return;
    if (effectiveAppState.servers.length > 0 || usableContextNodes.length > 0) return;
    panelFirstRunPromptedRef.current = true;
    setActivePage("nodes");
    setAddNodeResult(null);
    setNodeInstallMethod("run");
  }, [appStateLoaded, demoMode, effectiveAppState.servers.length, panelOnlyMode, usableContextNodes.length]);

  function openCreateServerForNode(nodeId = "") {
    setPreferredCreateNodeId(nodeId);
    setActivePage("create");
  }

  function openServerFromNode(serverId: string) {
    const server = effectiveAppState.servers.find((candidate) => candidate.id === serverId);
    if (!server) return;
    if (demoMode && server.id !== demoServerId) {
      notify("info", "Demo mode is enabled. Exit demo mode to access this server.");
      return;
    }
    setActiveServerId(server.id);
    activeServerIdRef.current = server.id;
    setActivePage("overview");
  }

  function nodeServerStateLabel(serverId: string) {
    if (status?.server.id !== serverId) return "UNKNOWN";
    if (!status.docker.configured) return "UNKNOWN";
    return status.docker.running ? "RUNNING" : "STOPPED";
  }

  useEffect(() => {
    if (activePage !== "nodes") return;
    const servers = contextNodes.flatMap((node) => node.servers);
    if (!servers.length) return;
    if (demoMode) {
      setServerActivities((current) => ({
        ...current,
        [demoServerId]: demoOverviewData(demoRunning).activity
      }));
      return;
    }

    let cancelled = false;
    let inFlight = false;
    async function loadNodeServerActivity() {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const entries = await Promise.all(servers.map(async (server) => {
          try {
            const data = await api<ServerOverviewData>(`/api/servers/${server.id}/events`);
            return [server.id, data.activity] as const;
          } catch {
            return [server.id, undefined] as const;
          }
        }));
        if (cancelled) return;
        setServerActivities((current) => {
          const next = { ...current };
          for (const [serverId, activity] of entries) {
            if (activity) next[serverId] = activity;
          }
          return next;
        });
      } finally {
        inFlight = false;
      }
    }

    void loadNodeServerActivity();
    const interval = window.setInterval(() => void loadNodeServerActivity(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activePage, contextNodes, demoMode, demoRunning]);

  useEffect(() => {
    if (!overflowOpen) return;
    const handleOutsideClick = () => setOverflowOpen(false);
    window.addEventListener("click", handleOutsideClick);
    return () => window.removeEventListener("click", handleOutsideClick);
  }, [overflowOpen]);

  useEffect(() => {
    if (Object.keys(nodeUpdatingSince).length === 0) return;
    const interval = window.setInterval(() => setNodeUpdateNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [nodeUpdatingSince]);

  useEffect(() => {
    setNodeUpdatingSince((current) => {
      const now = Date.now();
      const next = { ...current };
      let changed = false;
      for (const [nodeId, startedAt] of Object.entries(current)) {
        const node = contextNodes.find((candidate) => candidate.id === nodeId);
        if (node?.status === "online" || now - startedAt >= nodeUpdateGraceMs) {
          delete next[nodeId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [contextNodes, nodeUpdateNow]);

  useEffect(() => {
    if (Object.keys(nodeUpdatingSince).length === 0 || demoMode) return;
    let inFlight = false;
    const interval = window.setInterval(() => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      void refreshApp({ silent: true }).finally(() => {
        inFlight = false;
      });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [nodeUpdatingSince, demoMode]);

  useEffect(() => {
    if (!authSession || (!authSession.authenticated && !demoMode)) return;
    refreshApp();
    api<FabricVersions>("/api/fabric/versions").then(setFabricVersions).catch(() => {
      setFabricVersions({
        game: [{ version: "1.21.4", stable: true }, { version: "1.21.1", stable: true }, { version: "1.20.1", stable: true }],
        loader: [],
        installer: []
      });
    });
    if (canViewUsers) {
      void loadUsers();
    }
  }, [authSession?.authenticated, authSession?.user?.rolePreset, canViewUsers, demoMode]);

  useEffect(() => {
    if (demoMode) {
      setNotice("");
      setActiveServerId(demoServerId);
      setActivePage("overview");
    } else if (activeServerId === demoServerId) {
      setActiveServerId("");
      setStatus(null);
      setLogs([]);
      filesWorkspace.actions.clearWorkspace();
      void refreshApp();
    }
  }, [demoMode]);

  useEffect(() => {
    if (!activeServer) {
      fileWorkspaceServerIdRef.current = "";
      return;
    }
    setActiveServerId(activeServer.id);
    const serverChanged = consoleLogServerIdRef.current !== activeServer.id;
    const initializeFileWorkspace = fileWorkspaceServerIdRef.current !== activeServer.id;
    consoleLogServerIdRef.current = activeServer.id;
    if (serverChanged) setLogs([]);
    if (serverChanged) {
      const cachedPlayerMetrics = storedPlayerMetricsActivity(activeServer.id);
      setOverviewData({ events: [], activity: cachedPlayerMetrics ?? {} });
      if (cachedPlayerMetrics) {
        setServerActivities((current) => ({ ...current, [activeServer.id]: cachedPlayerMetrics }));
      }
    }
    if (initializeFileWorkspace) {
      fileWorkspaceServerIdRef.current = activeServer.id;
      filesWorkspace.actions.resetEditorState();
      setResourceSamples([]);
    }
    if (demoMode && activeServer.id === demoServerId) {
      setStatus(demoStatus(activeServer, demoRunning));
      setLogs([
        consoleLine("[demo] Starting minecraft server version 1.21.4"),
        consoleLine("[demo] Loading Fabric Loader 0.16.10"),
        consoleLine("[demo] Preparing spawn area: 100%"),
        consoleLine("[demo] Done (5.132s)! For help, type \"help\"")
      ]);
      if (initializeFileWorkspace) filesWorkspace.actions.initializeDemoRoot();
      return;
    }
    if (activeNodeRuntimeBlocked) {
      fileWorkspaceServerIdRef.current = "";
      filesWorkspace.actions.resetEditorState();
      setStatus(null);
      setStatusError(activeNodeBlockMessage);
      setConsoleError(activeNodeBlockMessage);
      filesWorkspace.actions.setFilesError(activeNodeBlockMessage);
      setOverviewError(activeNodeBlockMessage);
      setOverviewLoading(false);
      filesWorkspace.actions.setFilesLoading(false);
      setConsoleLoading(false);
      filesWorkspace.actions.setListing({ path: "/", entries: [] });
      return;
    }
    if (initializeFileWorkspace) {
      void refreshStatus(activeServer.id);
      void filesWorkspace.actions.loadFiles(activeServer.id, "/");
    }

    if (consoleReconnectTimeoutRef.current !== null) {
      window.clearTimeout(consoleReconnectTimeoutRef.current);
      consoleReconnectTimeoutRef.current = null;
    }
    if (consoleCommandRefreshTimeoutRef.current !== null) {
      window.clearTimeout(consoleCommandRefreshTimeoutRef.current);
      consoleCommandRefreshTimeoutRef.current = null;
    }

    const serverId = activeServer.id;
    let closedByCleanup = false;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/console?serverId=${encodeURIComponent(serverId)}`);
    function reconnect() {
      if (closedByCleanup || activeServerIdRef.current !== serverId) return;
      setConsoleError("Live console stream disconnected. Reconnecting automatically.");
      if (consoleReconnectTimeoutRef.current !== null) {
        window.clearTimeout(consoleReconnectTimeoutRef.current);
      }
      consoleReconnectTimeoutRef.current = window.setTimeout(() => {
        consoleReconnectTimeoutRef.current = null;
        if (activeServerIdRef.current === serverId) {
          setConsoleStreamVersion((version) => version + 1);
        }
      }, 2_000);
    }

    socket.onopen = () => {
      if (activeServerIdRef.current === serverId) {
        setConsoleError("");
      }
    };
    socket.onmessage = (event) => {
      let message: { type?: string; source?: string; text?: string; message?: string };
      try {
        message = JSON.parse(event.data);
      } catch {
        setLogs([consoleLine("Console stream sent an unreadable message.")]);
        return;
      }
      if (message.type === "log") {
        setLogs((current) => [...current.slice(-499), message.text ?? ""]);
        if (message.text && hasPotentialEvent(message.text) && activeServerIdRef.current) {
          triggerOverviewRefreshRef.current(activeServerIdRef.current);
        }
      }
      if (message.type === "unavailable") {
        const unavailableMessage = message.message ?? "Console stream is unavailable.";
        setLogs([consoleLine(unavailableMessage)]);
        if (isReconnectableConsoleUnavailable(unavailableMessage)) {
          void refreshApp({ silent: true });
          void refreshStatus(serverId);
          reconnect();
          socket.close();
        }
      }
      if (message.type === "empty") {
        setLogs((current) => current.length ? current : []);
      }
    };
    socket.onerror = reconnect;
    socket.onclose = reconnect;
    return () => {
      closedByCleanup = true;
      if (consoleReconnectTimeoutRef.current !== null) {
        window.clearTimeout(consoleReconnectTimeoutRef.current);
        consoleReconnectTimeoutRef.current = null;
      }
      socket.close();
    };
  }, [activeServer?.id, consoleStreamVersion, demoMode, activeNodeRuntimeBlocked, activeNodeBlockMessage]);

  useEffect(() => {
    if (!activeServer || activeServerIsDemo || !activeStatus || activeStatus.docker.running) return;
    clearStoredPlayerMetrics(activeServer.id);
    setServerActivities((current) => {
      const activity = current[activeServer.id];
      if (!activity || activity.playersOnline === null || activity.playersOnline === undefined) return current;
      return {
        ...current,
        [activeServer.id]: { ...activity, playersOnline: null }
      };
    });
    if (activeServerIdRef.current === activeServer.id) {
      setOverviewData((current) => {
        if (current.activity.playersOnline === null || current.activity.playersOnline === undefined) return current;
        return { ...current, activity: { ...current.activity, playersOnline: null } };
      });
    }
  }, [activeServer?.id, activeServerIsDemo, activeStatus?.docker.running]);

  useEffect(() => {
    window.localStorage.setItem("serversentinel-command-history", JSON.stringify(commandHistory.slice(-50)));
  }, [commandHistory]);

  useEffect(() => {
    try {
      window.localStorage.setItem(activePageStorageKey, activePage);
    } catch {
      // Ignore unavailable browser storage; the page will fall back to overview on reload.
    }
  }, [activePage]);

  useEffect(() => {
    if (!addNodeOpen || !addNodeResult || demoMode) return;
    const currentNode = contextNodes.find((node) => node.id === addNodeResult.node.id);
    if (currentNode && currentNode.status === "online" && currentNode.compatibility === "compatible" && isNodeRuntimeUsable(currentNode)) return;
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      void refreshApp();
    }, 2500);
    return () => window.clearInterval(interval);
  }, [addNodeOpen, addNodeResult?.node.id, contextNodes, demoMode]);

  useEffect(() => {
    if (!activeServer || activeNodeRuntimeBlocked) return;
    if (demoMode && activeServer.id === demoServerId) {
      setResourceSamples([demoStats(demoRunning)]);
      const interval = window.setInterval(() => setResourceSamples((samples) => [...samples, demoStats(demoRunning)].slice(-resourceHistorySampleLimit)), resourcePollMs);
      return () => window.clearInterval(interval);
    }
    const serverId = activeServer.id;
    let cancelled = false;
    let inFlight = false;
    setResourceSamples([]);
    async function pollStats() {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const history = await api<ResourceStatsHistory>(`/api/servers/${serverId}/stats/history`);
        if (cancelled) return;
        setResourceSamples(history.samples);
      } catch (error) {
        if (handleStaleSession(error)) return;
        if (!cancelled) {
          setResourceSamples([{
            available: false,
            running: false,
            cpuPercent: 0,
            memoryUsageBytes: 0,
            memoryLimitBytes: 0,
            readAt: new Date().toISOString(),
            message: (error as Error).message || "Container stats are unavailable",
            sampledAt: Date.now()
          }]);
        }
      } finally {
        inFlight = false;
      }
    }
    void pollStats();
    const interval = window.setInterval(() => void pollStats(), resourcePollMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeServer?.id, activeNodeRuntimeBlocked, demoMode, demoRunning]);

  useEffect(() => {
    if (!activeServer || demoMode || activeNodeRuntimeBlocked) return;
    const serverId = activeServer.id;
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      void refreshStatus(serverId);
    }, serverStatusPollMs);
    return () => window.clearInterval(interval);
  }, [activeServer?.id, demoMode, activeNodeRuntimeBlocked]);

  useEffect(() => {
    if (!activeServer || demoMode || activeNodeRuntimeBlocked || activePage !== "schedule") return;
    void refreshApp({ silent: true });
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      void refreshApp({ silent: true });
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [activeServer?.id, activePage, demoMode, activeNodeRuntimeBlocked]);

  useEffect(() => {
    if (!activeServer || activeNodeRuntimeBlocked || activePage !== "overview") return;
    if (demoMode && activeServer.id === demoServerId) {
      setOverviewData(demoOverviewData(demoRunning));
      setOverviewError("");
      setOverviewLoading(false);
      return;
    }
    const serverId = activeServer.id;
    let cancelled = false;
    let inFlight = false;
    setOverviewLoading(!overviewData.events.length && Object.keys(overviewData.activity).length === 0);
    setOverviewError("");
    async function loadOverviewData() {
      if (inFlight || document.hidden) return;
      inFlight = true;
      await refreshOverviewData(serverId);
      inFlight = false;
      if (cancelled) setOverviewLoading(false);
    }
    void loadOverviewData();
    const interval = window.setInterval(() => void loadOverviewData(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeServer?.id, activeNodeRuntimeBlocked, activePage, demoMode, demoRunning, refreshOverviewData]);

  useEffect(() => {
    const currentIds = new Set(activeJobs.map((job) => job.id));
    activeJobToastIdsRef.current.forEach((jobId) => {
      if (!currentIds.has(jobId)) {
        toast.dismiss(jobId);
        activeJobToastIdsRef.current.delete(jobId);
      }
    });

    activeJobs.forEach((job) => {
      activeJobToastIdsRef.current.add(job.id);
      const inProgress = job.status === "queued" || job.status === "running";
      const description = `${job.subject ? `${job.subject} - ` : ""}${job.error || job.task}${inProgress ? ` (${Math.round(job.progress)}%)` : ""}`;
      const options = {
        id: job.id,
        description,
        dismissible: job.dismissible,
        closeButton: job.dismissible,
        duration: inProgress || !job.dismissible ? Infinity : 7000,
        onDismiss: () => {
          if (job.dismissible) setActiveJobs((current) => current.filter((candidate) => candidate.id !== job.id));
        }
      };

      if (inProgress) {
        toast.loading(job.title, options);
        return;
      }
      if (job.finalNotification) {
        toast.dismiss(job.id);
        activeJobToastIdsRef.current.delete(job.id);
        const finalOptions = {
          id: `${job.id}:final`,
          duration: 5000,
          dismissible: true,
          closeButton: true
        };
        if (job.finalNotification.type === "success") toast.success(job.finalNotification.text, finalOptions);
        else if (job.finalNotification.type === "error") toast.error(job.finalNotification.text, finalOptions);
        else if (job.finalNotification.type === "warning") toast.warning(job.finalNotification.text, finalOptions);
        else toast.info(job.finalNotification.text, finalOptions);
        setActiveJobs((current) => current.filter((candidate) => candidate.id !== job.id));
        return;
      }
      if (job.status === "failed" || job.status === "cancelled") {
        toast.error(job.title, options);
        return;
      }
      toast.success(job.title, { ...options, duration: job.dismissible ? 5000 : 3000 });
    });
  }, [activeJobs]);

  useEffect(() => {
    const toastId = "overview-load";
    if (activePage !== "overview" || !activeServer || activeNodeRuntimeBlocked || !overviewError) {
      toast.dismiss(toastId);
      return;
    }
    toast.error("Overview update failed", {
      id: toastId,
      description: overviewError,
      duration: 7000,
      closeButton: true,
      dismissible: true
    });
  }, [activeNodeRuntimeBlocked, activePage, activeServer?.id, overviewError]);

  function notify(type: "success" | "error" | "info" | "warning", text: string) {
    const options = { duration: type === "error" ? 7000 : 5000, closeButton: true, dismissible: true };
    if (type === "success") {
      toast.success(text, options);
      return;
    }
    if (type === "error") {
      toast.error(text, options);
      return;
    }
    if (type === "warning") {
      toast.warning(text, options);
      return;
    }
    toast.info(text, options);
  }

  function resetSessionRequestGuards() {
    appRefreshInFlightRef.current = false;
    statusRefreshInFlightRef.current.clear();
    if (overviewRefreshTimeoutRef.current !== null) {
      window.clearTimeout(overviewRefreshTimeoutRef.current);
      overviewRefreshTimeoutRef.current = null;
    }
  }

  function handleStaleSession(error: unknown) {
    if (!(error instanceof ApiError) || error.status !== 401) return false;
    if (authSubmittingRef.current || Date.now() < staleSessionSuppressUntilRef.current) return true;
    if (staleSessionLogoutRef.current) return true;
    staleSessionLogoutRef.current = true;
    resetSessionRequestGuards();
    writeStoredDemoMode(false);
    setDemoMode(false);
    setAuthNotice("Sign in again to continue.");
    setAuthSession({ authenticated: false, setupRequired: false, user: null });
    setAppState(emptyApp);
    setAppStateLoaded(false);
    setAppLoadError("");
    setAppRefreshing(false);
    setActiveServerId("");
    activeServerIdRef.current = "";
    setStatus(null);
    setStatusError("");
    setOverviewData({ events: [], activity: {} });
    setOverviewError("");
    setOverviewLoading(false);
    setResourceSamples([]);
    setConsoleError("");
    filesWorkspace.actions.setFilesError("");
    setLogs([]);
    filesWorkspace.actions.clearWorkspace();
    notify("warning", "You were logged out because the panel restarted and the loaded state is no longer current. Sign in again to continue.");
    return true;
  }

  async function refreshAuth() {
    try {
      const session = await api<AuthSession>("/api/auth/session");
      setAuthNotice("");
      setAuthSession(session);
    } catch (error) {
      setAuthNotice("");
      setAuthSession({ authenticated: false, setupRequired: false, user: null });
      setAppStateLoaded(false);
    }
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authSubmitting) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const username = String(form.get("username") || "").trim();
    const password = String(form.get("password") || "");
    const confirmPassword = String(form.get("confirmPassword") || "");
    const setupRequired = authSession?.setupRequired ?? false;
    const demoLogin = demoModeEnabled && username === "demo" && password === "demo";
    setAuthNotice("");
    if (!demoLogin) {
      const errors = [
        validateUsername(username) ? { field: "username", message: validateUsername(username)! } : null,
        validatePassword(password, true) ? { field: "password", message: validatePassword(password, true)! } : null
      ].filter((error): error is { field: string; message: string } => Boolean(error));
      if (setValidationNotice(formElement, errors, setAuthNotice)) return;
    }
    if (setupRequired && !demoLogin) {
      if (password !== confirmPassword) {
        setValidationNotice(formElement, [{ field: "confirmPassword", message: "Passwords do not match." }], setAuthNotice);
        return;
      }
    }
    setAuthSubmitting(true);
    authSubmittingRef.current = true;
    staleSessionSuppressUntilRef.current = Date.now() + 10_000;
    let loginSucceeded = false;
    try {
      const session = await api<AuthSession>(setupRequired && !demoLogin ? "/api/auth/register-first" : "/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      loginSucceeded = true;
      resetSessionRequestGuards();
      if (session.demo && !demoModeEnabled) {
        setAuthNotice("Demo mode is not enabled in this build.");
        return;
      }
      if (session.demo) {
        writeStoredDemoMode(true);
        setAuthNotice("");
        setNotice("");
        setAppStateLoaded(false);
        staleSessionLogoutRef.current = false;
        staleSessionSuppressUntilRef.current = Date.now() + 5_000;
        setDemoMode(true);
        setAuthSession({ ...session, setupRequired: false });
        setActiveServerId(demoServerId);
        setActivePage("overview");
        return;
      }
      setAuthNotice("");
      setNotice("");
      setAppStateLoaded(false);
      setDemoMode(false);
      staleSessionLogoutRef.current = false;
      staleSessionSuppressUntilRef.current = Date.now() + 5_000;
      setAuthSession(session);
      formElement.reset();
    } catch (error) {
      setAuthNotice((error as Error).message);
    } finally {
      authSubmittingRef.current = false;
      if (!loginSucceeded) staleSessionSuppressUntilRef.current = 0;
      setAuthSubmitting(false);
    }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => null);
    resetSessionRequestGuards();
    writeStoredDemoMode(false);
    setDemoMode(false);
    setAuthSession({ authenticated: false, setupRequired: false, user: null });
    setAppState(emptyApp);
    setAppStateLoaded(false);
    setActiveServerId("");
    setStatus(null);
    setLogs([]);
    staleSessionLogoutRef.current = false;
    staleSessionSuppressUntilRef.current = 0;
  }

  function parsePermissionsField(form: FormData): PermissionKey[] {
    try {
      const parsed = JSON.parse(String(form.get("permissions") || "[]"));
      return Array.isArray(parsed) ? normalizePermissions(parsed) : [];
    } catch {
      return [];
    }
  }

  async function loadUsers() {
    if (!canViewUsers) return;
    setUsersLoading(true);
    setUsersError("");
    try {
      const result = await api<{ users: PublicUser[] }>("/api/users");
      setUsers(result.users);
    } catch (error) {
      const message = errorMessage(error, "Could not load users. Check your permissions and try again.");
      setUsersError(message);
      notify("error", message);
    } finally {
      setUsersLoading(false);
    }
  }

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageUsers || userSaving) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const username = trimFormValue(form, "username");
    const password = String(form.get("password") || "");
    const permissions = parsePermissionsField(form);
    const errors = [
      validateUsername(username) ? { field: "username", message: validateUsername(username)! } : null,
      validatePassword(password, true) ? { field: "password", message: validatePassword(password, true)! } : null,
      permissions.length === 0 ? { field: "permissions", message: "Choose at least one permission." } : null
    ].filter((error): error is { field: string; message: string } => Boolean(error));
    if (setValidationNotice(formElement, errors, (message) => notify("error", message))) return;
    setUserSaving(true);
    try {
      await api<PublicUser>("/api/users", {
        method: "POST",
        body: JSON.stringify({
          username,
          password,
          rolePreset: form.get("rolePreset"),
          permissions
        })
      });
      formElement.reset();
      setUserModal(null);
      notify("success", "User account created");
      await loadUsers();
    } catch (error) {
      notify("error", (error as Error).message);
    } finally {
      setUserSaving(false);
    }
  }

  async function updateUser(event: FormEvent<HTMLFormElement>, user: PublicUser) {
    event.preventDefault();
    if (!canManageUsers || userSaving) return;
    const formElement = event.currentTarget;
    const form = new FormData(event.currentTarget);
    const username = trimFormValue(form, "username");
    const permissions = parsePermissionsField(form);
    const errors = [
      validateUsername(username) ? { field: "username", message: validateUsername(username)! } : null,
      permissions.length === 0 ? { field: "permissions", message: "Choose at least one permission." } : null
    ].filter((error): error is { field: string; message: string } => Boolean(error));
    if (setValidationNotice(formElement, errors, (message) => notify("error", message))) return;
    if (authSession?.user?.id === user.id && !permissions.includes("users.manage")) {
      if (!window.confirm("Save changes without your own Manage users permission?\n\nThe backend may reject this if it would remove the last full-access admin.")) return;
    }
    setUserSaving(true);
    try {
      await api<PublicUser>(`/api/users/${user.id}`, {
        method: "PUT",
        body: JSON.stringify({
          username,
          rolePreset: form.get("rolePreset"),
          permissions
        })
      });
      setUserModal(null);
      notify("success", "User account updated");
      await loadUsers();
      if (authSession?.user?.id === user.id) {
        await refreshAuth();
      }
    } catch (error) {
      notify("error", (error as Error).message);
    } finally {
      setUserSaving(false);
    }
  }

  async function resetUserPassword(event: FormEvent<HTMLFormElement>, user: PublicUser) {
    event.preventDefault();
    if (!canManageUsers || userSaving) return false;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const password = String(form.get("password") || "");
    const confirmPassword = String(form.get("confirmPassword") || "");
    const errors = [
      validatePassword(password, true) ? { field: "password", message: validatePassword(password, true)! } : null,
      password !== confirmPassword ? { field: "confirmPassword", message: "Passwords do not match." } : null
    ].filter((error): error is { field: string; message: string } => Boolean(error));
    if (setValidationNotice(formElement, errors, (message) => notify("error", message))) return false;
    setUserSaving(true);
    try {
      await api<PublicUser>(`/api/users/${user.id}`, {
        method: "PUT",
        body: JSON.stringify({ password })
      });
      formElement.reset();
      notify("success", `Password reset for ${user.username}`);
      return true;
    } catch (error) {
      notify("error", (error as Error).message);
      return false;
    } finally {
      setUserSaving(false);
    }
  }

  async function deleteUser(user: PublicUser) {
    if (!canManageUsers || userSaving) return;
    if (!window.confirm(`Delete user ${user.username}?\n\nThis immediately removes their account and invalidates their sessions.`)) return;
    setUserSaving(true);
    try {
      await api(`/api/users/${user.id}`, { method: "DELETE" });
      notify("success", `Deleted ${user.username}`);
      await loadUsers();
      if (authSession?.user?.id === user.id) {
        await logout();
      }
    } catch (error) {
      notify("error", (error as Error).message);
    } finally {
      setUserSaving(false);
    }
  }

  async function refreshApp(options: { silent?: boolean } = {}) {
    if (!demoMode && (!authSession || !authSession.authenticated)) {
      return;
    }
    if (appRefreshInFlightRef.current) return;
    appRefreshInFlightRef.current = true;
    setAppRefreshing(true);
    if (!options.silent) setNotice("");
    try {
      const next = await api<AppState>("/api/app");
      setAppState(next);
      setAppStateLoaded(true);
      setAppLoadError("");
      if (demoMode) {
        setActiveServerId(demoServerId);
      } else if (activeServerId && !next.servers.some((server) => server.id === activeServerId)) {
        setActiveServerId(next.servers[0]?.id ?? "");
      } else if (!activeServerId && next.servers[0]) {
        setActiveServerId(next.servers[0].id);
      }
    } catch (error) {
      if (handleStaleSession(error)) return;
      const message = errorMessage(error, "Could not load the application state. Check the server connection and retry.");
      setAppLoadError(message);
      if (!options.silent) {
        setNotice(message);
        notify("error", message);
      }
    } finally {
      appRefreshInFlightRef.current = false;
      setAppRefreshing(false);
    }
  }

  async function refreshStatus(serverId = activeServer?.id) {
    if (isProvisioning) return;
    if (!serverId) return;
    if (demoMode && serverId === demoServerId) {
      if (activeServerIdRef.current === serverId) {
        setStatus(demoStatus(demoServer(demoSchedules), demoRunning));
      }
      return;
    }
    if (statusRefreshInFlightRef.current.has(serverId)) return;
    statusRefreshInFlightRef.current.add(serverId);
    try {
      const nextStatus = await api<ServerStatus>(`/api/servers/${serverId}/status`);
      if (activeServerIdRef.current === serverId) {
        setStatus(nextStatus);
        setStatusError("");
      }
    } catch (error) {
      if (handleStaleSession(error)) return;
      if (activeServerIdRef.current === serverId) {
        setStatusError(errorMessage(error, "Could not refresh server status. Existing status is preserved."));
      }
    } finally {
      statusRefreshInFlightRef.current.delete(serverId);
    }
  }

  async function refreshConsoleLogs(serverId = activeServer?.id) {
    if (!serverId) return;
    if (demoMode && serverId === demoServerId) {
      if (activeServerIdRef.current === serverId) {
        setLogs((current) => current.length ? current : [
          consoleLine("[demo] Starting minecraft server version 1.21.4"),
          consoleLine("[demo] Done (5.132s)! For help, type \"help\"")
        ]);
      }
      return;
    }
    setConsoleLoading(logs.length === 0);
    setConsoleError("");
    try {
      const result = await api<{ text: string; source: string }>(`/api/servers/${serverId}/logs`);
      if (activeServerIdRef.current !== serverId) return;
      const lines = result.text.split(/\r?\n/).filter(Boolean).slice(-200);
      const nextLogs = lines.map((line) => consoleLine(line));
      setLogs((current) => mergeConsoleLogTail(current, nextLogs));
    } catch (error) {
      if (handleStaleSession(error)) return;
      if (activeServerIdRef.current === serverId) {
        setConsoleError(errorMessage(error, "Could not load console logs. Runtime logs may be unavailable."));
      }
      setConsoleStreamVersion((version) => version + 1);
    } finally {
      if (activeServerIdRef.current === serverId) setConsoleLoading(false);
    }
  }

  function downloadConsoleLogs() {
    if (!activeServer || logs.length === 0) return;
    const safeServerName = (activeServer.displayName || activeServer.id)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "server";
    const timestamp = formatTimestampForFilename(new Date(), runtimeTimeZone);
    const filename = `${safeServerName}-console-${timestamp}.log`;
    const blob = new Blob([logs.join("")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function serverFromOperation(operation: OperationRecord) {
    const result = operation.result;
    if (result && typeof result === "object" && "server" in result) {
      return (result as { server?: ManagedServer }).server;
    }
    return undefined;
  }

  function operationToProvisionActiveJob(operation: OperationRecord): Partial<GeneralJob> {
    return {
      id: operation.id,
      status: operation.status,
      progress: operation.progress,
      task: operation.task || "Server setup is running.",
      error: operation.errorMessage,
      errorDetails: operation.logSummary,
      dismissible: operation.status !== "queued" && operation.status !== "running"
    };
  }

  async function waitForProvisionOperation(operationId: string) {
    for (;;) {
      const operation = await api<OperationRecord>(`/api/operations/${operationId}`);
      setActiveJobs((current) => current.map((j) => j.id === "local" || j.id === operationId ? {
        ...j,
        ...operationToProvisionActiveJob(operation)
      } : j));
      if (operation.status === "succeeded") return operation;
      if (operation.status === "failed" || operation.status === "cancelled") {
        const error = new Error(operation.errorMessage || "Server setup failed") as Error & { details?: string };
        error.details = operation.logSummary;
        throw error;
      }
      await new Promise((resolve) => window.setTimeout(resolve, provisionJobPollMs));
    }
  }

  async function createServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (demoMode) {
      notify("error", "Demo mode is enabled. Exit demo mode before creating managed servers.");
      return;
    }
    if (provisionSubmitLockRef.current || isProvisioning || serverCreationBlocked || !canCreateServers) return;
    setNotice("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const errors = serverConfigValidation(form, appState.servers.map((server) => server.displayName), undefined, { requireNode: true, requireEula: true, requireRuntime: true });
    if (setValidationNotice(formElement, errors, (message) => {
      setNotice(message);
      notify("error", message);
    })) {
      return;
    }
    provisionSubmitLockRef.current = true;
    setProvisioningError("");
    setProvisioningErrorDetails("");
    const displayName = trimFormValue(form, "displayName");
    const initialJob: GeneralJob = {
      id: "local",
      type: "provision",
      status: "running",
      title: "Creating server",
      subject: displayName,
      progress: 0,
      task: "Submitting server setup",
      dismissible: false
    };
    setActiveJobs((current) => [...current, initialJob]);
    try {
      const operation = await api<OperationRecord>("/api/servers/provision", {
        method: "POST",
        body: JSON.stringify({
          displayName: form.get("displayName"),
          runtime: {
            loader: "fabric",
            minecraftVersion: form.get("minecraftVersion"),
            loaderVersion: form.get("loaderVersion"),
            serverJar: form.get("serverJar")
          },
          dockerContainer: form.get("dockerContainer"),
          dockerImage: form.get("dockerImage"),
          dockerMountSource: form.get("dockerMountSource"),
          nodeId: form.get("nodeId"),
          dockerPorts: form.get("dockerPorts"),
          javaArgs: form.get("javaArgs"),
          serverPort: form.get("serverPort"),
          queryPort: form.get("queryPort"),
          acceptEula: form.get("acceptEula") === "on"
        })
      });
      setActiveJobs((current) => current.map((j) => j.id === "local" ? {
        ...j,
        ...operationToProvisionActiveJob(operation)
      } : j));
      const completed = await waitForProvisionOperation(operation.id);
      const server = serverFromOperation(completed);
      if (!server) {
        throw new Error("Server setup completed without returning server details");
      }
      await refreshApp();
      setActiveServerId(server.id);
      activeServerIdRef.current = server.id;
      setActivePage("overview");
      setConsoleStreamVersion((version) => version + 1);
      await refreshStatus(server.id);
      await refreshConsoleLogs(server.id);
      notify("success", `Created ${server.displayName}`);
      window.setTimeout(() => {
        setActiveJobs((current) => current.filter((j) => j.id !== operation.id));
      }, 1200);
    } catch (error) {
      const message = (error as Error).message;
      const details = error instanceof Error && "details" in error && typeof error.details === "string" ? error.details : "";
      setNotice(message);
      setProvisioningError(message);
      setProvisioningErrorDetails(details);
      notify("error", message);
      setActiveJobs((current) => current.filter((j) => j.id !== "local" && !(j.type === "provision" && j.status !== "succeeded")));
    } finally {
      provisionSubmitLockRef.current = false;
    }
  }

  async function updateServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isProvisioning || serverSettingsSaving || !canEditServerSettings) return;
    if (!activeServer) return;
    if (serverRequiresStoppedForMutableConfig) {
      setNotice(stoppedServerMutationMessage);
      notify("warning", stoppedServerMutationMessage);
      return;
    }
    setNotice("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const errors = serverConfigValidation(form, appState.servers.map((server) => server.displayName), activeServer.displayName);
    if (setValidationNotice(formElement, errors, (message) => {
      setNotice(message);
      notify("error", message);
    })) {
      return;
    }
    if (activeServerIsDemo) {
      notify("success", `Updated ${String(form.get("displayName") || activeServer.displayName)} in demo mode`);
      return;
    }
    setServerSettingsSaving(true);
    try {
      const server = await api<ManagedServer>(`/api/servers/${activeServer.id}`, {
        method: "PUT",
        body: JSON.stringify({
          displayName: form.get("displayName"),
          runtime: {
            loader: "fabric",
            minecraftVersion: form.get("minecraftVersion"),
            loaderVersion: form.get("loaderVersion"),
            serverJar: form.get("serverJar")
          },
          dockerContainer: form.get("dockerContainer"),
          dockerImage: form.get("dockerImage"),
          dockerPorts: form.get("dockerPorts"),
          javaArgs: form.get("javaArgs"),
          serverPort: form.get("serverPort"),
          queryPort: form.get("queryPort")
        })
      });
      notify("success", `Updated ${server.displayName}`);
      await refreshApp();
      await refreshStatus(server.id);
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    } finally {
      setServerSettingsSaving(false);
    }
  }

  async function updateModrinthKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageIntegrations) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const key = trimFormValue(form, "modrinthApiKey");
    if (setValidationNotice(formElement, key ? [] : [{ field: "modrinthApiKey", message: "Modrinth API key is required." }], (message) => notify("error", message))) return;
    try {
      await api("/api/settings/modrinth", {
        method: "PUT",
        body: JSON.stringify({ modrinthApiKey: key })
      });
      formElement.reset();
      notify("success", "Modrinth API key saved");
      await refreshApp();
    } catch (error) {
      notify("error", (error as Error).message);
    }
  }

  function currentPanelUrl() {
    return window.location.origin;
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify("success", text.includes("SS_JOIN_TOKEN") ? "Copied install command. Treat the join token as a secret." : "Copied to clipboard");
    } catch {
      notify("error", "Could not copy to clipboard");
    }
  }

  async function refreshNodes() {
    await refreshApp();
    notify("success", "Node status refreshed");
  }

  async function viewNodeDetails(node: ManagedNode) {
    setNodeBusyId(node.id);
    try {
      const details = await api<ManagedNode>(`/api/nodes/${node.id}`);
      setNodeDetails(details);
    } catch (error) {
      notify("error", errorMessage(error, "Could not load node details."));
    } finally {
      setNodeBusyId("");
    }
  }

  async function showNodeInstall(node: ManagedNode) {
    setNodeBusyId(node.id);
    try {
      const result = await api<NodeInstallResponse>(`/api/nodes/${node.id}/install?panelUrl=${encodeURIComponent(currentPanelUrl())}&dataMount=${encodeURIComponent(defaultNodeDataPath)}`);
      setNodeInstallMethod("run");
      setNodeInstallResult(result);
    } catch (error) {
      notify("error", errorMessage(error, "Could not load install instructions."));
    } finally {
      setNodeBusyId("");
    }
  }

  async function rotateNodeToken(node: ManagedNode) {
    if (node.isInternal || !canManageUsers) return;
    setNodeBusyId(node.id);
    try {
      const result = await api<CreateNodeResponse>(`/api/nodes/${node.id}/rotate-token`, {
        method: "POST",
        body: JSON.stringify({ panelUrl: currentPanelUrl(), dataMount: defaultNodeDataPath })
      });
      setNodeInstallMethod("run");
      setNodeInstallResult(result);
      notify("success", `Rotated join token for ${node.name}`);
      await refreshApp();
    } catch (error) {
      notify("error", errorMessage(error, "Could not rotate the join token."));
    } finally {
      setNodeBusyId("");
    }
  }

  async function updateNodeImage(node: ManagedNode) {
    if (node.isInternal || !canManageUsers) return;
    const buildText = panelBuildId ? ` build ${panelBuildId.slice(0, 12)}` : "";
    const sameVersion = node.agentVersion === panelVersion;
    const versionText = sameVersion
      ? ` to ${panelVersion}${buildText}`
      : node.agentVersion ? ` from ${node.agentVersion} to ${panelVersion}${buildText}` : ` to ${panelVersion}${buildText}`;
    if (!window.confirm(`Upgrade node "${node.name}"${versionText}?\n\nThe node may disconnect briefly while the container is recreated.`)) return;
    setNodeBusyId(node.id);
    try {
      const result = await api<NodeUpdateResponse>(`/api/nodes/${node.id}/update`, {
        method: "POST",
        body: JSON.stringify({})
      });
      notify(result.ok ? "success" : "info", result.message || `Node ${node.name} update started.`);
      if (result.ok && result.mode === "self") {
        setNodeUpdatingSince((current) => ({ ...current, [node.id]: Date.now() }));
        setNodeUpdateNow(Date.now());
        setAppState((current) => ({
          ...current,
          nodes: current.nodes?.map((candidate) => candidate.id === node.id ? { ...candidate, status: "offline" } : candidate)
        }));
        setNodeDetails((current) => current?.id === node.id ? { ...current, status: "offline" } : current);
      }
      window.setTimeout(() => void refreshApp(), 5000);
    } catch (error) {
      notify("error", errorMessage(error, "Could not start the node update."));
    } finally {
      setNodeBusyId("");
    }
  }

  async function restartNode(node: ManagedNode) {
    if (!canManageUsers) return;
    if (node.isInternal) {
      if (!window.confirm(`Restart the Panel container ("${node.name}")?\n\nThis will temporarily disconnect your current session while the Panel restarts.`)) return;
    } else {
      if (!window.confirm(`Restart node container "${node.name}"?\n\nThe node will disconnect briefly while the container restarts.`)) return;
    }
    setNodeBusyId(node.id);
    try {
      const result = await api<{ ok: boolean; message?: string }>(`/api/nodes/${node.id}/restart`, {
        method: "POST"
      });
      notify(result.ok ? "success" : "info", result.message || `Node ${node.name} restart started.`);
      
      const now = Date.now();
      setNodeUpdatingSince((current) => ({ ...current, [node.id]: now }));
      setNodeUpdateNow(now);
      setAppState((current) => ({
        ...current,
        nodes: current.nodes?.map((candidate) => candidate.id === node.id ? { ...candidate, status: "offline" } : candidate)
      }));
      setNodeDetails((current) => current?.id === node.id ? { ...current, status: "offline" } : current);
      
      window.setTimeout(() => void refreshApp(), 5000);
    } catch (error) {
      notify("error", errorMessage(error, "Could not restart the node container."));
    } finally {
      setNodeBusyId("");
    }
  }

  async function removeNode(node: ContextNode, force = false) {
    if (node.isInternal || !canManageUsers) return;
    const assignedMessage = node.servers.length
      ? force
        ? `\n\nThis will remove ${node.servers.length} assigned server record${node.servers.length === 1 ? "" : "s"} from the panel even if managed container cleanup cannot finish. Remote server files are not deleted.`
        : `\n\nThis will remove managed containers for ${node.servers.length} assigned server${node.servers.length === 1 ? "" : "s"}, then remove the server record${node.servers.length === 1 ? "" : "s"} from the panel. Remote server files are not deleted.`
      : "";
    if (!window.confirm(`${force ? "Force remove" : "Remove"} node "${node.name}"?${assignedMessage}\n\nThis cannot be undone.`)) return;
    setNodeBusyId(node.id);
    try {
      const result = await api<{
        ok: boolean;
        deletedServers?: number;
        selfRemoval?: { ok: boolean; message: string };
        serverCleanup?: {
          attempted: number;
          deletedContainers: number;
          failed: Array<{ serverId: string; serverName: string; message: string }>;
          skippedReason?: string;
        };
      }>(`/api/nodes/${node.id}${force ? "?force=true" : ""}`, { method: "DELETE" });
      const removedServers = result.deletedServers ?? 0;
      const selfStopSuffix = result.selfRemoval?.ok ? " The node container will stop itself." : result.selfRemoval?.message ? ` ${result.selfRemoval.message}` : "";
      const cleanupFailures = result.serverCleanup?.failed.length ?? 0;
      const cleanupWarning = result.serverCleanup?.skippedReason
        ? ` ${result.serverCleanup.skippedReason}`
        : cleanupFailures
          ? ` ${cleanupFailures} server container cleanup ${cleanupFailures === 1 ? "failure was" : "failures were"} reported.`
          : "";
      notify(cleanupWarning ? "warning" : "success", `${removedServers ? `Removed ${node.name} and ${removedServers} server${removedServers === 1 ? "" : "s"}` : `Removed ${node.name}`}.${cleanupWarning}${selfStopSuffix}`);
      if (nodeDetails?.id === node.id) setNodeDetails(null);
      if (nodeInstallResult?.node.id === node.id) setNodeInstallResult(null);
      await refreshApp();
    } catch (error) {
      notify("error", errorMessage(error, "Could not remove the node."));
    } finally {
      setNodeBusyId("");
    }
  }

  async function createNode(input: { name: string; panelUrl: string; dataMount: string }) {
    if (!canManageUsers) return;
    setNodeBusyId("create");
    try {
      const result = await api<CreateNodeResponse>("/api/nodes", {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          panelUrl: input.panelUrl,
          dataMount: input.dataMount
        })
      });
      setNodeInstallMethod("run");
      setAddNodeResult(result);
      notify("success", `Created pending node ${result.node.name}`);
      await refreshApp();
    } catch (error) {
      notify("error", errorMessage(error, "Could not create the node."));
    } finally {
      setNodeBusyId("");
    }
  }

  async function runContainerAction(action: "start" | "stop" | "restart", options: { announceRequest?: boolean } = {}) {
    if (isProvisioning || dockerOperationalLock || !canBasic) return;
    if (!activeServer) return;
    setNotice("");
    setRuntimeAction(action);
    const actionLabel = action === "start" ? "Start" : action === "stop" ? "Stop" : "Restart";
    const completedLabel = action === "start" ? "started" : action === "stop" ? "stopped" : "restarted";
    if (options.announceRequest !== false) notify("info", `${actionLabel} request sent`);
    try {
      if (activeServerIsDemo) {
        const nextRunning = action !== "stop";
        setDemoRunning(nextRunning);
        setStatus(demoStatus(activeServer, nextRunning));
        setResourceSamples([demoStats(nextRunning)]);
        setLogs((current) => [
          ...current.slice(-496),
          consoleLine(`[demo] ${action === "restart" ? "Restarting" : action === "start" ? "Starting" : "Stopping"} simulated server`),
          consoleLine(`[demo] Server is now ${nextRunning ? "running" : "stopped"}`)
        ]);
        notify("success", `Demo server ${completedLabel}`);
        return;
      }
      await api(`/api/servers/${activeServer.id}/${action}`, { method: "POST" });
      await refreshApp({ silent: true });
      await refreshStatus(activeServer.id);
      setConsoleStreamVersion((version) => version + 1);
      await refreshConsoleLogs(activeServer.id);
      notify("success", `${activeServer.displayName} ${completedLabel}`);
    } catch (error) {
      setConsoleStreamVersion((version) => version + 1);
      await refreshConsoleLogs(activeServer.id);
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    } finally {
      setRuntimeAction(null);
    }
  }

  async function sendCommand(commandText: string) {
    if (isProvisioning || commandSending || dockerOperationalLock || !canExpanded) return;
    if (!activeServer) return;
    const command = commandText.trim().replace(/^\//, "");
    if (!command) return;
    setCommandSending(true);
    setNotice("");
    try {
      if (activeServerIsDemo) {
        const response = command === "list"
          ? "There are 2 of a max of 20 players online: Alex, Steve"
          : command === "seed"
            ? "Seed: 8675309"
            : command === "help"
              ? "Available demo commands: help, list, seed, say, stop"
              : command.startsWith("say ")
                ? `[Server] ${command.slice(4)}`
                : `Executed demo command: ${command}`;
        setLogs((current) => [...current.slice(-498), consoleLine(`[demo] ${response}`)]);
        setCommandHistory((current) => appendCommandHistory(current, command));
        return;
      }
      await api(`/api/servers/${activeServer.id}/command`, {
        method: "POST",
        body: JSON.stringify({ command })
      });
      setCommandHistory((current) => appendCommandHistory(current, command));
      if (consoleCommandRefreshTimeoutRef.current !== null) {
        window.clearTimeout(consoleCommandRefreshTimeoutRef.current);
      }
      consoleCommandRefreshTimeoutRef.current = window.setTimeout(() => {
        consoleCommandRefreshTimeoutRef.current = null;
        void refreshConsoleLogs(activeServer.id);
      }, 1_500);
    } catch (error) {
      const message = errorMessage(error, "Could not send the console command. Refresh server status and try again.");
      setNotice(message);
      notify("error", message);
      await refreshStatus(activeServer.id);
    } finally {
      setCommandSending(false);
    }
  }

  async function createSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isProvisioning || scheduleBusy || dockerOperationalLock || !canManageSchedules || !activeServer) return false;
    setNotice("");
    setScheduleBusy(true);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const scheduleName = trimFormValue(form, "name");
    const cron = trimFormValue(form, "cron");
    const delayValues = form.getAll("commandDelaysMinutes").map(Number);
    const commandRows = form.getAll("commands").map(String).map((command, index) => ({
      command: command.trim(),
      delayMinutes: delayValues[index] ?? 0
    })).filter((row) => Boolean(row.command));
    const commands = commandRows.map((row) => row.command);
    const commandDelaysMinutes = commandRows.map((row) => row.delayMinutes);
    const scheduleErrors = [
      scheduleName ? null : { field: "name", message: "Schedule name is required." },
      validateCronExpression(cron) ? { field: "cron", message: validateCronExpression(cron)! } : null,
      validateCommandList(commands) ? { field: "commands", message: validateCommandList(commands)! } : null
    ].filter((error): error is { field: string; message: string } => Boolean(error));
    if (setValidationNotice(formElement, scheduleErrors, (message) => {
      setNotice(message);
      notify("error", message);
    })) {
      setScheduleBusy(false);
      return false;
    }
    if (activeServerIsDemo) {
      const schedule: ScheduledExecution = {
        id: clientId(),
        name: scheduleName,
        cron,
        commands,
        commandDelaysMinutes,
        onlyWhenNoPlayers: form.get("onlyWhenNoPlayers") === "on",
        enabled: form.get("enabled") === "on",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastMessage: "Not run in demo session"
      };
      setDemoSchedules((current) => [schedule, ...current]);
      formElement.reset();
      notify("success", "Demo scheduled execution created");
      setScheduleBusy(false);
      return true;
    }
    try {
      await api<ScheduledExecution>(`/api/servers/${activeServer.id}/schedules`, {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          cron,
          commands,
          commandDelaysMinutes,
          onlyWhenNoPlayers: form.get("onlyWhenNoPlayers") === "on",
          enabled: form.get("enabled") === "on"
        })
      });
      formElement.reset();
      notify("success", "Scheduled execution created");
      await refreshApp();
      return true;
    } catch (error) {
      const message = errorMessage(error, "Could not create the schedule. Check the cron expression and commands.");
      setNotice(message);
      notify("error", message);
      return false;
    } finally {
      setScheduleBusy(false);
    }
  }

  async function updateSchedule(schedule: ScheduledExecution, patch: Partial<ScheduledExecution>) {
    if (isProvisioning || scheduleBusy || dockerOperationalLock || !canManageSchedules || !activeServer) return false;
    setScheduleBusy(true);
    const actionLabel = patch.enabled !== undefined && Object.keys(patch).length === 1
      ? patch.enabled ? "Schedule enabled" : "Schedule disabled"
      : "Schedule updated";
    if (activeServerIsDemo) {
      setDemoSchedules((current) => current.map((candidate) => (
        candidate.id === schedule.id
          ? { ...candidate, ...patch, updatedAt: new Date().toISOString() }
          : candidate
      )));
      notify("success", actionLabel);
      setScheduleBusy(false);
      return true;
    }
    try {
      const next = { ...schedule, ...patch };
      await api<ScheduledExecution>(`/api/servers/${activeServer.id}/schedules/${schedule.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: next.name,
          cron: next.cron,
          commands: next.commands,
          commandDelaysMinutes: next.commandDelaysMinutes,
          onlyWhenNoPlayers: next.onlyWhenNoPlayers,
          enabled: next.enabled
        })
      });
      notify("success", actionLabel);
      await refreshApp();
      return true;
    } catch (error) {
      const message = errorMessage(error, "Could not update the schedule. Try again after refreshing.");
      setNotice(message);
      notify("error", message);
      return false;
    } finally {
      setScheduleBusy(false);
    }
  }

  async function deleteSchedule(schedule: ScheduledExecution) {
    if (isProvisioning || scheduleBusy || dockerOperationalLock || !canManageSchedules || !activeServer) return;
    if (!window.confirm(`Delete scheduled execution "${schedule.name}"?\n\nThis cannot be undone.`)) return;
    setScheduleBusy(true);
    if (activeServerIsDemo) {
      setDemoSchedules((current) => current.filter((candidate) => candidate.id !== schedule.id));
      notify("success", `Deleted ${schedule.name}`);
      setScheduleBusy(false);
      return;
    }
    try {
      await api(`/api/servers/${activeServer.id}/schedules/${schedule.id}`, { method: "DELETE" });
      notify("success", `Deleted ${schedule.name}`);
      await refreshApp();
    } catch (error) {
      const message = errorMessage(error, "Could not delete the schedule. Try again after refreshing.");
      setNotice(message);
      notify("error", message);
    } finally {
      setScheduleBusy(false);
    }
  }

  async function deleteServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isProvisioning || serverSettingsSaving || dockerOperationalLock || !canDeleteServers) return;
    if (!activeServer) return;
    setNotice("");
    const form = new FormData(event.currentTarget);
    if (activeServerIsDemo) {
      if (form.get("confirmName") !== activeServer.displayName) {
        notify("error", "Type the demo server name to confirm");
        return;
      }
      setDemoMode(false);
      notify("success", "Demo mode disabled");
      return;
    }
    setServerSettingsSaving(true);
    try {
      const result = await api<{ ok: boolean; deletedFiles: boolean }>(`/api/servers/${activeServer.id}`, {
        method: "DELETE",
        body: JSON.stringify({
          confirmName: form.get("confirmName"),
          deleteFiles: form.get("deleteFiles") === "on"
        })
      });
      notify("success", result.deletedFiles ? `Deleted ${activeServer.displayName} and its files` : `Removed ${activeServer.displayName}`);
      setActiveServerId("");
      setActivePage("servers");
      await refreshApp();
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    } finally {
      setServerSettingsSaving(false);
    }
  }

  if (!authSession) {
    return (
      <>
        <AppToaster darkMode={darkMode} />
        <AuthPanel
          setupRequired={false}
          notice={authNotice || "Checking session..."}
          onSubmit={submitAuth}
          busy
        />
      </>
    );
  }

  if (!authSession.authenticated && !demoMode) {
    return (
      <>
        <AppToaster darkMode={darkMode} />
        <AuthPanel
          setupRequired={authSession.setupRequired}
          notice={authNotice}
          onSubmit={submitAuth}
          busy={authSubmitting}
        />
      </>
    );
  }

  const provisioningNavigationReason = isProvisioning ? "Server setup is still running." : "";
  const serverPageDisabledReason = !activeServer ? "Select or create a server first." : provisioningNavigationReason;
  const createServerDisabledReason = demoMode
    ? "Exit demo mode before creating real servers."
    : !canCreateServers
      ? "Create servers permission is required."
      : serverCreationBlocked
        ? usableContextNodes.length === 0
          ? "Add an online, compatible node before creating a server."
          : "Server creation is unavailable right now."
        : provisioningNavigationReason;
  const noManagedServersMessage = panelOnlyMode && usableContextNodes.length === 0
    ? "No node is connected yet. Add a node first so serverSENTINEL has a host where it can create Minecraft servers."
    : "No managed servers have been created yet. Create one to set up Fabric files and start managing a Minecraft server from this panel.";
  const addNodeDisabledReason = demoMode
    ? "Exit demo mode before adding real nodes."
    : isProvisioning
      ? provisioningNavigationReason
      : nodeBusyId
        ? "A node action is already in progress."
        : !canManageUsers
          ? "Manage users permission is required."
          : "Add a remote node";

  function openAddNodeFromEmptyState() {
    setActivePage("nodes");
    setAddNodeResult(null);
    setNodeInstallMethod("run");
    if (canManageUsers) setAddNodeOpen(true);
  }

  function renderNoManagedServersEmptyState(title: string) {
    const needsNodeFirst = panelOnlyMode && usableContextNodes.length === 0;
    return (
      <EmptyState
        title={title}
        message={noManagedServersMessage}
        action={needsNodeFirst ? (
          <Button
            onClick={openAddNodeFromEmptyState}
            disabled={demoMode || isProvisioning || Boolean(nodeBusyId) || !canManageUsers}
            title={addNodeDisabledReason}
          >
            Add node
          </Button>
        ) : (
          <Button onClick={() => openCreateServerForNode()} disabled={demoMode || isProvisioning || serverCreationBlocked || !canCreateServers} title={demoMode || isProvisioning || serverCreationBlocked || !canCreateServers ? createServerDisabledReason : "Create a managed server"}>Create managed server</Button>
        )}
      />
    );
  }

  const pageTitles: Record<ActivePage, string> = {
    servers: "Servers",
    create: "Create new managed server",
    overview: "Overview",
    console: "Console",
    files: "Files",
    mods: "Mods",
    schedule: "Schedules",
    properties: "Properties",
    settings: "Settings",
    nodes: "Nodes"
  };
  const currentPageTitle = pageTitles[activePage] ?? (!applicationReady ? "Loading" : "Welcome");

  function resetPageToDefault(page: ActivePage) {
    if (page === "mods") {
      modsWorkspace.actions.resetPageState();
      return;
    }
    if (page === "files") {
      filesWorkspace.actions.resetPageState();
      return;
    }
    if (page === "console") {
      return;
    }
    if (page === "nodes") {
      setNodeDetails(null);
      setAddNodeOpen(false);
      return;
    }
    if (page === "settings") {
      setUserModal(null);
    }
  }

  function openSidebarPage(page: ActivePage) {
    setActivePage(page);
    if (window.matchMedia("(max-width: 720px)").matches) setSidebarCollapsed(true);
  }

  function resetActiveSidebarPage(page: ActivePage) {
    if (activePage !== page) return;
    resetPageToDefault(page);
  }

  return (
    <>
      <AppToaster darkMode={darkMode} />
      <main className={`appShell ${sidebarCollapsed ? "sidebarCollapsed" : ""} ${darkMode ? "themeDark" : "themeLight"}`}>
        <aside className="sidebar">
        <div className="brandBlock">
          <div className="brandLockup">
            <img className="brandLogo" src="/logo.png" alt="" />
            <div>
              <h1>serverSENTINEL</h1>
            </div>
          </div>
          <Button variant="secondary" iconOnly className="iconButton" onClick={() => setSidebarCollapsed((value) => !value)} aria-label="Toggle sidebar" disabled={isProvisioning} title={isProvisioning ? provisioningNavigationReason : "Toggle sidebar"}>
            <SidebarToggleIcon collapsed={sidebarCollapsed} />
          </Button>
        </div>
        <nav className="sideNav">
          <button className={activePage === "nodes" ? "active" : ""} onClick={() => openSidebarPage("nodes")} onDoubleClick={() => resetActiveSidebarPage("nodes")} disabled={isProvisioning} title={isProvisioning ? provisioningNavigationReason : "Open nodes"}>
            <SidebarIcon name="nodes" />
            <span className="navLabel">Nodes</span>
          </button>
          <div className="sidebarDivider" />
          <div className="selectedServerReadout" aria-label="Selected server" title={activeServer?.displayName ?? "No server selected"}>
            {activeServer?.displayName ?? "No server selected"}
          </div>
          <button className={activePage === "overview" ? "active" : ""} onClick={() => openSidebarPage("overview")} onDoubleClick={() => resetActiveSidebarPage("overview")} disabled={isProvisioning || !activeServer} title={isProvisioning || !activeServer ? serverPageDisabledReason : "Open overview"}>
            <SidebarIcon name="overview" />
            <span className="navLabel">Overview</span>
          </button>
          <button className={activePage === "console" ? "active" : ""} onClick={() => openSidebarPage("console")} onDoubleClick={() => resetActiveSidebarPage("console")} disabled={isProvisioning || !activeServer} title={isProvisioning || !activeServer ? serverPageDisabledReason : "Open console"}>
            <SidebarIcon name="console" />
            <span className="navLabel">Console</span>
          </button>
          <button className={activePage === "files" ? "active" : ""} onClick={() => openSidebarPage("files")} onDoubleClick={() => resetActiveSidebarPage("files")} disabled={isProvisioning || !activeServer} title={isProvisioning || !activeServer ? serverPageDisabledReason : "Open files"}>
            <SidebarIcon name="files" />
            <span className="navLabel">Files</span>
          </button>
          <button className={activePage === "mods" ? "active" : ""} onClick={() => openSidebarPage("mods")} onDoubleClick={() => resetActiveSidebarPage("mods")} disabled={isProvisioning || !activeServer} title={isProvisioning || !activeServer ? serverPageDisabledReason : "Open mods"}>
            <SidebarIcon name="mods" />
            <span className="navLabel">Mods</span>
          </button>
          <button className={activePage === "schedule" ? "active" : ""} onClick={() => openSidebarPage("schedule")} onDoubleClick={() => resetActiveSidebarPage("schedule")} disabled={isProvisioning || !activeServer} title={isProvisioning || !activeServer ? serverPageDisabledReason : "Open schedules"}>
            <SidebarIcon name="schedule" />
            <span className="navLabel">Schedules</span>
          </button>
          <button className={activePage === "properties" ? "active" : ""} onClick={() => openSidebarPage("properties")} onDoubleClick={() => resetActiveSidebarPage("properties")} disabled={isProvisioning || !activeServer} title={isProvisioning || !activeServer ? serverPageDisabledReason : "Open properties"}>
            <SidebarIcon name="properties" />
            <span className="navLabel">Properties</span>
          </button>
        </nav>
        <nav className="sideNav sideNavBottom">
          <button className={activePage === "settings" ? "active" : ""} onClick={() => openSidebarPage("settings")} onDoubleClick={() => resetActiveSidebarPage("settings")} disabled={isProvisioning} title={isProvisioning ? provisioningNavigationReason : "Open settings"}>
            <SidebarIcon name="settings" />
            <span className="navLabel settingsNavLabel">
              <span>Settings</span>
              <span className="settingsVersionText">v{panelVersion}</span>
            </span>
          </button>
          <div className="accountChip">
            <span className="accountIcon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21a8 8 0 0 1 16 0" />
              </svg>
            </span>
            <span className="accountName">{demoMode ? "Demo" : authSession.user?.username}</span>
            <Button variant="ghost" iconOnly className="accountLogoutButton" onClick={logout} disabled={isProvisioning} aria-label={demoMode ? "Exit demo" : "Log out"} title={isProvisioning ? provisioningNavigationReason : demoMode ? "Exit demo" : "Log out"}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M10 5H5v14h5" />
                <path d="M14 8l4 4-4 4" />
                <path d="M8 12h10" />
              </svg>
            </Button>
          </div>
        </nav>
      </aside>

      <section className="workspace">
        <header className="workspaceHeader">
          <div>
            <h2>{currentPageTitle}</h2>
          </div>
          <div className="workspaceActions">
            {activePage === "servers" && <Button onClick={() => openCreateServerForNode()} disabled={demoMode || isProvisioning || serverCreationBlocked || !canCreateServers} title={demoMode || isProvisioning || serverCreationBlocked || !canCreateServers ? createServerDisabledReason : "Create a managed server"}>New managed server</Button>}
            {activePage === "create" && <Button variant="secondary" onClick={() => setActivePage("servers")} disabled={isProvisioning} title={isProvisioning ? provisioningNavigationReason : "Cancel server creation"}>Cancel</Button>}
          </div>
        </header>

        {appStateLoaded && !panelOnlyMode && !effectiveAppState.dockerSocketMounted && (activeNode.isInternal || usableContextNodes.length === 0) && (
          <section className="systemBanner error">
            <strong>Docker integration is not connected.</strong>
            <span>Local server controls are paused. Connect Docker in Settings, or add a remote node that is online and ready.</span>
          </section>
        )}

        {provisioningError && activePage === "overview" && (
          <section className="systemBanner error" role="alert">
            <strong>Server setup failed.</strong>
            <span>{provisioningError} Review the form values, then try creating the server again.</span>
            {provisioningErrorDetails && (
              <details className="failureDetails">
                <summary>Show full API failure log</summary>
                <pre>{provisioningErrorDetails}</pre>
              </details>
            )}
          </section>
        )}

        {notice && <div className="notice">{notice}</div>}

        {isServerWorkspacePage(activePage) && activeServer && activeNodeRuntimeBlocked && (
          <section className="systemBanner error" role="alert">
            <strong>{activeNodeBlockReason || "Node unavailable"}</strong>
            <span>{activeNodeBlockMessage}</span>
          </section>
        )}

        {!appStateLoaded && (authSession.authenticated || demoMode) && !appLoadError && (
          <InlineState
            tone="loading"
            title="Loading application"
            message="Loading servers, settings, and runtime availability."
          />
        )}

        {appLoadError && (
          <InlineState
            tone="error"
            title="Could not load application state"
            message={`${appLoadError} Check that the serverSENTINEL backend is reachable, then try again.`}
            actionLabel="Retry"
            onAction={() => void refreshApp()}
            busy={appRefreshing}
          />
        )}

        {activePage === "servers" && applicationReady && (
          <section className="pageStack">
            {effectiveAppState.servers.length > 0 ? (
              <section className="serverList">
                {effectiveAppState.servers.map((server) => {
                  const lockedByDemo = demoMode && server.id !== demoServerId;
                  const minecraftVersion = versionValue(minecraftVersionInfo(server));
                  return (
                    <button
                      key={server.id}
                      className={`serverListItem ${server.id === activeServer?.id ? "active" : ""}`}
                      disabled={isProvisioning || lockedByDemo}
                      onClick={() => {
                        if (lockedByDemo) {
                          notify("info", "Demo mode is enabled. Exit demo mode to access this server.");
                          return;
                        }
                        setActiveServerId(server.id);
                        setActivePage("overview");
                      }}
                    >
                      <span className="serverListTitleRow">
                        <strong>{server.displayName}</strong>
                      </span>
                      <span>{minecraftVersion === "Unknown" ? "Version unknown" : minecraftVersion} - Fabric</span>
                      {lockedByDemo && <small>Demo mode is enabled. Disable it in settings to access this server.</small>}
                    </button>
                  );
                })}
              </section>
            ) : (
              renderNoManagedServersEmptyState("No managed servers yet")
            )}
          </section>
        )}

        {activePage === "create" && (
          <section className="createServerPanel">
            {currentProvisionOperation && (currentProvisionOperation.status === "queued" || currentProvisionOperation.status === "running") && (
              <InlineState
                tone="loading"
                title="Creating server"
                message={`${currentProvisionOperation.task || "Server setup is running."} Progress: ${Math.round(currentProvisionOperation.progress)}%.`}
              />
            )}
            {provisioningError && (
              <section className="inlineState inlineState-error" role="alert">
                <div className="inlineStateText">
                  <strong>Server setup failed</strong>
                  <span>{provisioningError} Review the details below, adjust the form if needed, then try again.</span>
                  {provisioningErrorDetails && (
                    <details className="failureDetails">
                      <summary>Show full API failure log</summary>
                      <pre>{provisioningErrorDetails}</pre>
                    </details>
                  )}
                </div>
                <Button variant="secondary" compact onClick={() => {
                  setProvisioningError("");
                  setProvisioningErrorDetails("");
                }}>Clear error</Button>
              </section>
            )}
            <ManagedServerForm
              nodes={contextNodes}
              preferredNodeId={preferredCreateNodeId}
              versions={fabricVersions}
              totalMemory={effectiveAppState.totalMemory}
              provisioning={isProvisioning || !canCreateServers}
              disabledReason={isProvisioning ? provisioningNavigationReason : !canCreateServers ? "Create servers permission is required." : ""}
              onRefreshNodes={refreshNodes}
              onSubmit={createServer}
            />
          </section>
        )}

        {activePage === "settings" && (
          <section className="settingsList">
            <section className="panel settingsGroup">
              <div className="settingsGroupHeader">
                <span>01</span>
                <div>
                  <h2>Interface</h2>
                </div>
              </div>
              <label className="settingsRow">
                <div>
                  <strong>Theme</strong>
                  <span>Choose the panel color mode.</span>
                </div>
                <select value={themePreference} onChange={(event) => setThemePreference(event.target.value as ThemePreference)}>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                  <option value="system">System</option>
                </select>
              </label>
              <label className="settingsRow">
                <div>
                  <strong>Date format</strong>
                  <span>Control how dates and times are displayed.</span>
                </div>
                <select value={dateLocalePreference} onChange={(event) => setDateLocalePreference(event.target.value as LocalePreference)}>
                  <option value="user">Use browser default</option>
                  <option value="en-US">English (US)</option>
                  <option value="en-GB">English (UK)</option>
                  <option value="de-DE">Deutsch (Deutschland)</option>
                  <option value="fr-FR">Français (France)</option>
                  <option value="ja-JP">日本語 (日本)</option>
                </select>
              </label>
              <label className="settingsRow">
                <div>
                  <strong>Number format</strong>
                  <span>Control numeric formatting across metrics.</span>
                </div>
                <select value={numberLocalePreference} onChange={(event) => setNumberLocalePreference(event.target.value as LocalePreference)}>
                  <option value="user">Use browser default</option>
                  <option value="en-US">English (US)</option>
                  <option value="en-GB">English (UK)</option>
                  <option value="de-DE">Deutsch (Deutschland)</option>
                  <option value="fr-FR">Français (France)</option>
                  <option value="ja-JP">日本語 (日本)</option>
                </select>
              </label>
              <div className="settingsRow readOnly">
                <div>
                  <strong>Version</strong>
                  <span>Current serverSENTINEL panel build.</span>
                </div>
                <StatusBadge className="settingsStatus">v{panelVersion}</StatusBadge>
              </div>
              {demoMode && (
                <div className="settingsRow">
                <div>
                  <strong>Demo mode</strong>
                  <span>Leave the sample workspace and return to sign-in.</span>
                </div>
                <Button variant="secondary" onClick={logout} disabled={isProvisioning}>Exit demo mode</Button>
                </div>
              )}
            </section>

            <section className="panel settingsGroup">
              <div className="settingsGroupHeader">
                <span>02</span>
                <div>
                  <h2>Integrations</h2>
                </div>
              </div>
              <div className="settingsRow">
                <div>
                  <strong>Modrinth API key</strong>
                  <span>Enable mod search, compatibility checks, and installs.</span>
                </div>
                <ModrinthKeyForm onSubmit={updateModrinthKey} configured={appState.modrinthApiConfigured} disabled={!canManageIntegrations} />
              </div>
            </section>

            {canAdmin && (
              <section className="panel settingsGroup">
                <div className="settingsGroupHeader usersGroupHeader">
                  <span>03</span>
                  <div>
                    <h2>Users</h2>
                    <p>Manage panel accounts and permissions.</p>
                  </div>
                  <Button onClick={() => setUserModal("create")} disabled={userSaving || !canManageUsers} title={!canManageUsers ? "Manage users permission is required" : "Create user"}>New user</Button>
                </div>
                {usersLoading && (
                  <InlineState tone="loading" title="Loading users" message="Loading user accounts and access settings." />
                )}
                {usersError && (
                  <InlineState
                    tone="error"
                    title="Could not load users"
                    message={`${usersError} Check that your account can manage users, then try again.`}
                    actionLabel="Retry"
                    onAction={() => void loadUsers()}
                    busy={usersLoading}
                  />
                )}
                <UserManagement
                  users={users}
                  currentUserId={authSession.user?.id}
                  editingUser={userModal}
                  busy={userSaving}
                  canManageUsers={canManageUsers}
                  onOpenEdit={(user) => setUserModal(user)}
                  onCloseModal={() => setUserModal(null)}
                  onCreate={createUser}
                  onUpdate={updateUser}
                  onResetPassword={resetUserPassword}
                  onDelete={deleteUser}
                />
              </section>
            )}

            <section className={`panel settingsGroup ${panelOnlyMode ? "panelModeDisabled" : ""}`}>
              <div className="settingsGroupHeader">
                <span>{canAdmin ? "04" : "03"}</span>
                <div>
                  <h2>Container</h2>
                  {panelOnlyMode && <p className="panelModeWarning">Panel mode does not support local Docker socket connection.</p>}
                </div>
              </div>
              <div className="settingsRow readOnly">
                <div>
                  <strong>Docker socket</strong>
                  <span>Local container control availability.</span>
                </div>
                <StatusBadge className={`settingsStatus ${panelOnlyMode ? "" : (effectiveAppState.dockerSocketMounted ? "ready" : "limited")}`}>
                  {panelOnlyMode ? "Unsupported" : (demoMode ? "Demo override" : effectiveAppState.dockerSocketMounted ? "Connected" : "Not mounted")}
                </StatusBadge>
              </div>
            </section>
          </section>
        )}

        {activePage === "nodes" && (
          <NodesPage
            nodes={contextNodes}
            panelVersion={panelVersion}
            panelBuildId={panelBuildId}
            canManageNodes={canManageUsers}
            busy={Boolean(nodeBusyId)}
            busyNodeId={nodeBusyId}
            defaultPanelUrl={currentPanelUrl()}
            selectedNode={nodeDetails ? contextNodes.find((node) => node.id === nodeDetails.id) ?? nodeDetails : null}
            nodeUpdatingSince={nodeUpdatingSince}
            nodeUpdateNow={nodeUpdateNow}
            nodeUpdateGraceMs={nodeUpdateGraceMs}
            installResult={nodeInstallResult}
            addNodeOpen={addNodeOpen}
            addNodeResult={addNodeResult}
            installMethod={nodeInstallMethod}
            onInstallMethodChange={setNodeInstallMethod}
            onOpenAddNode={() => {
              setAddNodeResult(null);
              setNodeInstallMethod("run");
              setAddNodeOpen(true);
            }}
            onCloseAddNode={() => {
              setAddNodeOpen(false);
              setAddNodeResult(null);
            }}
            onDoneAddNode={() => {
              setAddNodeOpen(false);
              setAddNodeResult(null);
              void refreshApp();
            }}
            onCreateNode={createNode}
            onRefresh={() => void refreshNodes()}
            onViewDetails={viewNodeDetails}
            onShowInstall={showNodeInstall}
            onRotateToken={rotateNodeToken}
            onUpdateNode={updateNodeImage}
            onRestartNode={restartNode}
            onRemoveNode={removeNode}
            onCloseDetails={() => setNodeDetails(null)}
            onSelectServer={openServerFromNode}
            onAddServer={openCreateServerForNode}
            onClearInstall={() => setNodeInstallResult(null)}
            onCopy={(text) => void copyText(text)}
            serverStateLabel={nodeServerStateLabel}
            serverActivities={serverActivities}
            formatDate={formatDisplayDate}
          />
        )}

        {applicationReady && isServerWorkspacePage(activePage) && !activeServer && effectiveAppState.servers.length === 0 && (
          renderNoManagedServersEmptyState("Welcome to serverSENTINEL")
        )}

        {applicationReady && isServerWorkspacePage(activePage) && !activeServer && effectiveAppState.servers.length > 0 && (
          <EmptyState
            title="No server selected"
            message="A server exists, but none is open right now. Choose one from the Servers page to view its console, files, mods, and settings."
            action={<Button onClick={() => setActivePage("servers")}>Open servers</Button>}
          />
        )}

        {isServerWorkspacePage(activePage) && activeServer && (
          <>
            <div className="activeServerStrip">
              <div className="serverStripLeft">
                <div className="serverStripIcon">
                  <svg className="server-icon-cube" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                    <line x1="12" y1="22.08" x2="12" y2="12" />
                  </svg>
                </div>
                <div className="serverStripInfo">
                  <div className="serverStripTitleRow">
                    <span className={`serverCommandStatusDot ${serverCommandTone}`} aria-hidden="true" />
                    <strong>{activeServer.displayName}</strong>
                    <StatusBadge className={`runtimeBadge ${serverCommandTone}`}>
                      {serverCommandStatusLabel}
                    </StatusBadge>
                  </div>
                  <div className="serverStripMetaRow">
                    <small className="serverStripMeta">
                      {activeNode.name}
                    </small>
                    <span aria-hidden="true" className="serverStripSeparator">·</span>
                    <small className="serverStripMeta">
                      Fabric {activeServer.runtimeProfile.loaderVersion || "unknown"}
                    </small>
                    <span aria-hidden="true" className="serverStripSeparator">·</span>
                    <small className="serverStripMeta">
                      MC {activeMinecraftVersion === "Unknown" ? "unknown" : activeMinecraftVersion}
                    </small>
                  </div>
                </div>
              </div>
              <div className="serverStripRight">
                <RuntimeControls
                  status={activeStatus}
                  controlAvailableFallback={activeServerDockerSocketMounted && activeServer.hasDockerContainer}
                  isProvisioning={isProvisioning || !canBasic || dockerOperationalLock}
                  disabledReason={runtimeControlsDisabledReason}
                  busyAction={runtimeAction}
                  onAction={runContainerAction}
                  className="runtimeControlsCompact"
                />
                <Button
                  variant="secondary"
                  className={`quickActionButton consoleLink ${activePage === "console" ? "active" : ""}`}
                  onClick={() => setActivePage("console")}
                  title="Open console"
                >
                  <svg className="buttonIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="4 17 10 11 4 5" />
                    <line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                  <span>Console</span>
                </Button>
                <div className="overflowMenuContainer">
                  <Button
                    variant="secondary"
                    iconOnly
                    className="iconButton overflowButton"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOverflowOpen((prev) => !prev);
                    }}
                    title="More actions"
                    aria-label="More actions"
                  >
                    <svg className="buttonIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                      <circle cx="12" cy="5" r="1.5" fill="currentColor" />
                      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                      <circle cx="12" cy="19" r="1.5" fill="currentColor" />
                    </svg>
                  </Button>
                  {overflowOpen && (
                    <div className="overflowDropdown" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        compact
                        onClick={() => {
                          refreshStatus();
                          setOverflowOpen(false);
                        }}
                        disabled={isProvisioning}
                        title={isProvisioning ? provisioningNavigationReason : "Refresh server status"}
                      >
                        Refresh status
                      </Button>
                      <Button
                        variant="ghost"
                        compact
                        onClick={() => {
                          downloadConsoleLogs();
                          setOverflowOpen(false);
                        }}
                        disabled={logs.length === 0}
                        title={logs.length === 0 ? "No console log lines are available to download." : "Download console log"}
                      >
                        Download log
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {statusError && (
              <InlineState
                tone="warning"
                title="Status is not up to date"
                message={`${statusError} The last known server information is still shown.`}
                actionLabel="Refresh status"
                onAction={() => void refreshStatus()}
              />
            )}

            {activePage === "overview" && (
              <section className="tabPage overviewPage">
                {overviewError && (
                  <InlineState
                    tone="warning"
                    title="Overview is not up to date"
                    message={`${overviewError} Previously loaded activity is still shown when available.`}
                    actionLabel="Retry"
                    onAction={() => {
                      void refreshOverviewData(activeServer.id, { showLoading: true });
                    }}
                    busy={overviewLoading}
                  />
                )}
                <OverviewSummary
                  server={activeServer}
                  status={activeStatus}
                  dockerSocketMounted={activeServerDockerSocketMounted}
                  activity={overviewData.activity}
                />

                <ResourcePanel
                  server={activeServer}
                  samples={resourceSamples}
                  status={activeStatus}
                  dockerSocketMounted={activeServerDockerSocketMounted}
                  formatNumber={formatDisplayNumber}
                  formatTime={formatDisplayTime}
                />

                <ActivityHealthPanel activity={overviewData.activity} formatDate={formatDisplayDate} />
                <RecentEventsPanel events={overviewData.events} eventsStatus={overviewData.eventsStatus} formatDate={formatDisplayDate} onOpenConsole={() => setActivePage("console")} />

              </section>
            )}

            {activePage === "console" && (
              <section className="tabPage">
                <section className="panel consolePanel">
                  <PanelHeader
                    title="Console"
                    actions={<div className="consoleHeaderActions">
                      <Button variant="secondary" compact onClick={downloadConsoleLogs} disabled={logs.length === 0} title={logs.length === 0 ? "No console log lines are available to download." : "Download console log"}>
                        Download log
                      </Button>
                    </div>}
                  />
                  {consoleLoading && (
                    <InlineState tone="loading" title="Loading console" message="Loading recent server log output." />
                  )}
                  {consoleError && (
                    <InlineState
                      tone="warning"
                      title="Console output is not up to date"
                      message={`${consoleError} Existing log lines remain visible when available.`}
                      actionLabel="Retry"
                      onAction={() => void refreshConsoleLogs(activeServer.id)}
                      busy={consoleLoading}
                    />
                  )}
                  <div className="terminal">
                    <Suspense fallback={<InlineState tone="loading" title="Preparing terminal" message="Loading the interactive console." />}>
                      <MinecraftTerminal
                        entries={logs}
                        canSendCommands={canSendConsoleCommands}
                        disabledReason={consoleCommandDisabledReason}
                        commandHistory={commandHistory}
                        onCommand={(command) => {
                          void sendCommand(command);
                        }}
                      />
                    </Suspense>
                  </div>
                </section>
              </section>
            )}

            {activePage === "files" && (
              <FilesPage
                workspace={filesWorkspace}
                activeServerIsDemo={activeServerIsDemo}
                permissionUser={permissionUser}
                isProvisioning={isProvisioning}
                dockerOperationalLock={dockerOperationalLock}
                serverRequiresStoppedForMutableConfig={serverRequiresStoppedForMutableConfig}
                stoppedServerMutationMessage={stoppedServerMutationMessage}
                dateTimeFormatter={dateTimeFormatter}
              />
            )}

            {activePage === "mods" && (
              <ModsPage
                workspace={modsWorkspace}
                serverContext={{
                  minecraftVersion: activeServer.runtimeProfile.minecraftVersion || "Unknown",
                  versionsUnknown: activeModVersionsUnknown,
                  contextMessage: activeModContext
                }}
                access={{
                  changesAllowed: !modsLocked,
                  locked: modsLocked,
                  reviewAcknowledgementLocked: modReviewAcknowledgementLocked,
                  toggleLocked: modToggleLocked,
                  modrinthConfigured: effectiveAppState.modrinthApiConfigured,
                  addDisabled: addModFromModrinthDisabled,
                  addDisabledReason: addModFromModrinthDisabledReason,
                  uploadDisabled: uploadModDisabled,
                  uploadDisabledReason: uploadModDisabledReason
                }}
                formatters={{ date: formatDisplayDate, number: formatDisplayNumber }}
              />
            )}

            {activePage === "schedule" && (
              <SchedulePage
                schedules={activeServer.schedules ?? []}
                formatDate={formatDisplayDate}
                onCreate={createSchedule}
                onToggle={(schedule) => updateSchedule(schedule, { enabled: !schedule.enabled })}
                onUpdate={updateSchedule}
                onDelete={deleteSchedule}
                disabled={scheduleBusy || isProvisioning || !canManageSchedules || dockerOperationalLock}
                disabledReason={scheduleDisabledReason}
              />
            )}

            {activePage === "properties" && (
              <section className="tabPage settingsPage">
                <ServerEditForm
                  server={activeServer}
                  versions={fabricVersions}
                  totalMemory={activeNode.totalMemory || effectiveAppState.totalMemory}
                  onSubmit={updateServer}
                  disabled={serverSettingsLocked || serverSettingsSaving}
                  disabledReason={serverSettingsLockedReason}
                  dangerZone={
                    <DeleteServerPanel
                      server={activeServer}
                      onSubmit={deleteServer}
                      disabled={deleteServerLocked || serverSettingsSaving}
                    />
                  }
                />
              </section>
            )}

          </>
        )}
      </section>
      </main>
    </>
  );
}
