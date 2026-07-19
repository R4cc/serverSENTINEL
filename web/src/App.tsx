import { FormEvent, Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { serverRuntimeDefinition } from "@serversentinel/contracts";
import { Toaster, toast } from "sonner";
import { ApiError, api } from "./api";
import { demoOverviewData, demoPlayerSnapshot, demoServer, demoServerId, demoStats, demoStatsHistory, demoStatus, demoTimelineData } from "./demo";
import type { ActivePage, AppState, AuthSession, ContextNode, CreateNodeResponse, FabricVersions, ManagedNode, ManagedServer, NodeInstallResponse, NodeManualRecovery, NodeOperation, NodeUpdateResponse, OperationRecord, PlayerSnapshot, PlayerSnapshotsResponse, ResourceSample, ResourceStatsHistory, ScheduleNavigationTarget, ServerOverviewData, ServerStatus, ServerTimelineResourcePoint, ServerTimelineResponse, GeneralJob } from "./types";
import { detectedBrowserTimeZone, formatTimestampForFilename, minecraftVersionInfo, resolveDisplayTimeZone, resourceHistorySampleLimit, resourcePollMs, runtimeTone, versionValue } from "./utils/format";
import { hasPermission } from "./utils/permissions";
import { trimFormValue, validatePassword, validateUsername } from "./utils/validation";
import { advanceNodeOperation, isNodeRuntimeUsable, nodeRestartImpactMessage } from "./utils/nodes";
import { appVersion, defaultNodeDataPath, emptyApp, isServerWorkspacePage, shouldShowApplicationLoadingSkeleton, shouldShowInitialOverviewLoading, writeStoredDemoMode } from "./app/appConfig";
import { usePreferencesState } from "./app/appState";
import { useServerContext } from "./app/serverContext";
import { errorMessage, hasPotentialEvent, readCommandHistory, serverConfigValidation, setValidationNotice } from "./utils/appHelpers";
import { appendCommandHistory } from "./utils/minecraftTerminal";
import { appendConsoleEntries, consoleReconnectDelay, consoleSnapshotLines, consoleUnavailableIsRetryable, isNodeOfflineConsoleMessage, reconcileConsoleSnapshot, type ConsoleConnectionState } from "./utils/consolePipeline";
import { AuthPanel } from "./components/AuthPanel";
import { BrandLogo } from "./components/BrandLogo";
import { SidebarIcon, SidebarToggleIcon } from "./components/FileTypeIcon";
import { InlineState } from "./components/InlineState";
import { ActiveServerStripLoadingSkeleton, ApplicationLoadingSkeleton, AuthLoadingSkeleton, FeaturePageLoadingSkeleton, ResourcePanelLoadingSkeleton, TerminalLoadingSkeleton } from "./components/LoadingSkeletons";
import { RuntimeControls } from "./components/RuntimeControls";
import { RestartRequiredBadge } from "./components/RestartRequiredBadge";
import { ServerRuntimeAlert } from "./components/ServerRuntimeAlert";
import { Button, EmptyState, PanelHeader, StatusBadge } from "./components/UiPrimitives";
import { ConfirmationModal, useConfirmationController } from "./components/ConfirmationModal";
import { ActionMenu } from "./components/ActionMenu";
import { useMobileViewport, useWideTimelineViewport } from "./components/useMobileViewport";
import { ActivePlayersPanel, ModHealthPanel, OverviewSummary, RecentEventsPanel, SchedulePanel } from "./pages/OverviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { clearStoredCommandHistory, persistCommandHistory, readConsoleHistoryEnabled } from "./features/settings/settingsPreferences";
import { resolvedThemeClassName, resolveDarkTheme } from "./features/settings/themePreferences";
import { useModsWorkspace } from "./features/mods/useModsWorkspace";
import { managedContentTerminology } from "./features/mods/contentTerminology";
import { readStoredFileLocation } from "./features/files/fileLocationStorage";
import { useFilesWorkspace } from "./features/files/useFilesWorkspace";
import { useUsersWorkspace } from "./features/users/useUsersWorkspace";
import { useSchedulesWorkspace } from "./features/schedules/useSchedulesWorkspace";

const loadMinecraftTerminal = () => import("./components/MinecraftTerminal");
const loadResourcePanel = () => import("./components/ResourcePanel");
const loadServerTimeline = () => import("./components/ServerTimeline");
const loadSchedulePage = () => import("./pages/SchedulesPage");
const loadNodesPage = () => import("./pages/NodesPage");
const loadServerCreatePage = () => import("./pages/ServerCreatePage");
const loadServerEditPage = () => import("./pages/ServerEditPage");
const loadModsPage = () => import("./pages/ModsPage");
const loadFilesPage = () => import("./features/files/FilesPage");

const MinecraftTerminal = lazy(() => loadMinecraftTerminal().then((module) => ({ default: module.MinecraftTerminal })));
const ResourcePanel = lazy(() => loadResourcePanel().then((module) => ({ default: module.ResourcePanel })));
const ServerTimeline = lazy(() => loadServerTimeline().then((module) => ({ default: module.ServerTimeline })));
const SchedulePage = lazy(() => loadSchedulePage().then((module) => ({ default: module.SchedulePage })));
const NodesPage = lazy(() => loadNodesPage().then((module) => ({ default: module.NodesPage })));
const ManagedServerForm = lazy(() => loadServerCreatePage().then((module) => ({ default: module.ManagedServerForm })));
const ServerEditForm = lazy(() => loadServerEditPage().then((module) => ({ default: module.ServerEditForm })));
const DeleteServerPanel = lazy(() => loadServerEditPage().then((module) => ({ default: module.DeleteServerPanel })));
const ModsPage = lazy(() => loadModsPage().then((module) => ({ default: module.ModsPage })));
const FilesPage = lazy(() => loadFilesPage().then((module) => ({ default: module.FilesPage })));

function preloadActivePage(page: ActivePage) {
  if (page === "console") return loadMinecraftTerminal();
  if (page === "overview") return loadResourcePanel();
  if (page === "files") return loadFilesPage();
  if (page === "mods") return loadModsPage();
  if (page === "schedule") return loadSchedulePage();
  if (page === "nodes") return loadNodesPage();
  if (page === "create") return loadServerCreatePage();
  if (page === "properties") return loadServerEditPage();
  return Promise.resolve();
}

function consoleLine(text: string) {
  return `${text}\n`;
}

const provisionJobPollMs = 1_500;
const serverStatusPollMs = 10_000;
const nodeOfflineNoticeDelayMs = 3_000;
const stoppedServerMutationMessage = "Stop the server before changing mods, plugins, or server properties.";
const nodeUpdateGraceMs = 5 * 60 * 1000;
const activePageStorageKey = "serversentinel-active-page";
const activePages = new Set<ActivePage>(["servers", "settings", "nodes", "create", "overview", "console", "files", "mods", "schedule", "properties"]);
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
  const { options: confirmationOptions, requestConfirmation, settle: settleConfirmation } = useConfirmationController();
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [authNotice, setAuthNotice] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [appState, setAppState] = useState<AppState>(emptyApp);
  const [activeServerId, setActiveServerId] = useState("");
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [appStateLoaded, setAppStateLoaded] = useState(false);
  const [appLoadError, setAppLoadError] = useState("");
  const [appRefreshing, setAppRefreshing] = useState(false);
  const [resourceSamples, setResourceSamples] = useState<ResourceSample[]>([]);
  const [timelineLatestSample, setTimelineLatestSample] = useState<ServerTimelineResourcePoint>();
  const [overviewData, setOverviewData] = useState<ServerOverviewData>({ events: [], activity: {} });
  const [playerSnapshots, setPlayerSnapshots] = useState<Record<string, PlayerSnapshot>>({});
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [consoleLoading, setConsoleLoading] = useState(false);
  const [consoleError, setConsoleError] = useState("");
  const [consoleConnectionState, setConsoleConnectionState] = useState<ConsoleConnectionState>("connecting");
  const [nodeOfflineNoticeVisible, setNodeOfflineNoticeVisible] = useState(false);
  const [commandSending, setCommandSending] = useState(false);
  const [commandHistory, setCommandHistory] = useState<string[]>(() => readCommandHistory(readConsoleHistoryEnabled()));
  const [fabricVersions, setFabricVersions] = useState<FabricVersions>({ game: [], loader: [], installer: [] });
  const [notice, setNotice] = useState("");
  const [activeJobs, setActiveJobs] = useState<GeneralJob[]>([]);
  const [provisioningError, setProvisioningError] = useState("");
  const [provisioningErrorDetails, setProvisioningErrorDetails] = useState("");
  const [serverSettingsSaving, setServerSettingsSaving] = useState(false);
  const [consoleStreamVersion, setConsoleStreamVersion] = useState(0);
  const [runtimeAction, setRuntimeAction] = useState<"start" | "stop" | "restart" | null>(null);
  const [runtimeFeedbackAction, setRuntimeFeedbackAction] = useState<"start" | "restart" | null>(null);
  const [activePage, setActivePage] = useState<ActivePage>(() => readStoredActivePage());
  const [scheduleNavigationTarget, setScheduleNavigationTarget] = useState<ScheduleNavigationTarget | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.matchMedia("(max-width: 1100px)").matches);
  const phoneLayout = useMobileViewport();
  const wideTimelineLayout = useWideTimelineViewport();
  const sidebarToggleRef = useRef<HTMLButtonElement | null>(null);
  const [nodeBusyId, setNodeBusyId] = useState("");
  const [nodeDetails, setNodeDetails] = useState<ManagedNode | null>(null);
  const [nodeOperations, setNodeOperations] = useState<Record<string, NodeOperation>>({});
  const [nodeOperationNow, setNodeOperationNow] = useState(() => Date.now());
  const [nodeManualRecoveryById, setNodeManualRecoveryById] = useState<Record<string, NodeManualRecovery>>({});
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
    displayTimeZonePreference,
    setDisplayTimeZonePreference,
    relativeTimestamps,
    setRelativeTimestamps,
    rememberConsoleHistory,
    setRememberConsoleHistory,
    consoleFontSize,
    setConsoleFontSize,
    consoleScrollback,
    setConsoleScrollback,
    demoRunning,
    setDemoRunning,
    demoFiles,
    setDemoFiles,
    demoInstalledMods,
    setDemoInstalledMods,
    demoSchedules,
    setDemoSchedules,
    resetDemoState,
    systemDark
  } = usePreferencesState();
  const consoleLogServerIdRef = useRef("");
  const logsRef = useRef<string[]>([]);
  const consoleScrollbackRef = useRef(consoleScrollback);
  const fileWorkspaceServerIdRef = useRef("");
  const refreshModsAfterFileMutationRef = useRef<() => Promise<unknown> | unknown>(() => undefined);
  const activeServerIdRef = useRef("");
  const panelFirstRunPromptedRef = useRef(false);
  const provisionSubmitLockRef = useRef(false);
  const appRefreshInFlightRef = useRef(false);
  const statusRefreshInFlightRef = useRef<Set<string>>(new Set());
  const nodeRefreshInFlightRef = useRef(false);
  const consoleReconnectTimeoutRef = useRef<number | null>(null);
  const consoleReconnectNoticeTimeoutRef = useRef<number | null>(null);
  const consoleReconnectAttemptRef = useRef(0);
  const consoleCommandRefreshTimeoutRef = useRef<number | null>(null);
  const runtimeFeedbackTimeoutRef = useRef<number | null>(null);

  const overviewRefreshTimeoutRef = useRef<number | null>(null);
  const activeJobToastIdsRef = useRef<Set<string>>(new Set());
  const staleSessionLogoutRef = useRef(false);
  const authSubmittingRef = useRef(false);
  const staleSessionSuppressUntilRef = useRef(0);

  useEffect(() => {
    setRuntimeFeedbackAction(null);
    if (runtimeFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(runtimeFeedbackTimeoutRef.current);
      runtimeFeedbackTimeoutRef.current = null;
    }
    return () => {
      if (runtimeFeedbackTimeoutRef.current !== null) {
        window.clearTimeout(runtimeFeedbackTimeoutRef.current);
      }
    };
  }, [activeServerId]);

  function showRuntimeFeedback(action: "start" | "stop" | "restart") {
    if (action === "stop") return;
    if (runtimeFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(runtimeFeedbackTimeoutRef.current);
    }
    setRuntimeFeedbackAction(action);
    runtimeFeedbackTimeoutRef.current = window.setTimeout(() => {
      setRuntimeFeedbackAction(null);
      runtimeFeedbackTimeoutRef.current = null;
    }, 900);
  }

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
      if (activeServerIdRef.current === serverId) {
        setOverviewData(data);
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
  }, [demoMode, demoRunning]);

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

  const darkMode = resolveDarkTheme(themePreference, systemDark);
  const themeClassName = resolvedThemeClassName(themePreference, systemDark);
  useEffect(() => {
    const root = document.documentElement;
    const classes = themeClassName.split(" ");
    root.classList.add(...classes);
    return () => root.classList.remove(...classes);
  }, [themeClassName]);
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
    activeRuntimeDefinition,
    activeModContext,
    activeModVersionsUnknown,
    activeStatus,
    activeNodeRuntimeBlocked,
    activeNodeBlockReason,
    activeNodeBlockMessage,
    activeServerUsesInternalNode,
    activeServerDockerSocketMounted
  } = useServerContext({ appState, activeServerId, status, demoMode, demoSchedules });
  const supportsManagedMods = activeRuntimeDefinition?.managedContent === true;
  const managedContent = managedContentTerminology(activeServer?.runtimeProfile.runtimeType ?? "fabric");
  const applicationReady = appStateLoaded || demoMode;
  const permissionUser = appState.currentUser ?? authSession?.user ?? null;
  const canBasic = activeServerIsDemo || hasPermission(permissionUser, "servers.control");
  const canExpanded = activeServerIsDemo || hasPermission(permissionUser, "console.command");
  const canEditServerSettings = activeServerIsDemo || hasPermission(permissionUser, "servers.editSettings");
  const canDeleteServers = activeServerIsDemo || hasPermission(permissionUser, "servers.delete");
  const canInstallMods = activeServerIsDemo || hasPermission(permissionUser, "mods.install");
  const canViewMods = activeServerIsDemo || hasPermission(permissionUser, "mods.view");
  const canManageMods = activeServerIsDemo || hasPermission(permissionUser, "mods.install") || hasPermission(permissionUser, "mods.upload") || hasPermission(permissionUser, "mods.enableDisable") || hasPermission(permissionUser, "mods.remove") || hasPermission(permissionUser, "mods.update");
  const canViewSchedules = activeServerIsDemo || hasPermission(permissionUser, "schedules.view");
  const canManageSchedules = activeServerIsDemo || hasPermission(permissionUser, "schedules.manage");
  const canCreateServers = !demoMode && hasPermission(permissionUser, "servers.create");
  const canManageIntegrations = !demoMode && hasPermission(permissionUser, "integrations.manage");
  const canViewUsers = !demoMode && hasPermission(permissionUser, "users.view");
  const canManageUsers = !demoMode && hasPermission(permissionUser, "users.manage");

  useEffect(() => {
    if (activePage === "mods" && activeServer && !supportsManagedMods) setActivePage("overview");
  }, [activePage, activeServer, supportsManagedMods]);
  const loadActiveTimeline = useCallback(async (from: number, to: number, maxPoints: number) => {
    if (!activeServer) throw new Error("Select a server to load its timeline");
    if (demoMode && activeServer.id === demoServerId) return demoTimelineData(demoRunning, demoSchedules, from, to);
    return api<ServerTimelineResponse>(`/api/servers/${activeServer.id}/timeline?from=${Math.round(from)}&to=${Math.round(to)}&maxPoints=${maxPoints}`);
  }, [activeServer?.id, demoMode, demoRunning, demoSchedules]);
  const authOperationalLock = !demoMode && !authSession?.authenticated;
  const nodeOfflineDetected = !activeServerIsDemo && (activeNode.status === "offline" || consoleConnectionState === "offline");
  const confirmedNodeOffline = nodeOfflineDetected && nodeOfflineNoticeVisible;
  const lifecycleTransitionRunning = activeStatus?.lifecycle.state === "stopping" || activeStatus?.lifecycle.state === "starting";
  const dockerOperationalLock = authOperationalLock || activeNodeRuntimeBlocked || nodeOfflineDetected || lifecycleTransitionRunning || (activeServerUsesInternalNode && !effectiveAppState.dockerSocketMounted);
  const serverCommandTone = runtimeTone(activeStatus, activeServerDockerSocketMounted);
  const lastKnownRuntimeLabel = serverCommandTone === "running"
    ? "Running"
    : serverCommandTone === "starting"
      ? "Starting"
      : serverCommandTone === "stopped" || serverCommandTone === "exited"
        ? "Offline"
        : "Unavailable";
  const activeNodeBlockDetail = activeNodeBlockReason && activeNodeBlockMessage.startsWith(`${activeNodeBlockReason}. `)
    ? activeNodeBlockMessage.slice(activeNodeBlockReason.length + 2)
    : activeNodeBlockMessage;
  const serverStripAlert = activeNodeRuntimeBlocked && activeNode.status !== "offline"
    ? {
        title: activeNodeBlockReason || "Node unavailable",
        message: activeNodeBlockDetail
      }
    : null;
  const serverStripHealth = serverStripAlert
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
  const runtimeControlsDisabledReason = authOperationalLock
    ? "Sign in before using runtime controls."
    : !canBasic
      ? "Servers control permission is required."
    : activeNodeRuntimeBlocked || nodeOfflineDetected
        ? activeNodeBlockMessage
          || `${activeNode.name} is offline. Runtime controls will return when it reconnects.`
        : activeServerUsesInternalNode && !effectiveAppState.dockerSocketMounted
          ? "Docker socket is not mounted. Runtime controls are unavailable for the internal node."
          : lifecycleTransitionRunning
            ? activeStatus?.lifecycle.message || "A server restart is already in progress."
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

  useEffect(() => {
    if (!nodeOfflineDetected) {
      setNodeOfflineNoticeVisible(false);
      return;
    }

    setNodeOfflineNoticeVisible(false);
    const timeout = window.setTimeout(() => {
      setNodeOfflineNoticeVisible(true);
    }, nodeOfflineNoticeDelayMs);
    return () => window.clearTimeout(timeout);
  }, [activeServer?.id, nodeOfflineDetected]);

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
  const settingsDataLoading = !appStateLoaded && !appLoadError;
  const usersWorkspace = useUsersWorkspace({
    activePage,
    authSession,
    demoMode,
    canViewUsers,
    canManageUsers,
    settingsDataLoading,
    notify,
    requestConfirmation,
    handleStaleSession,
    refreshAuth,
    logout
  });
  const modsLocked = isProvisioning || dockerOperationalLock || !canManageMods || !activeStatus || isAnyModJobRunning;
  const modReviewAcknowledgementLocked = isProvisioning || dockerOperationalLock || !canManageMods || !activeStatus || isAnyModJobRunning;
  const modToggleLocked = modsLocked;
  const addModFromModrinthDisabled = isProvisioning || dockerOperationalLock || !activeStatus || isAnyModJobRunning || !canInstallMods || !effectiveAppState.modrinthApiConfigured;
  const uploadModDisabled = modsLocked;
  const addModFromModrinthDisabledReason = isProvisioning
      ? "Server setup is still running."
      : dockerOperationalLock
        ? runtimeControlsDisabledReason || "Server runtime is unavailable."
        : !activeStatus
          ? "Server status is still loading."
          : isAnyModJobRunning
            ? `A ${managedContent.singular} operation is already running.`
            : !canInstallMods
              ? "Server management permission is required."
              : !effectiveAppState.modrinthApiConfigured
                ? `Add a Modrinth API key in Settings before searching for ${managedContent.plural}.`
                : `Search Modrinth for compatible ${managedContent.runtimeName} ${managedContent.plural}.`;
  const uploadModDisabledReason = isProvisioning
      ? "Server setup is still running."
      : dockerOperationalLock
        ? runtimeControlsDisabledReason || "Server runtime is unavailable."
        : !canManageMods
          ? "Server management permission is required."
          : !activeStatus
            ? "Server status is still loading."
            : isAnyModJobRunning
              ? `A ${managedContent.singular} operation is already running.`
              : `Upload a local ${managedContent.runtimeName} ${managedContent.singular} file.`;
  const resolvedDateLocale = dateLocalePreference === "user" ? undefined : dateLocalePreference;
  const resolvedNumberLocale = numberLocalePreference === "user" ? undefined : numberLocalePreference;
  const panelTimeZone = effectiveAppState.timeZone || "UTC";
  const browserTimeZone = useMemo(() => detectedBrowserTimeZone(), []);
  const displayTimeZone = resolveDisplayTimeZone(displayTimeZonePreference, panelTimeZone, browserTimeZone);
  const dateTimeFormatter = useMemo(() => new Intl.DateTimeFormat(resolvedDateLocale, { dateStyle: "medium", timeStyle: "short", timeZone: displayTimeZone }), [resolvedDateLocale, displayTimeZone]);
  const timeFormatter = useMemo(() => new Intl.DateTimeFormat(resolvedDateLocale, { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: displayTimeZone }), [resolvedDateLocale, displayTimeZone]);
  const shortTimeFormatter = useMemo(() => new Intl.DateTimeFormat(resolvedDateLocale, { hour: "2-digit", minute: "2-digit", timeZone: displayTimeZone }), [resolvedDateLocale, displayTimeZone]);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(resolvedNumberLocale), [resolvedNumberLocale]);

  function formatDisplayDate(value: string | number | Date) {
    return dateTimeFormatter.format(new Date(value));
  }

  function formatDisplayTime(value: string | number | Date) {
    return timeFormatter.format(new Date(value));
  }

  function formatDisplayShortTime(value: string | number | Date) {
    return shortTimeFormatter.format(new Date(value));
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
    activeServer: supportsManagedMods ? activeServer : undefined,
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
    canInstall: canInstallMods,
    modsLocked,
    toggleLocked: modToggleLocked,
    notify,
    setNotice,
    setActiveJobs,
    handleStaleSession,
    refreshFiles: filesWorkspace.actions.loadFiles,
    refreshServerState: () => refreshApp({ silent: true }),
    requestConfirmation
  });
  useEffect(() => {
    if (!activeServer || activePage !== "files" || demoMode || !authSession?.authenticated) return;
    void api<{ operations: OperationRecord[] }>(`/api/operations?serverId=${encodeURIComponent(activeServer.id)}&limit=25`)
      .then(({ operations }) => operations.filter((operation) => operation.type === "file.extract" && (operation.status === "queued" || operation.status === "running")).forEach(filesWorkspace.actions.resumeZipOperation))
      .catch(() => undefined);
  }, [activeServer?.id, activePage, authSession?.authenticated, demoMode]);
  useEffect(() => {
    refreshModsAfterFileMutationRef.current = () => modsWorkspace.actions.refresh(false);
  }, [modsWorkspace.actions]);
  const schedulesWorkspace = useSchedulesWorkspace({
    activeServer: activeServer ?? null,
    activeServerIsDemo,
    demoRunning,
    setDemoRunning,
    setDemoSchedules,
    setStatus,
    loading: !appStateLoaded && !appLoadError,
    error: appLoadError,
    isProvisioning,
    dockerOperationalLock,
    runtimeControlsDisabledReason,
    canManage: canManageSchedules,
    notify,
    setNotice,
    requestConfirmation,
    handleStaleSession,
    refreshApp: () => refreshApp()
  });
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
    if (!authSession?.authenticated) return;
    void preloadActivePage(activePage);
  }, [activePage, authSession?.authenticated]);

  useEffect(() => {
    return () => {
      if (consoleReconnectTimeoutRef.current !== null) {
        window.clearTimeout(consoleReconnectTimeoutRef.current);
      }
      if (consoleReconnectNoticeTimeoutRef.current !== null) {
        window.clearTimeout(consoleReconnectNoticeTimeoutRef.current);
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
    logsRef.current = logs;
  }, [logs]);

  useEffect(() => {
    consoleScrollbackRef.current = consoleScrollback;
    setLogs((current) => {
      const next = current.slice(-consoleScrollback);
      logsRef.current = next;
      return next;
    });
  }, [consoleScrollback]);

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
    if (activePage !== "nodes" && activePage !== "overview") return;
    if (demoMode) {
      setPlayerSnapshots((current) => ({
        ...current,
        [demoServerId]: demoPlayerSnapshot(demoRunning)
      }));
      return;
    }

    let cancelled = false;
    let inFlight = false;
    async function loadPlayerSnapshots() {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const data = await api<PlayerSnapshotsResponse>("/api/player-snapshots");
        if (cancelled) return;
        setPlayerSnapshots(data.snapshots);
      } catch (error) {
        if (handleStaleSession(error)) return;
      } finally {
        inFlight = false;
      }
    }

    void loadPlayerSnapshots();
    const interval = window.setInterval(() => void loadPlayerSnapshots(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activePage, demoMode, demoRunning]);

  useEffect(() => {
    const compactLayout = window.matchMedia("(max-width: 1100px)");
    const synchronizeSidebar = (event: MediaQueryListEvent) => setSidebarCollapsed(event.matches);
    compactLayout.addEventListener("change", synchronizeSidebar);
    return () => compactLayout.removeEventListener("change", synchronizeSidebar);
  }, []);

  useEffect(() => {
    if (!phoneLayout || sidebarCollapsed) return;
    const closeMobileNavigation = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      event.preventDefault();
      setSidebarCollapsed(true);
      window.requestAnimationFrame(() => sidebarToggleRef.current?.focus({ preventScroll: true }));
    };
    window.addEventListener("keydown", closeMobileNavigation);
    return () => window.removeEventListener("keydown", closeMobileNavigation);
  }, [phoneLayout, sidebarCollapsed]);

  const hasWaitingNodeOperation = Object.values(nodeOperations).some((operation) => operation.phase === "waiting");

  useEffect(() => {
    if (!hasWaitingNodeOperation) return;
    const interval = window.setInterval(() => setNodeOperationNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [hasWaitingNodeOperation]);

  useEffect(() => {
    if (Object.keys(nodeOperations).length === 0) return;
    const next = { ...nodeOperations };
    const completed: Array<{ node: ManagedNode; operation: NodeOperation }> = [];
    const mismatched: Array<{ node: ManagedNode; operation: NodeOperation }> = [];
    let changed = false;

    for (const [nodeId, operation] of Object.entries(nodeOperations)) {
      const node = contextNodes.find((candidate) => candidate.id === nodeId);
      const result = advanceNodeOperation(operation, node, nodeOperationNow, nodeUpdateGraceMs);
      if (result.outcome === "completed" || result.outcome === "mismatch") {
        delete next[nodeId];
        changed = true;
        if (node) (result.outcome === "completed" ? completed : mismatched).push({ node, operation });
        continue;
      }
      if (result.operation !== operation && result.operation) {
        next[nodeId] = result.operation;
        changed = true;
      }
    }

    if (changed) setNodeOperations(next);
    for (const { node, operation } of completed) {
      setNodeManualRecoveryById((current) => {
        if (!current[node.id]) return current;
        const updated = { ...current };
        delete updated[node.id];
        return updated;
      });
      notify("success", operation.kind === "update"
        ? `${node.name} updated${operation.targetVersion ? ` to ${operation.targetVersion}` : ""}.`
        : `${node.name} restarted and reconnected.`);
    }
    for (const { node, operation } of mismatched) {
      const expected = [operation.targetVersion, operation.targetBuildId?.slice(0, 12)].filter(Boolean).join(" build ");
      setNodeManualRecoveryById((current) => ({
        ...current,
        [node.id]: { message: `${node.name} reconnected but still reports its previous release${expected ? `. Expected ${expected}` : ""}. Refresh or retry the update.` }
      }));
      notify("warning", `${node.name} reconnected without the expected update.`);
    }
  }, [contextNodes, nodeOperationNow, nodeOperations]);

  useEffect(() => {
    if (!hasWaitingNodeOperation || demoMode) return;
    let inFlight = false;
    const interval = window.setInterval(() => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      void refreshApp({ silent: true }).finally(() => {
        inFlight = false;
      });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [hasWaitingNodeOperation, demoMode]);

  useEffect(() => {
    setNodeManualRecoveryById((current) => {
      const next = { ...current };
      let changed = false;
      for (const nodeId of Object.keys(current)) {
        const node = contextNodes.find((candidate) => candidate.id === nodeId);
        const targetCurrent = node?.status === "online"
          && node.agentVersion === panelVersion
          && (!panelBuildId || node.buildId === panelBuildId);
        if (targetCurrent) {
          delete next[nodeId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [contextNodes, panelBuildId, panelVersion]);

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
  }, [authSession?.authenticated, authSession?.user?.rolePreset, demoMode]);

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
    consoleLogServerIdRef.current = activeServer.id;
    if (serverChanged) {
      logsRef.current = [];
      setLogs([]);
      setStatusError("");
      setConsoleError("");
      setConsoleConnectionState("connecting");
      consoleReconnectAttemptRef.current = 0;
      if (consoleReconnectNoticeTimeoutRef.current !== null) {
        window.clearTimeout(consoleReconnectNoticeTimeoutRef.current);
        consoleReconnectNoticeTimeoutRef.current = null;
      }
      setOverviewData({ events: [], activity: {} });
      setResourceSamples([]);
    }
    if (demoMode && activeServer.id === demoServerId) {
      setStatus(demoStatus(activeServer, demoRunning));
      const demoLogs = [
        consoleLine("[demo] Starting minecraft server version 1.21.4"),
        consoleLine("[demo] Loading Fabric Loader 0.16.10"),
        consoleLine("[demo] Preparing spawn area: 100%"),
        consoleLine("[demo] Done (5.132s)! For help, type \"help\"")
      ];
      logsRef.current = demoLogs;
      setLogs(demoLogs);
      setConsoleConnectionState("live");
      return;
    }
    if (activeNodeRuntimeBlocked) {
      fileWorkspaceServerIdRef.current = "";
      filesWorkspace.actions.resetEditorState();
      setConsoleConnectionState(activeNode.status === "offline" ? "offline" : "error");
      setConsoleError(activeNodeBlockMessage);
      filesWorkspace.actions.setFilesError(activeNodeBlockMessage);
      setOverviewError(activeNodeBlockMessage);
      setOverviewLoading(false);
      filesWorkspace.actions.setFilesLoading(false);
      setConsoleLoading(false);
      filesWorkspace.actions.setListing({ path: "/", entries: [] });
      return;
    }
    void refreshStatus(activeServer.id);
    if (activePage !== "console") {
      setConsoleLoading(false);
      return;
    }
    void refreshConsoleLogs(activeServer.id);

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
    let reconnectScheduled = false;
    let allowReconnect = true;
    let pollingAvailable = false;
    let pollingInFlight = false;
    let pollingInterval: number | null = null;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/console?serverId=${encodeURIComponent(serverId)}`);

    function stopPolling() {
      pollingAvailable = false;
      if (pollingInterval !== null) {
        window.clearInterval(pollingInterval);
        pollingInterval = null;
      }
    }

    async function pollConsoleLogs() {
      if (pollingInFlight || document.hidden || activeServerIdRef.current !== serverId) return;
      pollingInFlight = true;
      try {
        pollingAvailable = await refreshConsoleLogs(serverId);
        if (pollingAvailable && !closedByCleanup && activeServerIdRef.current === serverId) {
          if (consoleReconnectNoticeTimeoutRef.current !== null) {
            window.clearTimeout(consoleReconnectNoticeTimeoutRef.current);
            consoleReconnectNoticeTimeoutRef.current = null;
          }
          setConsoleConnectionState("polling");
        }
      } finally {
        pollingInFlight = false;
      }
    }

    function startPolling() {
      if (pollingInterval !== null) return;
      void pollConsoleLogs();
      pollingInterval = window.setInterval(() => void pollConsoleLogs(), 2_000);
    }

    function scheduleReconnect() {
      if (!allowReconnect || reconnectScheduled || closedByCleanup || activeServerIdRef.current !== serverId) return;
      reconnectScheduled = true;
      startPolling();
      if (consoleReconnectNoticeTimeoutRef.current === null) {
        consoleReconnectNoticeTimeoutRef.current = window.setTimeout(() => {
          consoleReconnectNoticeTimeoutRef.current = null;
          if (!pollingAvailable && activeServerIdRef.current === serverId) setConsoleConnectionState("reconnecting");
        }, 3_000);
      }
      const delay = consoleReconnectDelay(consoleReconnectAttemptRef.current);
      consoleReconnectAttemptRef.current += 1;
      consoleReconnectTimeoutRef.current = window.setTimeout(() => {
        consoleReconnectTimeoutRef.current = null;
        if (activeServerIdRef.current === serverId) {
          setConsoleStreamVersion((version) => version + 1);
        }
      }, delay);
    }

    function markConsoleLive() {
      if (activeServerIdRef.current !== serverId) return;
      stopPolling();
      consoleReconnectAttemptRef.current = 0;
      if (consoleReconnectNoticeTimeoutRef.current !== null) {
        window.clearTimeout(consoleReconnectNoticeTimeoutRef.current);
        consoleReconnectNoticeTimeoutRef.current = null;
      }
      setConsoleConnectionState("live");
      setConsoleError("");
    }

    socket.onopen = markConsoleLive;
    socket.onmessage = (event) => {
      let message: { type?: string; source?: string; text?: string; message?: string; code?: string; retryable?: boolean };
      try {
        message = JSON.parse(event.data);
      } catch {
        setConsoleError("Console stream sent an unreadable message.");
        setConsoleConnectionState("error");
        return;
      }
      if (message.type === "log") {
        markConsoleLive();
        setLogs((current) => {
          const next = appendConsoleEntries(current, [message.text ?? ""], consoleScrollbackRef.current);
          logsRef.current = next;
          return next;
        });
        if (message.text && hasPotentialEvent(message.text) && activeServerIdRef.current) {
          triggerOverviewRefreshRef.current(activeServerIdRef.current);
        }
      }
      if (message.type === "unavailable") {
        const unavailableMessage = message.message ?? "Console stream is unavailable.";
        setConsoleError(unavailableMessage);
        if (isNodeOfflineConsoleMessage(message)) {
          allowReconnect = false;
          setConsoleConnectionState("offline");
          void refreshNodeConnectivity();
        } else if (consoleUnavailableIsRetryable(message)) {
          scheduleReconnect();
        } else {
          allowReconnect = false;
          setConsoleConnectionState("error");
        }
        socket.close();
      }
      if (message.type === "status" || message.type === "heartbeat") {
        markConsoleLive();
        if (message.type === "status") void refreshStatus(serverId);
      }
      if (message.type === "empty") {
        markConsoleLive();
        setLogs((current) => current.length ? current : []);
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = scheduleReconnect;
    return () => {
      closedByCleanup = true;
      if (consoleReconnectTimeoutRef.current !== null) {
        window.clearTimeout(consoleReconnectTimeoutRef.current);
        consoleReconnectTimeoutRef.current = null;
      }
      if (consoleReconnectNoticeTimeoutRef.current !== null) {
        window.clearTimeout(consoleReconnectNoticeTimeoutRef.current);
        consoleReconnectNoticeTimeoutRef.current = null;
      }
      stopPolling();
      socket.close();
    };
  }, [activeServer?.id, activePage, consoleStreamVersion, demoMode, activeNodeRuntimeBlocked, activeNodeBlockMessage]);

  useEffect(() => {
    if (!activeServer || activePage !== "files" || activeNodeRuntimeBlocked) return;
    if (fileWorkspaceServerIdRef.current === activeServer.id) return;
    fileWorkspaceServerIdRef.current = activeServer.id;
    filesWorkspace.actions.resetEditorState();
    if (demoMode && activeServer.id === demoServerId) {
      filesWorkspace.actions.initializeDemoRoot(readStoredFileLocation(activeServer.id));
      return;
    }
    const restoredFilePath = readStoredFileLocation(activeServer.id);
    void filesWorkspace.actions.loadFiles(activeServer.id, restoredFilePath).then((loaded) => {
      if (!loaded && restoredFilePath !== "/") void filesWorkspace.actions.loadFiles(activeServer.id, "/");
    });
  }, [activeServer?.id, activePage, activeNodeRuntimeBlocked, demoMode]);

  useEffect(() => {
    persistCommandHistory(window.localStorage, commandHistory, rememberConsoleHistory);
  }, [commandHistory, rememberConsoleHistory]);

  useEffect(() => {
    try {
      window.localStorage.removeItem("serversentinel-player-metrics");
    } catch {
      // Ignore unavailable browser storage; player snapshots are server-owned.
    }
  }, []);

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
    if (currentNode && currentNode.status === "online" && isNodeRuntimeUsable(currentNode)) return;
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      void refreshApp();
    }, 2500);
    return () => window.clearInterval(interval);
  }, [addNodeOpen, addNodeResult?.node.id, contextNodes, demoMode]);

  useEffect(() => {
    if (!activeServer || activeServerUsesInternalNode || demoMode) return;
    const refreshWhenActive = () => {
      if (!document.hidden) void refreshNodeConnectivity();
    };
    const handleVisibility = () => refreshWhenActive();

    void refreshNodeConnectivity();
    const interval = window.setInterval(refreshWhenActive, 5_000);
    window.addEventListener("focus", refreshWhenActive);
    window.addEventListener("online", refreshWhenActive);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenActive);
      window.removeEventListener("online", refreshWhenActive);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [activeServer?.id, activeServerUsesInternalNode, demoMode]);

  useEffect(() => {
    if (!activeServer || activePage !== "overview" || activeNodeRuntimeBlocked || wideTimelineLayout) {
      setResourceSamples([]);
      return;
    }
    if (demoMode && activeServer.id === demoServerId) {
      setResourceSamples(demoStatsHistory(demoRunning, Date.now(), resourcePollMs, resourceHistorySampleLimit));
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
  }, [activeServer?.id, activePage, activeNodeRuntimeBlocked, demoMode, demoRunning, wideTimelineLayout]);

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
    setAuthSession({ authenticated: false, setupRequired: false, demoEnabled: authSession?.demoEnabled, user: null });
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
      const nextDemoMode = Boolean(session.authenticated && session.demo);
      writeStoredDemoMode(nextDemoMode);
      setDemoMode(nextDemoMode);
      if (nextDemoMode) {
        resetDemoState();
        setActivePage("overview");
      }
      setAuthNotice("");
      setAuthSession(session);
    } catch (error) {
      writeStoredDemoMode(false);
      setDemoMode(false);
      setAuthNotice("");
      setAuthSession({ authenticated: false, setupRequired: false, demoEnabled: false, user: null });
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
    const setupToken = String(form.get("setupToken") || "");
    const setupRequired = authSession?.setupRequired ?? false;
    const demoLogin = Boolean(authSession?.demoEnabled) && username === "demo" && password === "demo";
    setAuthNotice("");
    if (!demoLogin) {
      const passwordError = setupRequired ? validatePassword(password, true) : password ? null : "Password is required.";
      const errors = [
        validateUsername(username) ? { field: "username", message: validateUsername(username)! } : null,
        passwordError ? { field: "password", message: passwordError } : null
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
        body: JSON.stringify({ username, password, ...(setupRequired && !demoLogin ? { setupToken } : {}) })
      });
      loginSucceeded = true;
      resetSessionRequestGuards();
      if (session.demo) {
        writeStoredDemoMode(true);
        resetDemoState();
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
    setAuthSession({ authenticated: false, setupRequired: false, demoEnabled: authSession?.demoEnabled, user: null });
    setAppState(emptyApp);
    setAppStateLoaded(false);
    setActiveServerId("");
    setStatus(null);
    setLogs([]);
    staleSessionLogoutRef.current = false;
    staleSessionSuppressUntilRef.current = 0;
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

  async function refreshNodeConnectivity() {
    if (demoMode || nodeRefreshInFlightRef.current || !authSession?.authenticated) return;
    nodeRefreshInFlightRef.current = true;
    try {
      const result = await api<{ nodes: ManagedNode[] }>("/api/nodes");
      const currentServer = effectiveAppState.servers.find((server) => server.id === activeServerIdRef.current);
      const currentNode = currentServer ? contextNodes.find((node) => node.id === currentServer.nodeId) : undefined;
      const nextNode = currentServer ? result.nodes.find((node) => node.id === currentServer.nodeId) : undefined;
      setAppState((current) => ({ ...current, nodes: result.nodes }));

      if (currentServer && currentNode && nextNode && !isNodeRuntimeUsable(currentNode) && isNodeRuntimeUsable(nextNode)) {
        await refreshApp({ silent: true });
        if (activeServerIdRef.current !== currentServer.id) return;
        setStatusError("");
        setConsoleError("");
        setConsoleConnectionState("connecting");
        consoleReconnectAttemptRef.current = 0;
        await Promise.allSettled([refreshStatus(currentServer.id), refreshConsoleLogs(currentServer.id)]);
        setConsoleStreamVersion((version) => version + 1);
      }
    } catch (error) {
      if (handleStaleSession(error)) return;
    } finally {
      nodeRefreshInFlightRef.current = false;
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
        if (error instanceof ApiError && error.code === "NODE_OFFLINE") {
          setConsoleConnectionState("offline");
          void refreshNodeConnectivity();
        }
      }
    } finally {
      statusRefreshInFlightRef.current.delete(serverId);
    }
  }

  async function refreshConsoleLogs(serverId = activeServer?.id): Promise<boolean> {
    if (!serverId) return false;
    if (demoMode && serverId === demoServerId) {
      if (activeServerIdRef.current === serverId) {
        setLogs((current) => current.length ? current : [
          consoleLine("[demo] Starting minecraft server version 1.21.4"),
          consoleLine("[demo] Done (5.132s)! For help, type \"help\"")
        ]);
      }
      return true;
    }
    const startLogs = logsRef.current;
    setConsoleLoading(startLogs.length === 0);
    try {
      const limit = consoleScrollbackRef.current;
      const result = await api<{ text: string; source: string }>(`/api/servers/${serverId}/logs?limit=${limit}`);
      if (activeServerIdRef.current !== serverId) return false;
      const lines = consoleSnapshotLines(result.text, limit);
      const nextLogs = lines.map((line) => consoleLine(line));
      setLogs((current) => {
        const reconciled = reconcileConsoleSnapshot(startLogs, nextLogs, current, limit);
        logsRef.current = reconciled;
        return reconciled;
      });
      return true;
    } catch (error) {
      if (handleStaleSession(error)) return false;
      if (activeServerIdRef.current === serverId) {
        setConsoleError(errorMessage(error, "Could not load console logs. Runtime logs may be unavailable."));
        if (error instanceof ApiError && error.code === "NODE_OFFLINE") {
          setConsoleConnectionState("offline");
          void refreshNodeConnectivity();
        }
      }
      return false;
    } finally {
      if (activeServerIdRef.current === serverId) setConsoleLoading(false);
    }
  }

  async function retryActiveConnection() {
    const serverId = activeServerIdRef.current;
    if (!serverId) return;
    if (!nodeOfflineDetected) setConsoleConnectionState("connecting");
    consoleReconnectAttemptRef.current = 0;
    await Promise.allSettled([
      refreshNodeConnectivity(),
      refreshApp({ silent: true }),
      refreshStatus(serverId),
      refreshConsoleLogs(serverId)
    ]);
    if (activeServerIdRef.current === serverId) setConsoleStreamVersion((version) => version + 1);
  }

  function downloadConsoleLogs() {
    if (!activeServer || logs.length === 0) return;
    const safeServerName = (activeServer.displayName || activeServer.id)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "server";
    const timestamp = formatTimestampForFilename(new Date(), displayTimeZone);
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
    const requestedRuntimeType = form.get("runtimeType") === "paper" ? "paper" : "fabric";
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
            runtimeType: requestedRuntimeType,
            runtimeVersion: form.get("runtimeVersion"),
            minecraftVersion: form.get("minecraftVersion"),
            ...(requestedRuntimeType === "fabric" ? {
              loader: "fabric",
              loaderVersion: form.get("runtimeVersion")
            } : {}),
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
    const editRuntimeType = form.get("runtimeType") === "paper" ? "paper" : "fabric";
    const editRuntimeVersion = form.get("runtimeVersion") || undefined;
    try {
      const server = await api<ManagedServer>(`/api/servers/${activeServer.id}`, {
        method: "PUT",
        body: JSON.stringify({
          displayName: form.get("displayName"),
          runtime: {
            runtimeType: editRuntimeType,
            runtimeVersion: editRuntimeVersion,
            ...(editRuntimeType === "fabric" ? { loader: "fabric", loaderVersion: editRuntimeVersion } : {}),
            minecraftVersion: form.get("minecraftVersion"),
            serverJar: form.get("serverJar")
          },
          dockerContainer: form.get("dockerContainer"),
          dockerImage: form.get("dockerImage"),
          dockerPorts: form.get("dockerPorts"),
          javaArgs: form.get("javaArgs"),
          serverPort: form.get("serverPort"),
          queryPort: form.get("queryPort"),
          startOnNodeStart: form.get("startOnNodeStart") === "on"
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

  async function clearConsoleHistory() {
    if (commandHistory.length === 0) return;
    const confirmed = await requestConfirmation({
      title: "Clear command history?",
      description: "Remove every command currently available for console history recall.",
      warning: "This cannot be undone. Console log output is not affected.",
      confirmLabel: "Clear history",
      variant: "critical"
    });
    if (!confirmed) return;
    setCommandHistory([]);
    clearStoredCommandHistory();
    notify("success", "Console command history cleared");
  }

  async function refreshNodes() {
    await refreshApp();
    notify("success", "Node status refreshed");
  }

  async function viewNodeDetails(node: ManagedNode) {
    setNodeDetails(node);
    if (demoMode) return;
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
    const actionLabel = sameVersion ? "Update" : "Upgrade";
    const versionText = sameVersion
      ? ` to ${panelVersion}${buildText}`
      : node.agentVersion ? ` from ${node.agentVersion} to ${panelVersion}${buildText}` : ` to ${panelVersion}${buildText}`;
    const confirmed = await requestConfirmation({
      title: `${actionLabel} ${node.name}?`,
      description: `${actionLabel} this node${versionText}.`,
      details: nodeRestartImpactMessage(node),
      warning: "The node may disconnect briefly while its container is recreated.",
      confirmLabel: `${actionLabel} node`,
      variant: "primary"
    });
    if (!confirmed) return;
    setNodeBusyId(node.id);
    try {
      const result = await api<NodeUpdateResponse>(`/api/nodes/${node.id}/update`, {
        method: "POST",
        body: JSON.stringify({})
      });
      if (result.mode === "offline") {
        setNodeManualRecoveryById((current) => ({
          ...current,
          [node.id]: { message: result.message, command: result.command, image: result.image }
        }));
        setNodeDetails((current) => current?.id === node.id ? current : node);
        notify("info", result.message);
        return;
      }
      if (result.mode === "current") {
        notify("success", result.message || `${node.name} is already current.`);
        await refreshApp({ silent: true });
        return;
      }
      notify("info", result.message || `Node ${node.name} update started.`);
      if (result.ok && result.mode === "self") {
        const startedAt = Date.now();
        setNodeManualRecoveryById((current) => {
          if (!current[node.id]) return current;
          const next = { ...current };
          delete next[node.id];
          return next;
        });
        setNodeOperations((current) => ({
          ...current,
          [node.id]: {
            kind: "update",
            phase: "waiting",
            startedAt,
            startedConnectedAt: node.connectedAt,
            targetVersion: panelVersion,
            targetBuildId: panelBuildId
          }
        }));
        setNodeOperationNow(startedAt);
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
    const confirmed = await requestConfirmation({
      title: node.isInternal ? "Restart the Panel container?" : `Restart ${node.name}?`,
      description: node.isInternal
        ? `Restart the Panel container (${node.name}).`
        : `Restart the node container for ${node.name}.`,
      details: nodeRestartImpactMessage(node),
      warning: node.isInternal
        ? "Your current session will disconnect temporarily while the Panel restarts."
        : "The node will disconnect briefly while its container restarts.",
      confirmLabel: node.isInternal ? "Restart Panel" : "Restart node",
      variant: "primary"
    });
    if (!confirmed) return;
    setNodeBusyId(node.id);
    try {
      const result = await api<{ ok: boolean; message?: string }>(`/api/nodes/${node.id}/restart`, {
        method: "POST"
      });
      notify("info", result.message || `Node ${node.name} restart started.`);
      if (result.ok) {
        const startedAt = Date.now();
        setNodeOperations((current) => ({
          ...current,
          [node.id]: {
            kind: "restart",
            phase: "waiting",
            startedAt,
            startedConnectedAt: node.connectedAt
          }
        }));
        setNodeOperationNow(startedAt);
      }
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
        ? `This will remove ${node.servers.length} assigned server record${node.servers.length === 1 ? "" : "s"} from the panel even if managed container cleanup cannot finish. Remote server files are not deleted.`
        : `This will remove managed containers for ${node.servers.length} assigned server${node.servers.length === 1 ? "" : "s"}, then remove the server record${node.servers.length === 1 ? "" : "s"} from the panel. Remote server files are not deleted.`
      : undefined;
    const confirmed = await requestConfirmation({
      title: `${force ? "Force remove" : "Remove"} ${node.name}?`,
      description: force ? "Force-remove this node from the Panel." : "Remove this node from the Panel.",
      details: assignedMessage,
      warning: "This action cannot be undone.",
      confirmLabel: force ? "Force remove node" : "Remove node",
      variant: "critical"
    });
    if (!confirmed) return;
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
      setNodeOperations((current) => {
        if (!current[node.id]) return current;
        const next = { ...current };
        delete next[node.id];
        return next;
      });
      setNodeManualRecoveryById((current) => {
        if (!current[node.id]) return current;
        const next = { ...current };
        delete next[node.id];
        return next;
      });
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
          ...current,
          consoleLine(`[demo] ${action === "restart" ? "Restarting" : action === "start" ? "Starting" : "Stopping"} simulated server`),
          consoleLine(`[demo] Server is now ${nextRunning ? "running" : "stopped"}`)
        ].slice(-consoleScrollbackRef.current));
        showRuntimeFeedback(action);
        notify("success", `Demo server ${completedLabel}`);
        return;
      }
      await api(`/api/servers/${activeServer.id}/${action}`, { method: "POST" });
      await refreshApp({ silent: true });
      await refreshStatus(activeServer.id);
      setConsoleStreamVersion((version) => version + 1);
      await refreshConsoleLogs(activeServer.id);
      showRuntimeFeedback(action);
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
        setLogs((current) => [...current, consoleLine(`[demo] ${response}`)].slice(-consoleScrollbackRef.current));
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
      await logout();
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
        <AuthLoadingSkeleton />
      </>
    );
  }

  if (!authSession.authenticated && !demoMode) {
    return (
      <>
        <AppToaster darkMode={darkMode} />
        <AuthPanel
          setupRequired={authSession.setupRequired}
          demoEnabled={authSession.demoEnabled}
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
          ? "Add an online, Docker-ready node before creating a server."
          : "Server creation is unavailable right now."
        : provisioningNavigationReason;
  const noManagedServersMessage = panelOnlyMode && usableContextNodes.length === 0
    ? "No node is connected yet. Add a node first so serverSENTINEL has a host where it can create Minecraft servers."
    : "No managed servers have been created yet. Create one to set up its runtime files and start managing a Minecraft server from this panel.";
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
    mods: managedContent.pluralTitle,
    schedule: "Schedules",
    properties: "Properties",
    settings: "Settings",
    nodes: "Nodes"
  };
  const currentPageTitle = pageTitles[activePage] ?? (!applicationReady ? "Loading" : "Welcome");
  const overviewInitialLoading = shouldShowInitialOverviewLoading(
    overviewLoading,
    overviewData.events.length,
    Object.keys(overviewData.activity).length
  );

  function openSidebarPage(page: ActivePage) {
    setActivePage(page);
    if (window.matchMedia("(max-width: 1100px)").matches) setSidebarCollapsed(true);
  }

  return (
    <>
      <AppToaster darkMode={darkMode} />
      <main className={`appShell ${sidebarCollapsed ? "sidebarCollapsed" : ""} ${phoneLayout && !sidebarCollapsed ? "mobileNavigationOpen" : ""} ${themeClassName}`.replace(/\s+/g, " ").trim()}>
        <aside className="sidebar" id="application-sidebar">
        <div className="brandBlock">
          <div className="brandLockup">
            <BrandLogo />
            <div>
              <h1 className="sidebarBrandWordmark" aria-label="serverSENTINEL">
                <span aria-hidden="true">server</span>
                <span aria-hidden="true">SENTINEL</span>
              </h1>
            </div>
          </div>
          <Button ref={sidebarToggleRef} variant="secondary" iconOnly className="iconButton" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"} aria-expanded={!sidebarCollapsed} aria-controls="primary-navigation account-navigation" disabled={isProvisioning} title={isProvisioning ? provisioningNavigationReason : sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}>
            <SidebarToggleIcon collapsed={sidebarCollapsed} />
          </Button>
        </div>
        <nav className="sideNav" id="primary-navigation" aria-label="Infrastructure navigation">
          <button className={activePage === "nodes" ? "active" : ""} onClick={() => openSidebarPage("nodes")} disabled={isProvisioning} title={isProvisioning ? provisioningNavigationReason : "Open nodes"}>
            <SidebarIcon name="nodes" />
            <span className="navLabel">Nodes</span>
          </button>
          <div className="sidebarDivider" />
          <div className="serverNavigationGroup">
            <div className="serverSwitcher">
              <ActionMenu
                label={activeServer ? `Switch server. Current server: ${activeServer.displayName}` : "Select server"}
                className="serverSwitcherAction"
                triggerClassName="serverSwitcherTrigger"
                menuClassName="serverSwitcherMenu"
                align="start"
                disabled={isProvisioning || effectiveAppState.servers.length === 0}
                items={effectiveAppState.servers.map((server) => {
                  const selected = server.id === activeServer?.id;
                  const lockedByDemo = demoMode && server.id !== demoServerId;
                  const minecraftVersion = versionValue(minecraftVersionInfo(server));
                  return {
                    id: server.id,
                    active: selected,
                    disabled: lockedByDemo,
                    title: lockedByDemo ? "Exit demo mode to access this server." : `Switch to ${server.displayName}`,
                    onSelect: () => openServerFromNode(server.id),
                    label: (
                      <span className="serverSwitcherOption">
                        <span className={`serverSwitcherOptionDot ${selected ? serverCommandTone : "unknown"}`} aria-hidden="true" />
                        <span className="serverSwitcherOptionCopy">
                          <strong>{server.displayName}</strong>
                          <small>{server.nodeName || (minecraftVersion === "Unknown" ? "Version unknown" : `Minecraft ${minecraftVersion}`)}</small>
                        </span>
                        {selected && <span className="serverSwitcherCurrent">Current</span>}
                      </span>
                    )
                  };
                })}
                trigger={(
                  <>
                    <span className={`serverSwitcherStatus ${activeServer ? serverCommandTone : "unknown"}`} aria-hidden="true" />
                    <span className="serverSwitcherCopy">
                      <small>Managed server</small>
                      <strong>{activeServer?.displayName ?? "Select a server"}</strong>
                      <span>{activeServer?.nodeName || (activeServer ? "Server workspace" : "Choose a workspace")}</span>
                    </span>
                    <svg className="serverSwitcherChevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" aria-hidden="true">
                      <path d="m7 9 5 5 5-5" />
                    </svg>
                  </>
                )}
              />
            </div>
            <div className="serverSubNav">
              <button className={activePage === "overview" ? "active" : ""} onClick={() => openSidebarPage("overview")} disabled={isProvisioning || !activeServer} title={isProvisioning || !activeServer ? serverPageDisabledReason : "Open overview"}>
                <SidebarIcon name="overview" />
                <span className="navLabel">Overview</span>
              </button>
              <button className={activePage === "console" ? "active" : ""} onClick={() => openSidebarPage("console")} disabled={isProvisioning || !activeServer} title={isProvisioning || !activeServer ? serverPageDisabledReason : "Open console"}>
                <SidebarIcon name="console" />
                <span className="navLabel">Console</span>
              </button>
              <button className={activePage === "files" ? "active" : ""} onClick={() => openSidebarPage("files")} disabled={isProvisioning || !activeServer} title={isProvisioning || !activeServer ? serverPageDisabledReason : "Open files"}>
                <SidebarIcon name="files" />
                <span className="navLabel">Files</span>
              </button>
              {supportsManagedMods && (
                <button className={activePage === "mods" ? "active" : ""} onClick={() => openSidebarPage("mods")} disabled={isProvisioning || !activeServer} title={isProvisioning || !activeServer ? serverPageDisabledReason : `Open ${managedContent.plural}`}>
                  <SidebarIcon name="mods" />
                  <span className="navLabel">{managedContent.pluralTitle}</span>
                </button>
              )}
              <button className={activePage === "schedule" ? "active" : ""} onClick={() => openSidebarPage("schedule")} disabled={isProvisioning || !activeServer} title={isProvisioning || !activeServer ? serverPageDisabledReason : "Open schedules"}>
                <SidebarIcon name="schedule" />
                <span className="navLabel">Schedules</span>
              </button>
              <button className={activePage === "properties" ? "active" : ""} onClick={() => openSidebarPage("properties")} disabled={isProvisioning || !activeServer} title={isProvisioning || !activeServer ? serverPageDisabledReason : "Open properties"}>
                <SidebarIcon name="properties" />
                <span className="navLabel">Properties</span>
              </button>
            </div>
          </div>
        </nav>
        <nav className="sideNav sideNavBottom" id="account-navigation" aria-label="Account and settings navigation">
          <button className={activePage === "settings" ? "active" : ""} onClick={() => openSidebarPage("settings")} disabled={isProvisioning} title={isProvisioning ? provisioningNavigationReason : "Open settings"}>
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

      <section inert={phoneLayout && !sidebarCollapsed ? true : undefined} className={`workspace workspacePage-${activePage} ${isServerWorkspacePage(activePage) && (activeServer || (!appStateLoaded && (authSession.authenticated || demoMode))) ? "workspaceServerPage" : ""}`.trim()}>
        <header className="workspaceHeader">
          <div>
            <h2>{currentPageTitle}</h2>
          </div>
          <div className="workspaceActions">
            {activePage === "servers" && <Button onClick={() => openCreateServerForNode()} disabled={demoMode || isProvisioning || serverCreationBlocked || !canCreateServers} title={demoMode || isProvisioning || serverCreationBlocked || !canCreateServers ? createServerDisabledReason : "Create a managed server"}>New managed server</Button>}
            {activePage === "create" && <Button variant="secondary" onClick={() => setActivePage("servers")} disabled={isProvisioning} title={isProvisioning ? provisioningNavigationReason : "Cancel server creation"}>Cancel</Button>}
          </div>
        </header>

        {appStateLoaded && activePage !== "settings" && !panelOnlyMode && !effectiveAppState.dockerSocketMounted && (activeNode.isInternal || usableContextNodes.length === 0) && !(isServerWorkspacePage(activePage) && activeServer && serverStripAlert) && (
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

        {notice && activePage !== "files" && <div className="notice">{notice}</div>}

        {!appStateLoaded && (authSession.authenticated || demoMode) && !appLoadError && shouldShowApplicationLoadingSkeleton(activePage) && (
          <Fragment key="application-loading">
            {isServerWorkspacePage(activePage) && <ActiveServerStripLoadingSkeleton />}
            <ApplicationLoadingSkeleton page={activePage} />
          </Fragment>
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
          <section className="pageStack layoutBalanced">
            {effectiveAppState.servers.length > 0 ? (
              <section className="serverList">
                {effectiveAppState.servers.map((server) => {
                  const lockedByDemo = demoMode && server.id !== demoServerId;
                  const minecraftVersion = versionValue(minecraftVersionInfo(server));
                  const runtime = serverRuntimeDefinition(server.runtimeProfile.runtimeType);
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
                      <span>{minecraftVersion === "Unknown" ? "Version unknown" : minecraftVersion} - {runtime.displayName}</span>
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
            <Suspense fallback={<FeaturePageLoadingSkeleton label="Loading server form" page="create" />}>
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
            </Suspense>
          </section>
        )}

        {activePage === "settings" && (
          <SettingsPage
            loading={settingsDataLoading}
            themePreference={themePreference}
            relativeTimestamps={relativeTimestamps}
            dateLocalePreference={dateLocalePreference}
            numberLocalePreference={numberLocalePreference}
            displayTimeZonePreference={displayTimeZonePreference}
            panelTimeZone={panelTimeZone}
            browserTimeZone={browserTimeZone}
            displayTimeZone={displayTimeZone}
            onThemeChange={setThemePreference}
            onRelativeTimestampsChange={setRelativeTimestamps}
            onDateLocaleChange={setDateLocalePreference}
            onNumberLocaleChange={setNumberLocalePreference}
            onDisplayTimeZoneChange={setDisplayTimeZonePreference}
            rememberConsoleHistory={rememberConsoleHistory}
            consoleFontSize={consoleFontSize}
            consoleScrollback={consoleScrollback}
            commandHistoryCount={commandHistory.length}
            onRememberConsoleHistoryChange={setRememberConsoleHistory}
            onConsoleFontSizeChange={setConsoleFontSize}
            onConsoleScrollbackChange={setConsoleScrollback}
            onClearConsoleHistory={() => void clearConsoleHistory()}
            modrinthConfigured={effectiveAppState.modrinthApiConfigured}
            canManageIntegrations={canManageIntegrations}
            onSubmitModrinthKey={updateModrinthKey}
            canViewUsers={canViewUsers}
            userState={usersWorkspace}
            systemInfo={{
              panelVersion,
              buildId: panelBuildId,
              runtimeMode: effectiveAppState.runtimeMode,
              panelTimeZone,
              displayTimeZone,
              dockerSocketMounted: effectiveAppState.dockerSocketMounted,
              panelOnlyMode,
              demoMode,
              serverCount: effectiveAppState.servers.length,
              nodes: contextNodes,
              totalMemory: effectiveAppState.totalMemory,
              modrinthConfigured: effectiveAppState.modrinthApiConfigured
            }}
            refreshingSystemInfo={appRefreshing}
            onRefreshSystemInfo={() => void refreshApp()}
            onCopyDiagnostics={(value) => void copyText(value)}
            onExitDemo={() => void logout()}
            exitDemoDisabled={isProvisioning}
          />
        )}

        {activePage === "nodes" && (
          <Suspense fallback={<FeaturePageLoadingSkeleton label="Loading nodes" page="nodes" />}>
            <NodesPage
            nodes={contextNodes}
            panelVersion={panelVersion}
            panelBuildId={panelBuildId}
            canManageNodes={canManageUsers}
            busy={Boolean(nodeBusyId)}
            busyNodeId={nodeBusyId}
            browserPanelUrl={currentPanelUrl()}
            selectedNode={nodeDetails ? contextNodes.find((node) => node.id === nodeDetails.id) ?? nodeDetails : null}
            nodeOperations={nodeOperations}
            nodeOperationNow={nodeOperationNow}
            nodeUpdateGraceMs={nodeUpdateGraceMs}
            nodeManualRecoveryById={nodeManualRecoveryById}
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
            playerSnapshots={playerSnapshots}
              formatDate={formatDisplayDate}
            />
          </Suspense>
        )}

        {applicationReady && isServerWorkspacePage(activePage) && !activeServer && effectiveAppState.servers.length === 0 && (
          renderNoManagedServersEmptyState("Welcome to serverSENTINEL")
        )}

        {applicationReady && isServerWorkspacePage(activePage) && !activeServer && effectiveAppState.servers.length > 0 && (
          <EmptyState
            title="No server selected"
            message="A server exists, but none is open right now. Choose one from the Servers page to view its console, files, managed content, and settings."
            action={<Button onClick={() => setActivePage("servers")}>Open servers</Button>}
          />
        )}

        {isServerWorkspacePage(activePage) && activeServer && (
          <Fragment key={`server-workspace-${activeServer.id}`}>
            <div className={`activeServerStrip ${runtimeAction ? `runtimeAction-${runtimeAction}` : ""} ${runtimeFeedbackAction ? `runtimeFeedback-${runtimeFeedbackAction}` : ""}`.replace(/\s+/g, " ").trim()}>
              <div className="serverStripPrimary">
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
                        {lastKnownRuntimeLabel}
                      </StatusBadge>
                      {activeServer.restartRequiredSince && <RestartRequiredBadge changes={activeServer.restartRequiredChanges} runtimeType={activeServer.runtimeProfile.runtimeType} />}
                    </div>
                    <div className="serverStripMetaRow">
                      {serverStripHealth ? (
                        <small className={`serverStripHealth ${serverStripHealth.tone}`} role={serverStripHealth.tone === "error" ? "alert" : "status"} title={consoleError || statusError || serverStripHealth.message}>
                          {serverStripHealth.tone === "loading" && <span className="serverStripHealthSpinner" aria-hidden="true" />}
                          {serverStripHealth.message}
                        </small>
                      ) : (
                        <>
                          <small className="serverStripMeta">
                            {activeNode.name}
                          </small>
                          <span aria-hidden="true" className="serverStripSeparator">·</span>
                          <small className="serverStripMeta">
                            {activeRuntimeDefinition?.displayName ?? "Runtime"} {activeServer.runtimeProfile.runtimeVersion || "unknown"}
                          </small>
                          <span aria-hidden="true" className="serverStripSeparator">·</span>
                          <small className="serverStripMeta">
                            MC {activeMinecraftVersion === "Unknown" ? "unknown" : activeMinecraftVersion}
                          </small>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="serverStripRight">
                  {confirmedNodeOffline && <ServerRuntimeAlert title="Node offline" compact />}
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
                  <ActionMenu
                    label="More server actions"
                    className="overflowMenuContainer"
                    triggerClassName="iconButton overflowButton"
                    menuClassName="overflowDropdown"
                    items={[
                      {
                        id: "refresh",
                        label: serverStripHealth || serverStripAlert ? "Retry connection" : "Refresh status",
                        onSelect: () => { void retryActiveConnection(); },
                        disabled: isProvisioning,
                        title: isProvisioning ? provisioningNavigationReason : "Refresh server status"
                      },
                      {
                        id: "download-log",
                        label: "Download log",
                        onSelect: downloadConsoleLogs,
                        disabled: logs.length === 0,
                        title: logs.length === 0 ? "No console log lines are available to download." : "Download console log"
                      }
                    ]}
                    trigger={
                      <svg className="buttonIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                        <circle cx="12" cy="5" r="1.5" fill="currentColor" />
                        <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                        <circle cx="12" cy="19" r="1.5" fill="currentColor" />
                      </svg>
                    }
                  />
                </div>
              </div>
              {serverStripAlert && <ServerRuntimeAlert title={serverStripAlert.title} message={serverStripAlert.message} />}
            </div>

            {activePage === "overview" && (
              <section className="tabPage overviewPage layoutDashboard">
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
                <div className="overviewDashboardGrid">
                  <OverviewSummary
                    server={activeServer}
                    status={activeStatus}
                    dockerSocketMounted={activeServerDockerSocketMounted}
                    activity={overviewData.activity}
                    playerSnapshot={playerSnapshots[activeServer.id]}
                    latestResourceSample={wideTimelineLayout ? timelineLatestSample : resourceSamples.at(-1)}
                    formatNumber={formatDisplayNumber}
                    loading={overviewInitialLoading}
                  />

                  {wideTimelineLayout ? (
                    <Suspense fallback={<ResourcePanelLoadingSkeleton />}>
                      <ServerTimeline
                        key={activeServer.id}
                        loadTimeline={loadActiveTimeline}
                        formatTime={formatDisplayTime}
                        formatShortTime={formatDisplayShortTime}
                        formatDate={formatDisplayDate}
                        onLatestSample={setTimelineLatestSample}
                        onOpenSchedules={(target) => {
                          setScheduleNavigationTarget(target ?? null);
                          setActivePage("schedule");
                        }}
                      />
                    </Suspense>
                  ) : (
                    <Suspense fallback={<ResourcePanelLoadingSkeleton />}>
                      <ResourcePanel
                        server={activeServer}
                        samples={resourceSamples}
                        status={activeStatus}
                        dockerSocketMounted={activeServerDockerSocketMounted}
                        formatNumber={formatDisplayNumber}
                        formatTime={formatDisplayTime}
                        loading={overviewLoading && resourceSamples.length === 0}
                      />
                    </Suspense>
                  )}

                  <ActivePlayersPanel snapshot={playerSnapshots[activeServer.id]} running={Boolean(activeStatus?.docker.running)} loading={overviewInitialLoading} />
                  <ModHealthPanel
                    updatePlan={modsWorkspace.data.updatePlan}
                    loading={modsWorkspace.state.updatePlanLoading}
                    canView={canViewMods && supportsManagedMods}
                    onOpenMods={() => setActivePage("mods")}
                    contentPlural={managedContent.plural}
                    contentPluralTitle={managedContent.pluralTitle}
                  />
                  <SchedulePanel
                    schedules={activeServer.schedules ?? []}
                    canView={canViewSchedules}
                    formatDate={formatDisplayDate}
                    relativeTimestamps={relativeTimestamps}
                    onOpenSchedules={(target) => {
                      setScheduleNavigationTarget(target ?? null);
                      setActivePage("schedule");
                    }}
                  />
                  <RecentEventsPanel events={overviewData.events} eventsStatus={overviewData.eventsStatus} formatDate={formatDisplayDate} relativeTimestamps={relativeTimestamps} onOpenConsole={() => setActivePage("console")} requestConfirmation={requestConfirmation} loading={overviewLoading && overviewData.events.length === 0} />
                </div>

              </section>
            )}

            {activePage === "console" && (
              <section className="tabPage layoutWide">
                <section className="panel consolePanel">
                  <PanelHeader
                    title="Console"
                    actions={<div className="consoleHeaderActions">
                      <Button variant="secondary" compact onClick={downloadConsoleLogs} disabled={logs.length === 0} title={logs.length === 0 ? "No console log lines are available to download." : "Download console log"}>
                        Download log
                      </Button>
                    </div>}
                  />
                  <div className="terminal">
                    <Suspense fallback={<TerminalLoadingSkeleton />}>
                      <MinecraftTerminal
                        entries={logs}
                        canSendCommands={canSendConsoleCommands}
                        disabledReason={consoleCommandDisabledReason}
                        commandHistory={commandHistory}
                        fontSize={consoleFontSize}
                        scrollback={consoleScrollback}
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
              <Suspense fallback={<FeaturePageLoadingSkeleton label="Loading files" page="files" />}>
                <FilesPage
                  workspace={filesWorkspace}
                  activeServerIsDemo={activeServerIsDemo}
                  permissionUser={permissionUser}
                  isProvisioning={isProvisioning}
                  dockerOperationalLock={dockerOperationalLock}
                  dateTimeFormatter={dateTimeFormatter}
                  onCopyText={(text) => void copyText(text)}
                />
              </Suspense>
            )}

            {activePage === "mods" && supportsManagedMods && (
              <Suspense fallback={<FeaturePageLoadingSkeleton label={`Loading ${managedContent.plural}`} page="mods" />}>
                <ModsPage
                workspace={modsWorkspace}
                runtimeType={activeServer.runtimeProfile.runtimeType}
                restartRequiredChanges={activeServer.restartRequiredChanges}
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
                  relativeTimestamps={relativeTimestamps}
                  formatters={{ date: formatDisplayDate, number: formatDisplayNumber }}
                />
              </Suspense>
            )}

            {activePage === "schedule" && (
              <Suspense fallback={<FeaturePageLoadingSkeleton label="Loading schedules" page="schedule" />}>
                <SchedulePage
                  schedules={schedulesWorkspace.schedules}
                  formatDate={formatDisplayDate}
                  relativeTimestamps={relativeTimestamps}
                  scheduleTimeZone={panelTimeZone}
                  navigationTarget={scheduleNavigationTarget}
                  onNavigationTargetHandled={() => setScheduleNavigationTarget(null)}
                  onCreate={schedulesWorkspace.actions.create}
                  onToggle={schedulesWorkspace.actions.toggle}
                  onUpdate={schedulesWorkspace.actions.update}
                  onDelete={schedulesWorkspace.actions.delete}
                  onRunNow={schedulesWorkspace.actions.runNow}
                  onCancelRun={schedulesWorkspace.actions.cancelRun}
                  disabled={schedulesWorkspace.disabled}
                  disabledReason={schedulesWorkspace.disabledReason}
                />
              </Suspense>
            )}

            {activePage === "properties" && (
              <section className="tabPage settingsPage layoutReadable">
                <Suspense fallback={<FeaturePageLoadingSkeleton label="Loading server properties" page="properties" />}>
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
                </Suspense>
              </section>
            )}

          </Fragment>
        )}
      </section>
      </main>
      {confirmationOptions ? (
        <ConfirmationModal
          options={confirmationOptions}
          onConfirm={() => settleConfirmation(true)}
          onCancel={() => settleConfirmation(false)}
        />
      ) : null}
    </>
  );
}
