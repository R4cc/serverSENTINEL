import { FormEvent, Fragment, lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { serverRuntimeDefinition } from "@serversentinel/contracts";
import { toast } from "sonner";
import { ApiError, api } from "./api";
import { demoFixtures, demoServerId, loadDemoFixtures } from "./demoRuntime";
import type { ActivePage, AppState, AuthSession, ManagedNode, ManagedServer, OperationRecord, PlayerSnapshot, PlayerSnapshotsResponse, ScheduleNavigationTarget, ServerOverviewData, ServerStatus, ServerTimelineResourcePoint, ServerTimelineResponse, GeneralJob } from "./types";
import { minecraftVersionInfo, runtimeTone, versionValue } from "./utils/format";
import { hasPermission } from "./utils/permissions";
import { trimFormValue, validatePassword, validateUsername } from "./utils/validation";
import { isNodeRuntimeUsable } from "./utils/nodes";
import { runtimeActionConfirmation } from "./utils/runtimeConfirmation";
import { appVersion, emptyApp, isServerWorkspacePage, shouldShowApplicationLoadingSkeleton, shouldShowInitialOverviewLoading, writeStoredDemoMode } from "./app/appConfig";
import { usePreferencesState } from "./app/appState";
import { useDisplayFormatters } from "./app/useDisplayFormatters";
import { readStoredActivePage, writeStoredActivePage } from "./app/navigationStorage";
import { useServerContext } from "./app/serverContext";
import { errorMessage, hasPotentialEvent, readCommandHistory, serverConfigValidation, setValidationNotice } from "./utils/appHelpers";
import { appendCommandHistory } from "./utils/minecraftTerminal";
import { appendConsoleEntries, ConsoleLineAssembler, consoleReconnectDelay, ConsoleReplayGuard, consoleSnapshotLines, consoleUnavailableIsRetryable, isNodeOfflineConsoleMessage, reconcileConsoleSnapshot, type ConsoleConnectionState } from "./utils/consolePipeline";
import { ActiveServerStrip } from "./components/ActiveServerStrip";
import { AppToaster } from "./components/AppToaster";
import { AppSidebar } from "./components/AppSidebar";
import { AuthPanel } from "./components/AuthPanel";
import { InlineState } from "./components/InlineState";
import { ActiveServerStripLoadingSkeleton, ApplicationLoadingSkeleton, AuthLoadingSkeleton, FeaturePageLoadingSkeleton, TerminalLoadingSkeleton } from "./components/LoadingSkeletons";
import { Banner, Button, EmptyState, Surface } from "./components/UiPrimitives";
import { ConfirmationModal, useConfirmationController } from "./components/ConfirmationModal";
import { PlayerHeadsOnboarding } from "./components/PlayerHeadsOnboarding";
import { useMobileViewport, useOverviewTimelineVisibility } from "./components/useMobileViewport";
import { modUpdateRefreshResultMessage } from "./pages/OverviewPage";
import { loadServerTimeline, ServerOverviewTab } from "./pages/ServerOverviewTab";
import { clearStoredCommandHistory, persistCommandHistory, readConsoleHistoryEnabled } from "./features/settings/settingsPreferences";
import { resolvedThemeClassName, resolveDarkTheme } from "./features/settings/themePreferences";
import { useModsWorkspace } from "./features/mods/useModsWorkspace";
import { managedContentTerminology } from "./features/mods/contentTerminology";
import { readStoredFileLocation } from "./features/files/fileLocationStorage";
import { useFilesWorkspace } from "./features/files/useFilesWorkspace";
import { useUsersWorkspace } from "./features/users/useUsersWorkspace";
import { nodeUpdateGraceMs, useNodesWorkspace } from "./features/nodes/useNodesWorkspace";
import { useSchedulesWorkspace } from "./features/schedules/useSchedulesWorkspace";

const loadMinecraftTerminal = () => import("./components/MinecraftTerminal");
const loadSchedulePage = () => import("./pages/SchedulesPage");
const loadNodesPage = () => import("./pages/NodesPage");
const loadServerCreatePage = () => import("./pages/ServerCreatePage");
const loadServerEditPage = () => import("./pages/ServerEditPage");
const loadModsPage = () => import("./pages/ModsPage");
const loadFilesPage = () => import("./features/files/FilesPage");
const loadSettingsPage = () => import("./pages/SettingsPage");

const MinecraftTerminal = lazy(() => loadMinecraftTerminal().then((module) => ({ default: module.MinecraftTerminal })));
const SchedulePage = lazy(() => loadSchedulePage().then((module) => ({ default: module.SchedulePage })));
const NodesPage = lazy(() => loadNodesPage().then((module) => ({ default: module.NodesPage })));
const ManagedServerForm = lazy(() => loadServerCreatePage().then((module) => ({ default: module.ManagedServerForm })));
const ServerEditForm = lazy(() => loadServerEditPage().then((module) => ({ default: module.ServerEditForm })));
const DeleteServerPanel = lazy(() => loadServerEditPage().then((module) => ({ default: module.DeleteServerPanel })));
const ModsPage = lazy(() => loadModsPage().then((module) => ({ default: module.ModsPage })));
const FilesPage = lazy(() => loadFilesPage().then((module) => ({ default: module.FilesPage })));
const SettingsPage = lazy(() => loadSettingsPage().then((module) => ({ default: module.SettingsPage })));

function preloadActivePage(page: ActivePage) {
  if (page === "console") return loadMinecraftTerminal();
  if (page === "overview") return loadServerTimeline();
  if (page === "files") return loadFilesPage();
  if (page === "mods") return loadModsPage();
  if (page === "schedule") return loadSchedulePage();
  if (page === "nodes") return loadNodesPage();
  if (page === "create") return loadServerCreatePage();
  if (page === "properties") return loadServerEditPage();
  if (page === "settings") return loadSettingsPage();
  return Promise.resolve();
}

function consoleLine(text: string) {
  return `${text}\n`;
}

const provisionJobPollMs = 1_500;
const serverStatusPollMs = 10_000;
const nodeOfflineNoticeDelayMs = 3_000;
const stoppedServerMutationMessage = "Stop the server before changing mods, plugins, or server properties.";
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
  const [demoSessionVersion, setDemoSessionVersion] = useState(0);
  const [timelineLatestSample, setTimelineLatestSample] = useState<ServerTimelineResourcePoint>();
  const [overviewData, setOverviewData] = useState<ServerOverviewData>({ events: [], activity: {} });
  const [playerSnapshots, setPlayerSnapshots] = useState<Record<string, PlayerSnapshot>>({});
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [consoleLoading, setConsoleLoading] = useState(false);
  const [consoleSnapshotReadyServerId, setConsoleSnapshotReadyServerId] = useState("");
  const [consoleError, setConsoleError] = useState("");
  const [consoleConnectionState, setConsoleConnectionState] = useState<ConsoleConnectionState>("connecting");
  const [nodeOfflineNoticeVisible, setNodeOfflineNoticeVisible] = useState(false);
  const [commandSending, setCommandSending] = useState(false);
  const [commandHistory, setCommandHistory] = useState<string[]>(() => readCommandHistory(readConsoleHistoryEnabled()));
  const [notice, setNotice] = useState("");
  const [activeJobs, setActiveJobs] = useState<GeneralJob[]>([]);
  const [provisioningError, setProvisioningError] = useState("");
  const [provisioningErrorDetails, setProvisioningErrorDetails] = useState("");
  const [serverSettingsSaving, setServerSettingsSaving] = useState(false);
  const [playerHeadsBusy, setPlayerHeadsBusy] = useState(false);
  const [playerHeadsOnboardingError, setPlayerHeadsOnboardingError] = useState("");
  const [consoleStreamVersion, setConsoleStreamVersion] = useState(0);
  const [runtimeAction, setRuntimeAction] = useState<"start" | "stop" | "restart" | null>(null);
  const [runtimeFeedbackAction, setRuntimeFeedbackAction] = useState<"start" | "restart" | null>(null);
  const [activePage, setActivePage] = useState<ActivePage>(() => readStoredActivePage());
  const [scheduleNavigationTarget, setScheduleNavigationTarget] = useState<ScheduleNavigationTarget | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.matchMedia("(max-width: 1100px)").matches);
  const phoneLayout = useMobileViewport();
  const overviewTimelineVisible = useOverviewTimelineVisibility();
  const sidebarToggleRef = useRef<HTMLButtonElement | null>(null);
  const [preferredCreateNodeId, setPreferredCreateNodeId] = useState("");
  const {
    themePreference,
    setThemePreference,
    demoMode,
    setDemoMode,
    regionalFormatPreference,
    setRegionalFormatPreference,
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
  const pendingLogLinesRef = useRef<string[]>([]);
  const consoleLineAssemblerRef = useRef(new ConsoleLineAssembler());
  const logFlushFrameRef = useRef<number | null>(null);
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
  const overviewModRefreshInFlightRef = useRef(false);
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
      setOverviewData(demoFixtures().demoOverviewData(demoRunning));
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
  }, [demoMode, demoRunning, demoSessionVersion]);

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
    // Mobile browsers paint their toolbars in the page theme colour, so tracking the active
    // theme keeps the chrome above and below the app from staying light while the panel is
    // dark. The document ships one tag per system appearance and only the matching one is
    // read, so both are written with the colour the app actually resolved to.
    const themeColors = Array.from(document.querySelectorAll('meta[name="theme-color"]'));
    const previousThemeColors = themeColors.map((meta) => meta.getAttribute("content"));
    const surface = getComputedStyle(root).getPropertyValue("--surface").trim();
    if (surface) for (const meta of themeColors) meta.setAttribute("content", surface);
    return () => {
      root.classList.remove(...classes);
      themeColors.forEach((meta, index) => {
        const previous = previousThemeColors[index];
        if (previous !== null) meta.setAttribute("content", previous);
      });
    };
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
    if (demoMode && activeServer.id === demoServerId) return demoFixtures().demoTimelineData(demoRunning, demoSchedules, from, to);
    return api<ServerTimelineResponse>(`/api/servers/${activeServer.id}/timeline?from=${Math.round(from)}&to=${Math.round(to)}&maxPoints=${maxPoints}`);
  }, [activeServer?.id, demoMode, demoRunning, demoSchedules, demoSessionVersion]);
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
  const nodesWorkspace = useNodesWorkspace({
    contextNodes,
    panelVersion,
    panelBuildId,
    demoMode,
    canManageNodes: canManageUsers,
    currentPanelUrl,
    notify,
    requestConfirmation,
    refreshApp
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
  const panelTimeZone = effectiveAppState.timeZone || "UTC";
  const {
    browserTimeZone,
    displayTimeZone,
    dateTimeFormatter,
    formatDisplayDate,
    formatDisplayTime,
    formatDisplayShortTime,
    formatDisplayNumber
  } = useDisplayFormatters({ regionalFormatPreference, displayTimeZonePreference, panelTimeZone });

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

  useEffect(() => {
    void refreshAuth();
  }, []);

  useEffect(() => {
    if (!authSession?.authenticated) return;
    if (activePage === "overview" && !overviewTimelineVisible) return;
    void preloadActivePage(activePage);
  }, [activePage, authSession?.authenticated, overviewTimelineVisible]);

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
      if (logFlushFrameRef.current !== null) {
        window.cancelAnimationFrame(logFlushFrameRef.current);
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
    nodesWorkspace.resetAddNode();
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
        [demoServerId]: demoFixtures().demoPlayerSnapshot(demoRunning)
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
  }, [activePage, demoMode, demoRunning, demoSessionVersion]);

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

  useEffect(() => {
    if (!authSession || (!authSession.authenticated && !demoMode)) return;
    refreshApp();
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
      discardQueuedConsoleLines();
      logsRef.current = [];
      setLogs([]);
      setConsoleSnapshotReadyServerId("");
      setStatusError("");
      setConsoleError("");
      setConsoleConnectionState("connecting");
      consoleReconnectAttemptRef.current = 0;
      if (consoleReconnectNoticeTimeoutRef.current !== null) {
        window.clearTimeout(consoleReconnectNoticeTimeoutRef.current);
        consoleReconnectNoticeTimeoutRef.current = null;
      }
      setOverviewData({ events: [], activity: {} });
      setTimelineLatestSample(undefined);
    }
    if (demoMode && activeServer.id === demoServerId) {
      setStatus(demoFixtures().demoStatus(activeServer, demoRunning));
      const demoLogs = demoFixtures().demoConsoleMessages().map(consoleLine);
      logsRef.current = demoLogs;
      setLogs(demoLogs);
      setConsoleSnapshotReadyServerId(activeServer.id);
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
      setConsoleSnapshotReadyServerId(activeServer.id);
      filesWorkspace.actions.setListing({ path: "/", entries: [] });
      return;
    }
    void refreshStatus(activeServer.id);
    if (activePage !== "console") {
      setConsoleLoading(false);
      return;
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
    let reconnectScheduled = false;
    let allowReconnect = true;
    let pollingAvailable = false;
    let pollingInFlight = false;
    let pollingInterval: number | null = null;
    let snapshotReady = false;
    let replayGuard: ConsoleReplayGuard | null = null;
    let initialStreamLines: string[] = [];
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/console?serverId=${encodeURIComponent(serverId)}`);

    void refreshConsoleLogs(serverId).finally(() => {
      if (closedByCleanup || activeServerIdRef.current !== serverId) return;
      replayGuard = new ConsoleReplayGuard(logsRef.current);
      snapshotReady = true;
      const liveLines = replayGuard.push(initialStreamLines);
      initialStreamLines = [];
      queueConsoleLines(liveLines);
    });

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
        const lines = consoleLineAssemblerRef.current.push(message.text ?? "");
        if (snapshotReady) {
          queueConsoleLines(replayGuard?.push(lines) ?? lines);
        } else {
          initialStreamLines.push(...lines);
          const overflow = initialStreamLines.length - consoleScrollbackRef.current;
          if (overflow > 0) initialStreamLines.splice(0, overflow);
        }
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
      discardQueuedConsoleLines();
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
    writeStoredActivePage(activePage);
  }, [activePage]);

  useEffect(() => {
    if (activePage !== "settings" || demoMode || !authSession?.authenticated) return;
    void refreshApp({ silent: true });
  }, [activePage, demoMode, authSession?.authenticated]);

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
      setOverviewData(demoFixtures().demoOverviewData(demoRunning));
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
  }, [activeServer?.id, activeNodeRuntimeBlocked, activePage, demoMode, demoRunning, demoSessionVersion, refreshOverviewData]);

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

  async function refreshOverviewModUpdates() {
    if (overviewModRefreshInFlightRef.current) return;
    overviewModRefreshInFlightRef.current = true;
    const toastId = `overview-mod-update-check:${activeServer?.id ?? "current"}`;
    toast.loading("Checking for updates", {
      id: toastId,
      duration: Infinity,
      dismissible: false
    });
    try {
      const updatePlan = await modsWorkspace.actions.refresh(true, false);
      if (!updatePlan) {
        toast.error(`Could not check ${managedContent.singular} updates`, {
          id: toastId,
          duration: 7000,
          closeButton: true,
          dismissible: true
        });
        return;
      }
      toast.success(modUpdateRefreshResultMessage(updatePlan, managedContent.plural), {
        id: toastId,
        duration: 5000,
        closeButton: true,
        dismissible: true
      });
    } catch (error) {
      toast.error(`Could not check ${managedContent.singular} updates`, {
        id: toastId,
        description: errorMessage(error, `Could not check ${managedContent.singular} updates.`),
        duration: 7000,
        closeButton: true,
        dismissible: true
      });
    } finally {
      overviewModRefreshInFlightRef.current = false;
    }
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
    setTimelineLatestSample(undefined);
    setConsoleError("");
    filesWorkspace.actions.setFilesError("");
    consoleLogServerIdRef.current = "";
    setConsoleSnapshotReadyServerId("");
    setLogs([]);
    filesWorkspace.actions.clearWorkspace();
    notify("warning", "You were logged out because the panel restarted and the loaded state is no longer current. Sign in again to continue.");
    return true;
  }

  async function refreshAuth() {
    try {
      const session = await api<AuthSession>("/api/auth/session");
      const nextDemoMode = Boolean(session.authenticated && session.demo);
      // The fixture chunk must be resolved before demoMode goes true, so that
      // every synchronous demoFixtures() reader below is safe.
      if (nextDemoMode) await loadDemoFixtures();
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
        await loadDemoFixtures();
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
    consoleLogServerIdRef.current = "";
    setConsoleSnapshotReadyServerId("");
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
        setStatus(demoFixtures().demoStatus(demoFixtures().demoServer(demoSchedules), demoRunning));
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

  /**
   * A chatty server emits log frames far faster than the screen refreshes, and one state update
   * per frame means one full re-render and one terminal write per line. Collecting the lines and
   * flushing them once per animation frame keeps a burst to a single render and a single write.
   */
  function queueConsoleLines(lines: string[]) {
    pendingLogLinesRef.current.push(...lines);
    // A background tab never runs animation frames, so cap what can pile up at the same limit
    // the buffer would enforce on flush anyway.
    const overflow = pendingLogLinesRef.current.length - consoleScrollbackRef.current;
    if (overflow > 0) pendingLogLinesRef.current.splice(0, overflow);
    if (logFlushFrameRef.current !== null) return;
    logFlushFrameRef.current = window.requestAnimationFrame(flushQueuedConsoleLines);
  }

  function flushQueuedConsoleLines() {
    logFlushFrameRef.current = null;
    const pending = pendingLogLinesRef.current;
    if (!pending.length) return;
    pendingLogLinesRef.current = [];
    const next = appendConsoleEntries(logsRef.current, pending, consoleScrollbackRef.current);
    logsRef.current = next;
    setLogs(next);
  }

  function discardQueuedConsoleLines() {
    pendingLogLinesRef.current = [];
    consoleLineAssemblerRef.current.reset();
    if (logFlushFrameRef.current === null) return;
    window.cancelAnimationFrame(logFlushFrameRef.current);
    logFlushFrameRef.current = null;
  }

  async function refreshConsoleLogs(serverId = activeServer?.id): Promise<boolean> {
    if (!serverId) return false;
    if (demoMode && serverId === demoServerId) {
      if (activeServerIdRef.current === serverId) {
        setLogs((current) => current.length ? current : [
          consoleLine("[demo] Starting minecraft server version 1.21.4"),
          consoleLine("[demo] Done (5.132s)! For help, type \"help\"")
        ]);
        setConsoleSnapshotReadyServerId(serverId);
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
      const reconciled = reconcileConsoleSnapshot(startLogs, nextLogs, logsRef.current, limit);
      logsRef.current = reconciled;
      setLogs(reconciled);
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
      if (activeServerIdRef.current === serverId) {
        setConsoleLoading(false);
        setConsoleSnapshotReadyServerId(serverId);
      }
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

  async function updatePlayerHeads(enabled: boolean, onboarding = false) {
    if (!canManageIntegrations || playerHeadsBusy) return;
    setPlayerHeadsBusy(true);
    if (onboarding) setPlayerHeadsOnboardingError("");
    try {
      const result = await api<{ playerHeads: AppState["playerHeads"] }>("/api/settings/player-heads", {
        method: "PUT",
        body: JSON.stringify({ enabled })
      });
      setAppState((current) => ({ ...current, playerHeads: result.playerHeads }));
      setPlayerHeadsOnboardingError("");
      notify("success", enabled ? "Player heads enabled" : "Player heads disabled");
    } catch (error) {
      const message = (error as Error).message;
      if (onboarding) setPlayerHeadsOnboardingError(message);
      else notify("error", message);
    } finally {
      setPlayerHeadsBusy(false);
    }
  }

  async function clearPlayerHeadCache() {
    if (!canManageIntegrations || playerHeadsBusy || effectiveAppState.playerHeads.cacheEntries === 0) return;
    const confirmed = await requestConfirmation({
      title: "Clear cached player heads?",
      description: "This removes every player-head image cached by this instance.",
      warning: effectiveAppState.playerHeads.enabled
        ? "Player heads are enabled, so images will be downloaded again as players appear on Overview."
        : "The integration remains disabled and no new images will be requested.",
      confirmLabel: "Clear cache",
      cancelLabel: "Keep cache",
      variant: "critical"
    });
    if (!confirmed) return;
    setPlayerHeadsBusy(true);
    try {
      const result = await api<{ playerHeads: AppState["playerHeads"] }>("/api/settings/player-heads/cache", { method: "DELETE" });
      setAppState((current) => ({ ...current, playerHeads: result.playerHeads }));
      notify("success", "Player head cache cleared");
    } catch (error) {
      notify("error", (error as Error).message);
    } finally {
      setPlayerHeadsBusy(false);
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

  async function runContainerAction(action: "start" | "stop" | "restart", options: { announceRequest?: boolean; skipConfirmation?: boolean } = {}) {
    if (isProvisioning || dockerOperationalLock || !canBasic) return;
    if (!activeServer) return;
    const playersOnlineConfirmation = options.skipConfirmation
      ? null
      : runtimeActionConfirmation(action, activeServer.displayName, playerSnapshots[activeServer.id]);
    if (playersOnlineConfirmation && !(await requestConfirmation(playersOnlineConfirmation))) return;
    setNotice("");
    setRuntimeAction(action);
    const actionLabel = action === "start" ? "Start" : action === "stop" ? "Stop" : "Restart";
    const completedLabel = action === "start" ? "started" : action === "stop" ? "stopped" : "restarted";
    if (options.announceRequest !== false) notify("info", `${actionLabel} request sent`);
    try {
      if (activeServerIsDemo) {
        const nextRunning = action !== "stop";
        if (nextRunning) {
          demoFixtures().resetDemoSession();
          setDemoSessionVersion((version) => version + 1);
        }
        setDemoRunning(nextRunning);
        setStatus(demoFixtures().demoStatus(activeServer, nextRunning));
        setOverviewData(demoFixtures().demoOverviewData(nextRunning));
        setPlayerSnapshots((current) => ({
          ...current,
          [demoServerId]: demoFixtures().demoPlayerSnapshot(nextRunning)
        }));
        setLogs((current) => [
          ...(nextRunning ? demoFixtures().demoConsoleMessages().map(consoleLine) : current),
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
        const snapshot = demoFixtures().demoPlayerSnapshot(true);
        const response = command === "list"
          ? `There are ${snapshot.online} of a max of ${snapshot.maxPlayers} players online: ${snapshot.names.join(", ")}`
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
      : nodesWorkspace.busyNodeId
        ? "A node action is already in progress."
        : !canManageUsers
          ? "Manage users permission is required."
          : "Add a remote node";

  function openAddNodeFromEmptyState() {
    setActivePage("nodes");
    if (canManageUsers) nodesWorkspace.onOpenAddNode();
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
            disabled={demoMode || isProvisioning || nodesWorkspace.busy || !canManageUsers}
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
        <AppSidebar
          sidebarCollapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
          sidebarToggleRef={sidebarToggleRef}
          activePage={activePage}
          onNavigate={openSidebarPage}
          servers={effectiveAppState.servers}
          activeServer={activeServer}
          onSelectServer={openServerFromNode}
          serverCommandTone={serverCommandTone}
          isProvisioning={isProvisioning}
          provisioningNavigationReason={provisioningNavigationReason}
          serverPageDisabledReason={serverPageDisabledReason}
          supportsManagedMods={supportsManagedMods}
          managedContent={managedContent}
          demoMode={demoMode}
          panelVersion={panelVersion}
          accountName={authSession.user?.username}
          onLogout={logout}
        />

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
          <Banner
            tone="error"
            title="Docker integration is not connected."
            message="Local server controls are paused. Connect Docker in Settings, or add a remote node that is online and ready."
          />
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

        {notice && activePage !== "files" && <Banner tone="info" title={notice} />}

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
                totalMemory={effectiveAppState.totalMemory}
                provisioning={isProvisioning || !canCreateServers}
                disabledReason={isProvisioning ? provisioningNavigationReason : !canCreateServers ? "Create servers permission is required." : ""}
                onRefreshNodes={nodesWorkspace.refreshNodes}
                onSubmit={createServer}
              />
            </Suspense>
          </section>
        )}

        {activePage === "settings" && (
          <Suspense fallback={<FeaturePageLoadingSkeleton label="Loading settings" page="settings" />}>
          <SettingsPage
            loading={settingsDataLoading}
            themePreference={themePreference}
            relativeTimestamps={relativeTimestamps}
            regionalFormatPreference={regionalFormatPreference}
            displayTimeZonePreference={displayTimeZonePreference}
            panelTimeZone={panelTimeZone}
            browserTimeZone={browserTimeZone}
            displayTimeZone={displayTimeZone}
            onThemeChange={setThemePreference}
            onRelativeTimestampsChange={setRelativeTimestamps}
            onRegionalFormatChange={setRegionalFormatPreference}
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
            playerHeads={effectiveAppState.playerHeads}
            playerHeadsBusy={playerHeadsBusy}
            onPlayerHeadsEnabledChange={(enabled) => void updatePlayerHeads(enabled)}
            onClearPlayerHeadCache={() => void clearPlayerHeadCache()}
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
          </Suspense>
        )}

        {activePage === "nodes" && (
          <Suspense fallback={<FeaturePageLoadingSkeleton label="Loading nodes" page="nodes" />}>
            <NodesPage
              {...nodesWorkspace}
              nodes={contextNodes}
              panelVersion={panelVersion}
              panelBuildId={panelBuildId}
              canManageNodes={canManageUsers}
              browserPanelUrl={currentPanelUrl()}
              nodeUpdateGraceMs={nodeUpdateGraceMs}
              onSelectServer={openServerFromNode}
              onAddServer={openCreateServerForNode}
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
            <ActiveServerStrip
              server={activeServer}
              runtimeAction={runtimeAction}
              runtimeFeedbackAction={runtimeFeedbackAction}
              serverCommandTone={serverCommandTone}
              lastKnownRuntimeLabel={lastKnownRuntimeLabel}
              health={serverStripHealth}
              healthDetail={consoleError || statusError || ""}
              alert={serverStripAlert}
              nodeName={activeNode.name}
              runtimeDisplayName={activeRuntimeDefinition?.displayName ?? "Runtime"}
              runtimeVersion={activeServer.runtimeProfile.runtimeVersion}
              minecraftVersion={activeMinecraftVersion}
              nodeOffline={confirmedNodeOffline}
              status={activeStatus}
              controlAvailableFallback={activeServerDockerSocketMounted && activeServer.hasDockerContainer}
              controlsDisabled={isProvisioning || !canBasic || dockerOperationalLock}
              controlsDisabledReason={runtimeControlsDisabledReason}
              onRuntimeAction={runContainerAction}
              consoleActive={activePage === "console"}
              onOpenConsole={() => setActivePage("console")}
              onRetryConnection={() => { void retryActiveConnection(); }}
              refreshDisabled={isProvisioning}
              refreshDisabledReason={provisioningNavigationReason}
            />

            {activePage === "overview" && (
              <ServerOverviewTab
                server={activeServer}
                status={activeStatus}
                dockerSocketMounted={activeServerDockerSocketMounted}
                overviewData={overviewData}
                overviewError={overviewError}
                overviewLoading={overviewLoading}
                overviewInitialLoading={overviewInitialLoading}
                onRetryOverview={() => { void refreshOverviewData(activeServer.id, { showLoading: true }); }}
                timelineVisible={overviewTimelineVisible}
                timelineLatestSample={timelineLatestSample}
                onTimelineLatestSample={setTimelineLatestSample}
                loadTimeline={loadActiveTimeline}
                playerSnapshot={playerSnapshots[activeServer.id]}
                playerHeadsEnabled={effectiveAppState.playerHeads.enabled}
                modUpdatePlan={modsWorkspace.data.updatePlan}
                modUpdatePlanLoading={modsWorkspace.state.updatePlanLoading}
                canViewMods={canViewMods && supportsManagedMods}
                onOpenMods={() => setActivePage("mods")}
                onRefreshModUpdates={() => void refreshOverviewModUpdates()}
                managedContent={managedContent}
                canViewSchedules={canViewSchedules}
                onOpenSchedules={(target) => {
                  setScheduleNavigationTarget(target ?? null);
                  setActivePage("schedule");
                }}
                onOpenConsole={() => setActivePage("console")}
                requestConfirmation={requestConfirmation}
                relativeTimestamps={relativeTimestamps}
                formatDate={formatDisplayDate}
                formatTime={formatDisplayTime}
                formatShortTime={formatDisplayShortTime}
              />
            )}

            {activePage === "console" && (
              <section className="tabPage layoutWide">
                <Surface className="consolePanel">
                  <div className="terminal">
                    {consoleSnapshotReadyServerId !== activeServer.id ? (
                      <TerminalLoadingSkeleton />
                    ) : (
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
                    )}
                  </div>
                </Surface>
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
              <section className="tabPage settingsPage layoutWide">
                <Suspense fallback={<FeaturePageLoadingSkeleton label="Loading server properties" page="properties" />}>
                  <ServerEditForm
                    server={activeServer}
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
      {appStateLoaded && !demoMode && canManageIntegrations && appState.playerHeads.onboardingRequired ? (
        <PlayerHeadsOnboarding
          busy={playerHeadsBusy}
          error={playerHeadsOnboardingError}
          onChoose={(enabled) => void updatePlayerHeads(enabled, true)}
        />
      ) : null}
    </>
  );
}
