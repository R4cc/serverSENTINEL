import { ChangeEvent, FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "./api";
import { demoListing, demoOverviewData, demoSearchResults, demoServer, demoServerId, demoStats, demoStatus } from "./demo";
import type { ActivePage, AppState, AuthSession, ContextNode, CreateNodeResponse, FabricVersions, FileEntry, FileListing, FilePreview, InstalledMod, LocalePreference, ManagedNode, ManagedServer, ModrinthHit, ModrinthInstallVersion, ModrinthInstallVersionsResponse, NodeInstallResponse, NodeUpdateResponse, Notice, PermissionKey, ProvisionJob, PublicUser, ReleaseChannel, ResourceSample, ResourceStats, ScheduledExecution, ServerActivity, ServerOverviewData, ServerStatus, ThemePreference, GeneralJob } from "./types";
import { bufferToBase64, clientId, fileDisplayType, fileStatusLabel, isEditableFile, isPreviewableFile, joinPublicPath, parentPath } from "./utils/files";
import { compatibilityClass, compatibilityLabel, formatBytes, minecraftVersionInfo, resourcePollMs, runtimeLabel, runtimeTone, versionValue } from "./utils/format";
import { hasPermission, normalizePermissions } from "./utils/permissions";
import { trimFormValue, validateCommandList, validateCronExpression, validateJarFilename, validatePassword, validateSafePath, validateUsername } from "./utils/validation";
import { minecraftCommandSuggestions } from "./utils/commands";
import { isNodeRuntimeUsable } from "./utils/nodes";
import { appVersion, defaultNodeDataPath, emptyApp, isServerWorkspacePage } from "./app/appConfig";
import { usePreferencesState } from "./app/appState";
import { useServerContext } from "./app/serverContext";
import type { FilePreviewState, FileSortKey, ModInstallModalState } from "./app/uiState";
import { clearDeletedFileState, defaultDuplicateName, errorMessage, fileNameValidation, hasPotentialEvent, modIconSource, publicPathContains, readCommandHistory, serverConfigValidation, setValidationNotice } from "./utils/appHelpers";
import { AuthPanel, UserManagement } from "./components/AuthPanel";
import { ConsoleLog } from "./components/ConsoleLog";
import { AppIcon, FileTypeIcon, SidebarIcon, SidebarToggleIcon } from "./components/FileTypeIcon";
import { FileEditorModal } from "./components/FileEditorModal";
import { InlineState } from "./components/InlineState";
import { ModInstallVersionSkeleton } from "./components/ModInstallVersionSkeleton";
import { Notifications } from "./components/Notifications";
import { ResourcePanel } from "./components/ResourcePanel";
import { RuntimeControls } from "./components/RuntimeControls";
import { ModrinthKeyForm } from "./components/SettingsPanels";
import { ActivityHealthPanel, OverviewSummary, RecentEventsPanel } from "./pages/OverviewPage";
import { SchedulePage } from "./pages/SchedulesPage";
import { NodesPage } from "./pages/NodesPage";
import { DeleteServerPanel, ManagedServerForm, ServerEditForm } from "./pages/ServerSettingsPage";

function consoleLine(text: string) {
  return `${text}\n`;
}

const modSearchDebounceMs = 650;
const provisionJobPollMs = 1_500;
const serverStatusPollMs = 10_000;

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
  const [listing, setListing] = useState<FileListing>({ path: "/", entries: [] });
  const [selectedFilePaths, setSelectedFilePaths] = useState<string[]>([]);
  const [fileBackStack, setFileBackStack] = useState<string[]>([]);
  const [fileForwardStack, setFileForwardStack] = useState<string[]>([]);
  const [fileSort, setFileSort] = useState<{ key: FileSortKey; direction: "asc" | "desc" }>({ key: "name", direction: "asc" });
  const [filePreview, setFilePreview] = useState<FilePreviewState>({ path: "", loading: false, data: null, error: "" });
  const [fileOperationBusy, setFileOperationBusy] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [editorText, setEditorText] = useState("");
  const [savedEditorText, setSavedEditorText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedModSearchQuery, setDebouncedModSearchQuery] = useState("");
  const [modSearchRequestVersion, setModSearchRequestVersion] = useState(0);
  const [modSearchResults, setModSearchResults] = useState<ModrinthHit[]>([]);
  const [isSearchingMods, setIsSearchingMods] = useState(false);
  const [modSearchError, setModSearchError] = useState("");
  const [modSearchTotal, setModSearchTotal] = useState(0);
  const [isLoadingMoreMods, setIsLoadingMoreMods] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [modInstallModal, setModInstallModal] = useState<ModInstallModalState | null>(null);
  const [installedMods, setInstalledMods] = useState<InstalledMod[]>([]);
  const [modsView, setModsView] = useState<"manager" | "search">("manager");
  const [installedQuery, setInstalledQuery] = useState("");
  const [detailsMod, setDetailsMod] = useState<InstalledMod | null>(null);
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
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState("");
  const [fileReadError, setFileReadError] = useState("");
  const [fileOpenFailed, setFileOpenFailed] = useState(false);
  const [fileOpening, setFileOpening] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);
  const [modsLoading, setModsLoading] = useState(false);
  const [modsError, setModsError] = useState("");
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState("");
  const [userSaving, setUserSaving] = useState(false);
  const [commandInput, setCommandInput] = useState("");
  const [commandSending, setCommandSending] = useState(false);
  const [commandInputFocused, setCommandInputFocused] = useState(false);
  const [consolePinnedToBottom, setConsolePinnedToBottom] = useState(true);
  const [pendingConsoleEntries, setPendingConsoleEntries] = useState(0);
  const [commandHistory, setCommandHistory] = useState<string[]>(() => readCommandHistory());
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [fabricVersions, setFabricVersions] = useState<FabricVersions>({ game: [], loader: [], installer: [] });
  const [notice, setNotice] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [activeJobs, setActiveJobs] = useState<GeneralJob[]>([]);
  const [provisioningError, setProvisioningError] = useState("");
  const [provisioningErrorDetails, setProvisioningErrorDetails] = useState("");
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [serverSettingsSaving, setServerSettingsSaving] = useState(false);
  const [consoleStreamVersion, setConsoleStreamVersion] = useState(0);
  const [runtimeAction, setRuntimeAction] = useState<"start" | "stop" | "restart" | null>(null);
  const [activePage, setActivePage] = useState<ActivePage>("overview");
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [nodeBusyId, setNodeBusyId] = useState("");
  const [nodeDetails, setNodeDetails] = useState<ManagedNode | null>(null);
  const [nodeInstallResult, setNodeInstallResult] = useState<NodeInstallResponse | CreateNodeResponse | null>(null);
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [addNodeResult, setAddNodeResult] = useState<CreateNodeResponse | null>(null);
  const [nodeInstallMethod, setNodeInstallMethod] = useState<"compose" | "run">("run");
  const [discardEditorRequest, setDiscardEditorRequest] = useState<{ action: "close" } | { action: "switch"; path: string } | null>(null);
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
  const consoleRef = useRef<HTMLDivElement>(null);
  const previousLogCountRef = useRef(0);
  const modUploadRef = useRef<HTMLInputElement>(null);
  const fileUploadRef = useRef<HTMLInputElement>(null);
  const fileSelectAllRef = useRef<HTMLInputElement>(null);
  const activeServerIdRef = useRef("");
  const panelFirstRunPromptedRef = useRef(false);
  const provisionSubmitLockRef = useRef(false);
  const appRefreshInFlightRef = useRef(false);
  const statusRefreshInFlightRef = useRef<Set<string>>(new Set());
  const loadMoreModsInFlightRef = useRef(false);
  const consoleReconnectTimeoutRef = useRef<number | null>(null);
  const consoleCommandRefreshTimeoutRef = useRef<number | null>(null);
  const modToggleStateQueueRef = useRef<Record<string, {
    targetEnabled: boolean;
    inFlightEnabled: boolean | null;
  }>>({});

  const overviewRefreshTimeoutRef = useRef<number | null>(null);
  const staleSessionLogoutRef = useRef(false);

  const triggerOverviewRefresh = useCallback((serverId: string) => {
    if (demoMode && serverId === demoServerId) {
      setOverviewData(demoOverviewData(demoRunning));
      return;
    }
    if (overviewRefreshTimeoutRef.current !== null) {
      window.clearTimeout(overviewRefreshTimeoutRef.current);
    }
    overviewRefreshTimeoutRef.current = window.setTimeout(async () => {
      overviewRefreshTimeoutRef.current = null;
      try {
        const data = await api<ServerOverviewData>(`/api/servers/${serverId}/events`);
        setOverviewData(data);
        setServerActivities((current) => ({ ...current, [serverId]: data.activity }));
        setOverviewError("");
      } catch (error) {
        if (handleStaleSession(error)) return;
        setOverviewError(errorMessage(error, "Could not load overview activity. Previously loaded data is preserved."));
      }
    }, 500);
  }, [demoMode, demoRunning]);

  const triggerOverviewRefreshRef = useRef(triggerOverviewRefresh);
  useEffect(() => {
    triggerOverviewRefreshRef.current = triggerOverviewRefresh;
  }, [triggerOverviewRefresh]);

  const darkMode = themePreference === "dark" || (themePreference === "system" && systemDark);
  const isProvisioning = activeJobs.some((job) => job.type === "provision" && job.status === "running");
  const currentProvisionJob = activeJobs.find((job) => job.type === "provision");
  const isAnyModJobRunning = activeJobs.some((job) => (job.type === "mod-install" || job.type === "mod-upload") && job.status === "running");
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
  const canManager = activeServerIsDemo || hasPermission(permissionUser, "servers.editSettings") || hasPermission(permissionUser, "files.edit") || hasPermission(permissionUser, "mods.install") || hasPermission(permissionUser, "schedules.manage");
  const canCreateServers = !demoMode && hasPermission(permissionUser, "servers.create");
  const canManageIntegrations = !demoMode && hasPermission(permissionUser, "integrations.manage");
  const canViewUsers = hasPermission(permissionUser, "users.view");
  const canManageUsers = hasPermission(permissionUser, "users.manage");
  const canAdmin = canViewUsers;
  const authOperationalLock = !demoMode && !authSession?.authenticated;
  const dockerOperationalLock = authOperationalLock || activeNodeRuntimeBlocked || (activeServerUsesInternalNode && !effectiveAppState.dockerSocketMounted);
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
  const serverSettingsLocked = isProvisioning || dockerOperationalLock || !canManager || Boolean(activeStatus?.docker.running);
  const modServerRunning = Boolean(activeStatus?.docker.running);
  const modsLocked = isProvisioning || dockerOperationalLock || !canManager || !activeStatus || isAnyModJobRunning;
  const modToggleLocked = isProvisioning || dockerOperationalLock || !canManager || !activeStatus || isAnyModJobRunning;
  const scheduleDisabledReason = scheduleBusy
    ? "Schedule changes are still saving."
    : isProvisioning
      ? "Server setup is still running."
      : !canExpanded
        ? "Console command permission is required."
        : dockerOperationalLock
          ? runtimeControlsDisabledReason || "Server runtime is unavailable."
          : "";
  const consoleCommandDisabledReason = commandSending
    ? "Command is already being sent."
    : isProvisioning
      ? "Server setup is still running."
      : dockerOperationalLock
        ? runtimeControlsDisabledReason || "Server runtime is unavailable."
        : !canExpanded
          ? "Console command permission is required."
          : !activeStatus?.commandInputAvailable
            ? activeStatus?.commandInputMessage || "Console command input is unavailable."
            : !commandInput.trim()
              ? "Enter a command to send."
              : "";
  const selectedEntries = useMemo(() => {
    const selected = new Set(selectedFilePaths);
    return listing.entries.filter((entry) => selected.has(entry.path));
  }, [listing.entries, selectedFilePaths]);
  const selectedEntry = selectedEntries.length === 1 ? selectedEntries[0] : null;
  const selectedTotalSize = selectedEntries.reduce((total, entry) => total + (entry.type === "file" ? entry.size : 0), 0);
  const sortedFileEntries = useMemo(() => {
    const direction = fileSort.direction === "asc" ? 1 : -1;
    return [...listing.entries].sort((a, b) => {
      const folderOrder = Number(b.type === "directory") - Number(a.type === "directory");
      if (folderOrder !== 0) return folderOrder;
      let result = 0;
      if (fileSort.key === "name") result = a.name.localeCompare(b.name);
      if (fileSort.key === "modifiedAt") result = new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime();
      if (fileSort.key === "type") result = fileDisplayType(a).localeCompare(fileDisplayType(b));
      if (fileSort.key === "size") result = a.size - b.size;
      return result === 0 ? a.name.localeCompare(b.name) : result * direction;
    });
  }, [fileSort, listing.entries]);
  const visibleFilePaths = useMemo(() => sortedFileEntries.map((entry) => entry.path), [sortedFileEntries]);
  const visibleSelectedCount = visibleFilePaths.filter((path) => selectedFilePaths.includes(path)).length;
  const allVisibleFilesSelected = visibleFilePaths.length > 0 && visibleSelectedCount === visibleFilePaths.length;
  const someVisibleFilesSelected = visibleSelectedCount > 0 && visibleSelectedCount < visibleFilePaths.length;
  const selectionSummary = selectedEntries.length === 0
    ? "No selection"
    : `${selectedEntries.length} ${selectedEntries.length === 1 ? "item" : "items"} selected${selectedTotalSize > 0 ? ` - ${formatBytes(selectedTotalSize)}` : ""}`;
  const fileRuntimeLocked = isProvisioning || dockerOperationalLock;
  const canEditSelectedFile = Boolean(selectedEntry && selectedEntry.type === "file" && isEditableFile(selectedEntry) && canManager && !fileRuntimeLocked);
  const canDownloadSelectedFile = Boolean(selectedEntry && selectedEntry.type === "file" && !fileRuntimeLocked && !fileOperationBusy);
  const canDuplicateSelectedFile = Boolean(selectedEntry && selectedEntry.type === "file" && canManager && !fileRuntimeLocked && !fileOperationBusy);
  const canRenameSelectedItem = Boolean(selectedEntry && canManager && !fileRuntimeLocked && !fileOperationBusy);
  const canDeleteSelectedItems = Boolean(selectedEntries.length > 0 && canManager && !fileRuntimeLocked && !fileOperationBusy);
  const fileActionBlockedReason = isProvisioning
    ? "Server setup is still running."
    : dockerOperationalLock
      ? runtimeControlsDisabledReason || "Server files are unavailable until the runtime reconnects."
      : fileOperationBusy
        ? "A file operation is already running."
        : !canManager
          ? "Manager permission is required."
          : "";
  const fileReadActionBlockedReason = isProvisioning
    ? "Server setup is still running."
    : dockerOperationalLock
      ? runtimeControlsDisabledReason || "Server files are unavailable until the runtime reconnects."
      : fileOperationBusy
        ? "A file operation is already running."
        : "";
  const fileBreadcrumbs = useMemo(() => {
    const parts = listing.path.split("/").filter(Boolean);
    return [
      { label: "/", path: "/" },
      ...parts.map((part, index) => ({ label: part, path: `/${parts.slice(0, index + 1).join("/")}` }))
    ];
  }, [listing.path]);
  const commandSuggestions = useMemo(() => {
    const value = commandInput.trimStart().toLowerCase().replace(/^\//, "");
    const matches = value
      ? minecraftCommandSuggestions.filter((suggestion) => suggestion.command.toLowerCase().startsWith(value))
      : minecraftCommandSuggestions.slice(0, 8);
    return matches.slice(0, 8);
  }, [commandInput]);

  const filteredInstalledMods = useMemo(() => {
    return installedMods.filter(mod => {
      return mod.displayName.toLowerCase().includes(installedQuery.toLowerCase()) ||
             mod.filename.toLowerCase().includes(installedQuery.toLowerCase()) ||
             (mod.description || "").toLowerCase().includes(installedQuery.toLowerCase());
    });
  }, [installedMods, installedQuery]);
  const installedModrinthProjectIds = useMemo(() => {
    return new Set(installedMods.map((mod) => mod.modrinth?.projectId).filter(Boolean));
  }, [installedMods]);

  const selectedInstallVersion = useMemo(() => {
    if (!modInstallModal?.data || !modInstallModal.selectedVersionId) return null;
    return [...modInstallModal.data.compatibleVersions, ...modInstallModal.data.otherVersions]
      .find((version) => version.id === modInstallModal.selectedVersionId) ?? null;
  }, [modInstallModal?.data, modInstallModal?.selectedVersionId]);
  const selectedPendingRequiredDependencyCount = useMemo(() => {
    if (!activeServerUsesInternalNode) return 0;
    return selectedInstallVersion?.dependencies.filter((dependency) => (
      dependency.dependencyType === "required"
      && (!dependency.projectId || !installedModrinthProjectIds.has(dependency.projectId))
    )).length ?? 0;
  }, [activeServerUsesInternalNode, installedModrinthProjectIds, selectedInstallVersion]);
  const canContinueModInstall = Boolean(
    selectedInstallVersion
    && selectedInstallVersion.selectable
    && (
      selectedInstallVersion.compatible
      || (modInstallModal?.showOtherVersions && selectedInstallVersion.requiresMinecraftAcknowledgement && modInstallModal.acknowledgeMinecraftMismatch)
    )
  );

  useEffect(() => {
    if (fileSelectAllRef.current) {
      fileSelectAllRef.current.indeterminate = someVisibleFilesSelected;
    }
  }, [someVisibleFilesSelected, allVisibleFilesSelected, visibleFilePaths.length]);



  const resolvedDateLocale = dateLocalePreference === "user" ? undefined : dateLocalePreference;
  const resolvedNumberLocale = numberLocalePreference === "user" ? undefined : numberLocalePreference;

  const dateTimeFormatter = useMemo(() => new Intl.DateTimeFormat(resolvedDateLocale, { dateStyle: "medium", timeStyle: "short" }), [resolvedDateLocale]);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(resolvedNumberLocale), [resolvedNumberLocale]);

  useEffect(() => {
    if (!selectedEntry) {
      setFilePreview({ path: "", loading: false, data: null, error: "" });
      return;
    }
    if (selectedEntry.type === "directory") {
      setFilePreview({
        path: selectedEntry.path,
        loading: false,
        data: { path: selectedEntry.path, preview: "unsupported", message: "Preview unavailable" },
        error: ""
      });
      return;
    }
    void loadFilePreview(selectedEntry);
  }, [selectedEntry?.path, selectedEntry?.modifiedAt, selectedEntry?.size, activeServer?.id, demoFiles]);

  function formatDisplayDate(value: string | number | Date) {
    return dateTimeFormatter.format(new Date(value));
  }

  function formatDisplayNumber(value: number) {
    return numberFormatter.format(value);
  }

  function modCompatibilityNote(mod: ModrinthHit) {
    return mod.compatibility?.reason || "Compatibility could not be verified.";
  }

  function formatOptionalModDate(value?: string) {
    return value ? `Updated ${formatDisplayDate(value)}` : "";
  }

  function modSideSupportLabel(value?: string) {
    if (value === "required") return "Required";
    if (value === "optional") return "Supported";
    if (value === "unsupported") return "Unsupported";
    if (value === "unknown") return "Unknown";
    return "Unknown";
  }

  function formatVersionList(versions: string[]) {
    if (versions.length <= 2) return versions.join(", ") || "-";
    return `${versions.slice(0, 2).join(", ")} +${versions.length - 2}`;
  }

  function modInstallStatusClass(version: ModrinthInstallVersion) {
    if (version.status === "recommended" || version.status === "compatible") return "ok";
    if (version.status === "version_mismatch") return "warning";
    return "danger";
  }

  function releaseChannelLabel(channel?: ReleaseChannel) {
    if (channel === "alpha") return "Alpha";
    if (channel === "beta") return "Beta";
    return "Release";
  }

  function dependencyTypeLabel(value: string) {
    if (value === "required") return "Required";
    if (value === "optional") return "Optional";
    if (value === "incompatible") return "Incompatible";
    if (value === "embedded") return "Embedded";
    return value || "Dependency";
  }

  function dependencyInstallStatus(dependency: ModrinthInstallVersion["dependencies"][number]) {
    if (dependency.projectId && installedMods.some((mod) => mod.modrinth?.projectId === dependency.projectId)) {
      return "Already installed";
    }
    if (dependency.dependencyType === "required") return activeServerUsesInternalNode ? "Will install" : "Install separately";
    if (dependency.dependencyType === "optional") return "Optional";
    return "Informational";
  }

  function firstSelectableVersionId(data: ModrinthInstallVersionsResponse) {
    return data.compatibleVersions.find((version) => version.status === "recommended")?.id
      ?? data.compatibleVersions[0]?.id
      ?? "";
  }

  function hasVisibleInstallVersions(data: ModrinthInstallVersionsResponse) {
    return data.compatibleVersions.length > 0 || data.otherVersions.length > 0;
  }

  function nextReleaseChannel(channel: ReleaseChannel): ReleaseChannel | null {
    if (channel === "release") return "beta";
    if (channel === "beta") return "alpha";
    return null;
  }

  function demoInstallVersions(mod: ModrinthHit, channel: ReleaseChannel): ModrinthInstallVersionsResponse {
    const minecraftVersion = activeServer?.minecraftVersion || "1.21.1";
    const now = new Date().toISOString();
    return {
      project: {
        id: mod.project_id,
        title: mod.title,
        description: mod.description,
        iconUrl: mod.icon_url,
        clientSide: mod.client_side,
        serverSide: mod.server_side ?? "optional"
      },
      target: {
        serverId: activeServer?.id || demoServerId,
        serverName: activeServer?.displayName || "Demo Server",
        minecraftVersion,
        loader: "Fabric"
      },
      channel,
      compatibleVersions: [
        {
          id: `${mod.project_id}-demo-compatible`,
          versionNumber: mod.compatibility?.matchedVersionNumber || "1.0.0",
          releaseChannel: channel,
          publishedAt: now,
          minecraftVersions: [minecraftVersion],
          loaders: ["fabric"],
          file: { filename: `${mod.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.jar`, size: mod.compatibility?.file?.size ?? 1_048_576 },
          compatible: true,
          selectable: true,
          requiresMinecraftAcknowledgement: false,
          status: "recommended",
          statusLabel: "Recommended",
          reason: "Compatible Fabric server mod",
          dependencies: [
            {
              projectId: "fabric-api",
              dependencyType: "required",
              title: "Fabric API"
            }
          ]
        }
      ],
      otherVersions: [
        {
          id: `${mod.project_id}-demo-mismatch`,
          versionNumber: "0.9.0",
          releaseChannel: "release",
          publishedAt: now,
          minecraftVersions: ["1.20.1"],
          loaders: ["fabric"],
          file: { filename: `${mod.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-old.jar`, size: 900_000 },
          compatible: false,
          selectable: true,
          requiresMinecraftAcknowledgement: true,
          status: "version_mismatch",
          statusLabel: "Version mismatch",
          reason: `Not marked for Minecraft ${minecraftVersion}`,
          dependencies: []
        }
      ]
    };
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
      setListing({ path: "/", entries: [] });
      resetEditorState();
      void refreshApp();
    }
  }, [demoMode]);

  useEffect(() => {
    if (!activeServer) return;
    setActiveServerId(activeServer.id);
    setLogs([]);
    resetEditorState();
    setResourceSamples([]);
    setModSearchResults([]);
    setModsView("manager");
    if (demoMode && activeServer.id === demoServerId) {
      setStatus(demoStatus(activeServer, demoRunning));
      setLogs([
        consoleLine("[demo] Starting minecraft server version 1.21.4"),
        consoleLine("[demo] Loading Fabric Loader 0.16.10"),
        consoleLine("[demo] Preparing spawn area: 100%"),
        consoleLine("[demo] Done (5.132s)! For help, type \"help\"")
      ]);
      setListing(demoListing("/", demoFiles, demoInstalledMods));
      setInstalledMods(demoInstalledMods);
      return;
    }
    if (activeNodeRuntimeBlocked) {
      setStatus(null);
      setStatusError(activeNodeBlockMessage);
      setConsoleError(activeNodeBlockMessage);
      setFilesError(activeNodeBlockMessage);
      setModsError(activeNodeBlockMessage);
      setOverviewError(activeNodeBlockMessage);
      setOverviewLoading(false);
      setFilesLoading(false);
      setConsoleLoading(false);
      setModsLoading(false);
      setListing({ path: "/", entries: [] });
      setInstalledMods([]);
      return;
    }
    void refreshStatus(activeServer.id);
    void loadFiles(activeServer.id, "/");
    void loadInstalledMods(activeServer.id);

    if (consoleReconnectTimeoutRef.current !== null) {
      window.clearTimeout(consoleReconnectTimeoutRef.current);
      consoleReconnectTimeoutRef.current = null;
    }
    if (consoleCommandRefreshTimeoutRef.current !== null) {
      window.clearTimeout(consoleCommandRefreshTimeoutRef.current);
      consoleCommandRefreshTimeoutRef.current = null;
    }

    let closedByCleanup = false;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/console?serverId=${encodeURIComponent(activeServer.id)}`);
    socket.onopen = () => {
      if (activeServerIdRef.current === activeServer.id) {
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
        setLogs((current) => [...current.slice(-499), `[${message.source ?? "console"}] ${message.text ?? ""}`]);
        if (message.text && hasPotentialEvent(message.text) && activeServerIdRef.current) {
          triggerOverviewRefreshRef.current(activeServerIdRef.current);
        }
      }
      if (message.type === "unavailable") {
        setLogs([consoleLine(message.message ?? "Console stream is unavailable.")]);
      }
      if (message.type === "empty") {
        setLogs([]);
      }
    };
    const reconnect = () => {
      if (closedByCleanup || activeServerIdRef.current !== activeServer.id) return;
      setConsoleError("Live console stream disconnected. Reconnecting automatically.");
      if (consoleReconnectTimeoutRef.current !== null) {
        window.clearTimeout(consoleReconnectTimeoutRef.current);
      }
      consoleReconnectTimeoutRef.current = window.setTimeout(() => {
        consoleReconnectTimeoutRef.current = null;
        if (activeServerIdRef.current === activeServer.id) {
          setConsoleStreamVersion((version) => version + 1);
        }
      }, 2_000);
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
    if (activePage !== "overview" && activePage !== "console") return;
    if (!consolePinnedToBottom) return;
    window.requestAnimationFrame(() => {
      consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
      setPendingConsoleEntries(0);
    });
  }, [logs, activePage]);

  useEffect(() => {
    if (activePage === "overview" || activePage === "console") {
      setConsolePinnedToBottom(true);
      window.requestAnimationFrame(() => {
        consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
        setPendingConsoleEntries(0);
      });
    }
  }, [activePage]);

  useEffect(() => {
    if (activePage === "mods") {
      setModsView("manager");
      setQuery("");
      setInstalledQuery("");
      setModSearchResults([]);
      setModSearchError("");
    }
  }, [activePage]);

  useEffect(() => {
    const previousCount = previousLogCountRef.current;
    const addedEntries = Math.max(0, logs.length - previousCount);
    previousLogCountRef.current = logs.length;
    if (!addedEntries) return;
    if (!consolePinnedToBottom && (activePage === "overview" || activePage === "console")) {
      setPendingConsoleEntries((current) => current + addedEntries);
    }
  }, [logs, activePage, consolePinnedToBottom]);

  function handleConsoleScroll() {
    const element = consoleRef.current;
    if (!element) return;
    const threshold = 24;
    const pinned = element.scrollTop + element.clientHeight >= element.scrollHeight - threshold;
    setConsolePinnedToBottom(pinned);
    if (pinned) {
      setPendingConsoleEntries(0);
    }
  }

  function jumpToLatestLogs() {
    const element = consoleRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    setConsolePinnedToBottom(true);
    setPendingConsoleEntries(0);
  }

  useEffect(() => {
    window.localStorage.setItem("serversentinel-command-history", JSON.stringify(commandHistory.slice(-50)));
  }, [commandHistory]);

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
    if (!activeServer || activeNodeRuntimeBlocked || (activePage !== "overview" && activePage !== "console")) return;
    if (demoMode && activeServer.id === demoServerId) {
      setResourceSamples([demoStats(demoRunning)]);
      const interval = window.setInterval(() => setResourceSamples((samples) => [...samples, demoStats(demoRunning)].slice(-48)), resourcePollMs);
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
        const stats = await api<ResourceStats>(`/api/servers/${serverId}/stats`);
        if (cancelled) return;
        setResourceSamples((samples) => [...samples, { ...stats, sampledAt: Date.now() }].slice(-48));
      } catch (error) {
        if (handleStaleSession(error)) return;
        if (!cancelled) {
          setResourceSamples((samples) => [...samples, {
            available: false,
            running: false,
            cpuPercent: 0,
            memoryUsageBytes: 0,
            memoryLimitBytes: 0,
            readAt: new Date().toISOString(),
            message: (error as Error).message || "Container stats are unavailable",
            sampledAt: Date.now()
          }].slice(-48));
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
  }, [activeServer?.id, activeNodeRuntimeBlocked, activePage, demoMode, demoRunning]);

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
      try {
        const data = await api<ServerOverviewData>(`/api/servers/${serverId}/events`);
        if (!cancelled) {
          setOverviewData(data);
          setServerActivities((current) => ({ ...current, [serverId]: data.activity }));
          setOverviewError("");
        }
      } catch (error) {
        if (handleStaleSession(error)) return;
        if (!cancelled) {
          setOverviewError(errorMessage(error, "Could not load overview activity. Previously loaded data is preserved."));
        }
      } finally {
        inFlight = false;
        if (!cancelled) setOverviewLoading(false);
      }
    }
    void loadOverviewData();
    const interval = window.setInterval(() => void loadOverviewData(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeServer?.id, activeNodeRuntimeBlocked, activePage, demoMode, demoRunning]);

  useEffect(() => {
    if (!activeServer || activeNodeRuntimeBlocked || activePage !== "mods" || modsView !== "search" || !effectiveAppState.modrinthApiConfigured) {
      setDebouncedModSearchQuery("");
      setIsSearchingMods(false);
      return;
    }
    const trimmedQuery = query.trim();
    setModInstallModal(null);
    setModSearchError("");
    if (!trimmedQuery) {
      setDebouncedModSearchQuery("");
      setModSearchResults([]);
      setModSearchTotal(0);
      setIsSearchingMods(false);
      return;
    }
    setIsSearchingMods(true);
    const timeout = window.setTimeout(() => {
      setDebouncedModSearchQuery(trimmedQuery);
    }, modSearchDebounceMs);
    return () => window.clearTimeout(timeout);
  }, [activeServer?.id, activeNodeRuntimeBlocked, activePage, effectiveAppState.modrinthApiConfigured, modsView, query]);

  useEffect(() => {
    if (!activeServer || activeNodeRuntimeBlocked || activePage !== "mods" || modsView !== "search" || !effectiveAppState.modrinthApiConfigured) return;
    const trimmedQuery = debouncedModSearchQuery.trim();
    if (!trimmedQuery) return;
    setModSearchResults([]);
    setModSearchTotal(0);
    if (activeServerIsDemo) {
      setIsSearchingMods(true);
      const timeout = window.setTimeout(() => {
        const value = trimmedQuery.toLowerCase();
        const baseFiltered = demoSearchResults.filter((mod) => (
          mod.title.toLowerCase().includes(value)
          || mod.description.toLowerCase().includes(value)
        ));
        const extraMods: ModrinthHit[] = [];
        if (value.length <= 3) {
          for (let i = 1; i <= 40; i++) {
            extraMods.push({
              project_id: `demo-dummy-${i}`,
              title: `Fabric Mod Helper ${i}`,
              description: `A generated dummy mod to showcase infinite scrolling in demo mode. Index ${i}.`,
              downloads: 100000 + i * 5000,
              date_modified: new Date().toISOString(),
              compatibility: {
                status: "compatible",
                compatible: true,
                reason: "Compatible server-side Fabric mod",
                serverSide: "optional",
                clientSide: "optional"
              },
              server_side: "optional",
              client_side: "optional"
            });
          }
        }
        const allFiltered = [...baseFiltered, ...extraMods];
        setModSearchResults(allFiltered.slice(0, 20));
        setModSearchTotal(allFiltered.length);
        setIsSearchingMods(false);
      }, 250);
      return () => {
        setIsSearchingMods(false);
        window.clearTimeout(timeout);
      };
    }
    let cancelled = false;
    const abortController = new AbortController();
    const serverId = activeServer.id;
    setIsSearchingMods(true);
    async function runSearch() {
      try {
        const result = await api<{ hits: ModrinthHit[]; total_hits: number }>(
          `/api/modrinth/search?query=${encodeURIComponent(trimmedQuery)}&serverId=${encodeURIComponent(serverId)}&channel=release`,
          { signal: abortController.signal }
        );
        if (!cancelled) {
          setModSearchResults(result.hits);
          setModSearchTotal(result.total_hits ?? 0);
        }
      } catch (error) {
        if (cancelled || abortController.signal.aborted) return;
        const message = errorMessage(error, "Could not search Modrinth. Check the API key and network availability.");
        setModSearchError(message);
        setNotice(message);
        notify("error", message);
      } finally {
        if (!cancelled) setIsSearchingMods(false);
      }
    }
    void runSearch();
    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [activeServer?.id, activeNodeRuntimeBlocked, activePage, effectiveAppState.modrinthApiConfigured, modsView, debouncedModSearchQuery, modSearchRequestVersion, activeServerIsDemo]);

  function notify(type: Notice["type"], text: string) {
    const id = Date.now() + Math.random();
    setNotices((current) => [...current, { id, type, text }]);
    window.setTimeout(() => {
      setNotices((current) => current.filter((candidate) => candidate.id !== id));
    }, 5000);
  }

  function handleStaleSession(error: unknown) {
    if (!(error instanceof ApiError) || error.status !== 401) return false;
    if (staleSessionLogoutRef.current) return true;
    staleSessionLogoutRef.current = true;
    window.localStorage.setItem("serversentinel-demo-mode", "false");
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
    setFilesError("");
    setModsError("");
    setLogs([]);
    setListing({ path: "/", entries: [] });
    resetEditorState();
    notify("warning", "You were logged out because the panel restarted and the loaded state is no longer current. Sign in again to continue.");
    return true;
  }

  function warnIfModServerRunning() {
    if (!modServerRunning) return false;
    notify("error", "Stop the server before adding, removing, updating, or uploading mods.");
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
    const demoLogin = username === "demo" && password === "demo";
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
    try {
      const session = await api<AuthSession>(setupRequired && !demoLogin ? "/api/auth/register-first" : "/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      if (session.demo) {
        window.localStorage.setItem("serversentinel-demo-mode", "true");
        setAuthNotice("");
        setNotice("");
        setAppStateLoaded(false);
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
      setAuthSession(session);
      formElement.reset();
    } catch (error) {
      setAuthNotice((error as Error).message);
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => null);
    window.localStorage.setItem("serversentinel-demo-mode", "false");
    setDemoMode(false);
    setAuthSession({ authenticated: false, setupRequired: false, user: null });
    setAppState(emptyApp);
    setAppStateLoaded(false);
    setActiveServerId("");
    setStatus(null);
    setLogs([]);
    staleSessionLogoutRef.current = false;
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
      setLogs(lines.map((line) => consoleLine(`[${result.source}] ${line}`)));
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
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
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

  async function waitForProvisionJob(jobId: string) {
    for (;;) {
      const job = await api<ProvisionJob>(`/api/provision/${jobId}`);
      setActiveJobs((current) => current.map((j) => j.id === "local" || j.id === jobId ? {
        ...j,
        id: job.id,
        status: job.status,
        progress: job.progress,
        task: job.task,
        error: job.error,
        errorDetails: job.errorDetails,
        dismissible: job.status !== "running"
      } : j));
      if (job.status === "succeeded") return job;
      if (job.status === "failed") {
        const error = new Error(job.error || "Server setup failed") as Error & { details?: string };
        error.details = job.errorDetails;
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
      const job = await api<ProvisionJob>("/api/servers/provision", {
        method: "POST",
        body: JSON.stringify({
          displayName: form.get("displayName"),
          serverDir: form.get("serverDir"),
          minecraftVersion: form.get("minecraftVersion"),
          loaderVersion: form.get("loaderVersion"),
          installerVersion: form.get("installerVersion"),
          serverJar: form.get("serverJar"),
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
        id: job.id,
        status: job.status,
        progress: job.progress,
        task: job.task,
        error: job.error,
        errorDetails: job.errorDetails,
        dismissible: job.status !== "running"
      } : j));
      const completed = await waitForProvisionJob(job.id);
      const server = completed.server;
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
        setActiveJobs((current) => current.filter((j) => j.id !== job.id));
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
    if (isProvisioning || serverSettingsSaving || !canManager) return;
    if (!activeServer) return;
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
          minecraftVersion: form.get("minecraftVersion"),
          loaderVersion: form.get("loaderVersion"),
          installerVersion: form.get("installerVersion"),
          serverJar: form.get("serverJar"),
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
    const versionText = node.agentVersion ? ` from ${node.agentVersion} to ${appVersion}` : ` to ${appVersion}`;
    if (!window.confirm(`Upgrade node "${node.name}"${versionText}?\n\nThe node may disconnect briefly while the container is recreated.`)) return;
    setNodeBusyId(node.id);
    try {
      const result = await api<NodeUpdateResponse>(`/api/nodes/${node.id}/update`, {
        method: "POST",
        body: JSON.stringify({})
      });
      notify(result.ok ? "success" : "info", result.message || `Node ${node.name} update started.`);
      if (result.ok && result.mode === "self") {
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

  async function removeNode(node: ContextNode, force = false) {
    if (node.isInternal || !canManageUsers) return;
    if (node.servers.length > 0 && !force) {
      notify("error", "Move or delete assigned servers before removing this node.");
      return;
    }
    const assignedMessage = node.servers.length
      ? `\n\nThis will also remove ${node.servers.length} assigned server record${node.servers.length === 1 ? "" : "s"} from the panel. If the node is online and supports self-stop, ServerSentinel will ask its container to stop. Remote server files are not deleted.`
      : "";
    if (!window.confirm(`${force ? "Force remove" : "Remove"} node "${node.name}"?${assignedMessage}\n\nThis cannot be undone.`)) return;
    setNodeBusyId(node.id);
    try {
      const result = await api<{ ok: boolean; deletedServers?: number; selfRemoval?: { ok: boolean; message: string } }>(`/api/nodes/${node.id}${force ? "?force=true" : ""}`, { method: "DELETE" });
      const removedServers = result.deletedServers ?? 0;
      const selfStopSuffix = result.selfRemoval?.ok ? " The node container will stop itself." : result.selfRemoval?.message ? ` ${result.selfRemoval.message}` : "";
      notify("success", `${removedServers ? `Removed ${node.name} and ${removedServers} server${removedServers === 1 ? "" : "s"}` : `Removed ${node.name}`}.${selfStopSuffix}`);
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

  async function runContainerAction(action: "start" | "stop" | "restart") {
    if (isProvisioning || dockerOperationalLock || !canBasic) return;
    if (!activeServer) return;
    setNotice("");
    setRuntimeAction(action);
    const actionLabel = action === "start" ? "Start" : action === "stop" ? "Stop" : "Restart";
    const completedLabel = action === "start" ? "started" : action === "stop" ? "stopped" : "restarted";
    notify("info", `${actionLabel} request sent`);
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

  async function sendCommand(event: FormEvent) {
    event.preventDefault();
    if (isProvisioning || commandSending || dockerOperationalLock || !canExpanded) return;
    if (!activeServer) return;
    const command = commandInput.trim().replace(/^\//, "");
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
        setLogs((current) => [...current.slice(-497), consoleLine(`[command] > ${command}`), consoleLine(`[demo] ${response}`)]);
        setCommandHistory((current) => [...current.filter((entry) => entry !== command), command].slice(-50));
        setHistoryIndex(null);
        setCommandInput("");
        return;
      }
      await api(`/api/servers/${activeServer.id}/command`, {
        method: "POST",
        body: JSON.stringify({ command })
      });
      setLogs((current) => [...current.slice(-499), consoleLine(`[command] > ${command}`)]);
      setCommandHistory((current) => [...current.filter((entry) => entry !== command), command].slice(-50));
      setHistoryIndex(null);
      setCommandInput("");
      setConsoleStreamVersion((version) => version + 1);
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

  function handleCommandKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!commandHistory.length) return;
      const nextIndex = historyIndex === null ? commandHistory.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setCommandInput(commandHistory[nextIndex]);
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (historyIndex === null) return;
      const nextIndex = historyIndex + 1;
      if (nextIndex >= commandHistory.length) {
        setHistoryIndex(null);
        setCommandInput("");
      } else {
        setHistoryIndex(nextIndex);
        setCommandInput(commandHistory[nextIndex]);
      }
    }
    if (event.key === "Tab") {
      const suggestion = commandSuggestions[0];
      if (suggestion) {
        event.preventDefault();
        setCommandInput(suggestion.command);
        setHistoryIndex(null);
      }
    }
  }

  async function loadFiles(serverId: string, path: string, historyMode: "replace" | "push" | "back" | "forward" = "replace") {
    if (isProvisioning) return false;
    const previousPath = listing.path;
    setFilesLoading(true);
    setFilesError("");
    setNotice("");
    if (demoMode && serverId === demoServerId) {
      if (activeServerIdRef.current === serverId) {
        const nextListing = demoListing(path, demoFiles, demoInstalledMods);
        setListing(nextListing);
        setSelectedFilePaths([]);
        setFilePreview({ path: "", loading: false, data: null, error: "" });
        if (historyMode === "push" && nextListing.path !== previousPath) {
          setFileBackStack((current) => [...current, previousPath].slice(-50));
          setFileForwardStack([]);
        }
      }
      setFilesLoading(false);
      return true;
    }
    try {
      const nextListing = await api<FileListing>(`/api/servers/${serverId}/files?path=${encodeURIComponent(path)}`);
      if (activeServerIdRef.current === serverId) {
        setListing(nextListing);
        setSelectedFilePaths([]);
        setFilePreview({ path: "", loading: false, data: null, error: "" });
        setFilesError("");
        if (historyMode === "push" && nextListing.path !== previousPath) {
          setFileBackStack((current) => [...current, previousPath].slice(-50));
          setFileForwardStack([]);
        }
      }
      return true;
    } catch (error) {
      if (handleStaleSession(error)) return;
      const message = errorMessage(error, "Could not load server files. Check that the server path is available.");
      setFilesError(message);
      setNotice(message);
      notify("error", message);
      return false;
    } finally {
      if (activeServerIdRef.current === serverId) setFilesLoading(false);
    }
  }

  async function navigateFiles(path: string) {
    if (!activeServer) return;
    await loadFiles(activeServer.id, path, "push");
  }

  async function navigateBackFiles() {
    if (!activeServer || fileBackStack.length === 0) return;
    const target = fileBackStack[fileBackStack.length - 1];
    const loaded = await loadFiles(activeServer.id, target, "back");
    if (loaded) {
      setFileBackStack((current) => current.slice(0, -1));
      setFileForwardStack((current) => [listing.path, ...current].slice(0, 50));
    }
  }

  async function navigateForwardFiles() {
    if (!activeServer || fileForwardStack.length === 0) return;
    const target = fileForwardStack[0];
    const loaded = await loadFiles(activeServer.id, target, "forward");
    if (loaded) {
      setFileForwardStack((current) => current.slice(1));
      setFileBackStack((current) => [...current, listing.path].slice(-50));
    }
  }

  async function loadInstalledMods(serverId: string) {
    if (isProvisioning) return;
    setModsLoading(true);
    setModsError("");
    if (demoMode && serverId === demoServerId) {
      if (activeServerIdRef.current === serverId) {
        setInstalledMods(demoInstalledMods);
      }
      setModsLoading(false);
      return;
    }
    try {
      const result = await api<{ mods: InstalledMod[] }>(`/api/servers/${serverId}/mods`);
      if (activeServerIdRef.current === serverId) {
        setInstalledMods(result.mods);
        setModsError("");
      }
    } catch (error) {
      if (handleStaleSession(error)) return;
      const message = errorMessage(error, "Could not load installed mods. Check the server mods folder and retry.");
      setModsError(message);
      setNotice(message);
      notify("error", message);
    } finally {
      if (activeServerIdRef.current === serverId) setModsLoading(false);
    }
  }

  function resetEditorState() {
    setSelectedPath("");
    setEditorText("");
    setSavedEditorText("");
    setDirty(false);
    setFileReadError("");
    setFileOpenFailed(false);
    setFileOpening(false);
    setFileSaving(false);
  }

  function closeEditor() {
    resetEditorState();
    setDiscardEditorRequest(null);
  }

  function requestCloseEditor() {
    if (dirty) {
      setDiscardEditorRequest({ action: "close" });
      return;
    }
    closeEditor();
  }

  function discardEditorChanges() {
    const request = discardEditorRequest;
    setDiscardEditorRequest(null);
    if (!request) return;
    if (request.action === "close") {
      closeEditor();
      return;
    }
    resetEditorState();
    void openFile(request.path, true);
  }

  async function loadFilePreview(entry: FileEntry) {
    if (!activeServer) return;
    setFilePreview({ path: entry.path, loading: true, data: null, error: "" });
    if (activeServerIsDemo) {
      const content = demoFiles[entry.path] ?? "";
      if (!isPreviewableFile(entry)) {
        setFilePreview((current) => current.path === entry.path
          ? { path: entry.path, loading: false, data: { path: entry.path, preview: "unsupported", message: "Preview unavailable" }, error: "" }
          : current);
      } else if (new Blob([content]).size > 96 * 1024) {
        setFilePreview((current) => current.path === entry.path
          ? { path: entry.path, loading: false, data: { path: entry.path, preview: "too_large", message: "File too large to preview" }, error: "" }
          : current);
      } else {
        setFilePreview((current) => current.path === entry.path
          ? { path: entry.path, loading: false, data: { path: entry.path, preview: "text", content }, error: "" }
          : current);
      }
      return;
    }
    try {
      const preview = await api<FilePreview>(`/api/servers/${activeServer.id}/file/preview?path=${encodeURIComponent(entry.path)}`);
      setFilePreview((current) => current.path === entry.path
        ? { path: entry.path, loading: false, data: preview, error: "" }
        : current);
    } catch (error) {
      setFilePreview((current) => current.path === entry.path
        ? { path: entry.path, loading: false, data: null, error: errorMessage(error, "Could not load a preview for this file.") }
        : current);
    }
  }

  async function openFile(path: string, discardConfirmed = false) {
    if (isProvisioning) return;
    if (!activeServer) return;
    if (dockerOperationalLock || !canManager) {
      const message = dockerOperationalLock
        ? runtimeControlsDisabledReason || "Server files are unavailable until the runtime reconnects."
        : "Manager permission is required to edit files.";
      setNotice(message);
      notify("warning", message);
      return;
    }
    if (selectedPath && selectedPath !== path && dirty && !discardConfirmed) {
      setDiscardEditorRequest({ action: "switch", path });
      return;
    }
    const pathError = validateSafePath(path);
    if (pathError) {
      setFileReadError(pathError);
      setNotice(pathError);
      return;
    }
    setSelectedPath(path);
    setEditorText("");
    setSavedEditorText("");
    setDirty(false);
    setFileReadError("");
    setFileOpenFailed(false);
    setFileOpening(true);
    setNotice("");
    setSelectedFilePaths([path]);
    if (activeServerIsDemo) {
      const content = demoFiles[path] ?? `Demo binary or generated file: ${path}`;
      setSelectedPath(path);
      setEditorText(content);
      setSavedEditorText(content);
      setDirty(false);
      setFileOpening(false);
      return;
    }
    try {
      const file = await api<{ path: string; content: string }>(
        `/api/servers/${activeServer.id}/file?path=${encodeURIComponent(path)}`
      );
      setSelectedPath(file.path);
      setEditorText(file.content);
      setSavedEditorText(file.content);
      setDirty(false);
      setSelectedFilePaths([file.path]);
    } catch (error) {
      const message = errorMessage(error, "Could not read this file. Check that the path is available and editable.");
      setFileReadError(message);
      setFileOpenFailed(true);
      setSelectedFilePaths([]);
      notify("error", message);
    } finally {
      setFileOpening(false);
    }
  }

  async function deleteSelectedFiles() {
    if (!activeServer || selectedEntries.length === 0 || fileOperationBusy) return;
    if (isProvisioning || dockerOperationalLock || !canManager) return;
    const invalidPath = selectedEntries.map((entry) => validateSafePath(entry.path)).find(Boolean);
    if (invalidPath) {
      setNotice(invalidPath);
      notify("error", invalidPath);
      return;
    }
    const directoryCount = selectedEntries.filter((entry) => entry.type === "directory").length;
    const fileCount = selectedEntries.length - directoryCount;
    const itemLabel = selectedEntries.length === 1 ? selectedEntries[0].name : `${selectedEntries.length} selected items`;
    const previewList = selectedEntries.slice(0, 5).map((entry) => `- ${entry.path}`).join("\n");
    const moreText = selectedEntries.length > 5 ? `\n- ...and ${selectedEntries.length - 5} more` : "";
    const directoryWarning = directoryCount ? "\n\nSelected folders and their contents will be deleted." : "";
    if (!window.confirm(`Delete ${itemLabel}?\n\nFiles: ${fileCount}\nFolders: ${directoryCount}\n${previewList}${moreText}${directoryWarning}\n\nThis cannot be undone.`)) return;

    setFileOperationBusy("delete");
    setNotice("");
    try {
      if (activeServerIsDemo) {
        const deletedEntries = [...selectedEntries];
        const nextFiles = { ...demoFiles };
        for (const entry of deletedEntries) {
          for (const path of Object.keys(nextFiles)) {
            if (publicPathContains(entry.path, path)) delete nextFiles[path];
          }
        }
        const deletedModPaths = new Set(deletedEntries.filter((entry) => entry.path.startsWith("/mods/")).map((entry) => entry.path));
        const nextMods = demoInstalledMods.filter((mod) => !deletedModPaths.has(`/mods/${mod.filename}`));
        setDemoFiles(nextFiles);
        setDemoInstalledMods(nextMods);
        setListing(demoListing(listing.path, nextFiles, nextMods));
        clearDeletedFileState(deletedEntries, selectedPath, filePreview.path, resetEditorState, setFilePreview);
        setSelectedFilePaths([]);
        notify("success", selectedEntries.length === 1 ? `Deleted ${selectedEntries[0].name}` : `Deleted ${selectedEntries.length} items`);
        return;
      }

      const failures: string[] = [];
      const deletedEntries: FileEntry[] = [];
      const deleteTargets = selectedEntries.filter((entry) => !selectedEntries.some((candidate) => (
        candidate.path !== entry.path
        && candidate.type === "directory"
        && publicPathContains(candidate.path, entry.path)
      )));
      for (const entry of deleteTargets) {
        try {
          const recursive = entry.type === "directory" ? "&recursive=true" : "";
          await api(`/api/servers/${activeServer.id}/file?path=${encodeURIComponent(entry.path)}${recursive}`, {
            method: "DELETE"
          });
          deletedEntries.push(entry);
        } catch (error) {
          failures.push(`${entry.name}: ${errorMessage(error, "Delete failed")}`);
        }
      }
      if (deletedEntries.length) {
        clearDeletedFileState(deletedEntries, selectedPath, filePreview.path, resetEditorState, setFilePreview);
        setSelectedFilePaths((current) => current.filter((path) => !deletedEntries.some((entry) => publicPathContains(entry.path, path))));
        notify("success", deletedEntries.length === 1 ? `Deleted ${deletedEntries[0].name}` : `Deleted ${deletedEntries.length} items`);
      }
      await loadFiles(activeServer.id, listing.path);
      await loadInstalledMods(activeServer.id);
      if (failures.length) {
        const message = `Could not delete ${failures.length} item${failures.length === 1 ? "" : "s"}: ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? "; ..." : ""}`;
        setNotice(message);
        notify("error", message);
      }
    } finally {
      setFileOperationBusy("");
    }
  }

  async function createFolder() {
    if (!activeServer || fileOperationBusy) return;
    if (fileRuntimeLocked || !canManager) return;
    const name = window.prompt("New folder name");
    if (name === null) return;
    const nameError = fileNameValidation(name);
    if (nameError) {
      notify("error", nameError);
      return;
    }
    setFileOperationBusy("new-folder");
    try {
      if (activeServerIsDemo) {
        const folderPath = joinPublicPath(listing.path, name.trim());
        const nextFiles = { ...demoFiles, [joinPublicPath(folderPath, ".serversentinel-folder")]: "" };
        setDemoFiles(nextFiles);
        setListing(demoListing(listing.path, nextFiles, demoInstalledMods));
      } else {
        await api(`/api/servers/${activeServer.id}/folder`, {
          method: "POST",
          body: JSON.stringify({ path: listing.path, name: name.trim() })
        });
        await loadFiles(activeServer.id, listing.path);
      }
      notify("success", `Created ${name.trim()}`);
    } catch (error) {
      notify("error", errorMessage(error, "Could not create the folder."));
    } finally {
      setFileOperationBusy("");
    }
  }

  async function uploadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !activeServer || fileOperationBusy) return;
    if (fileRuntimeLocked || !canManager) return;
    const nameError = fileNameValidation(file.name);
    if (nameError) {
      notify("error", nameError);
      return;
    }
    if (file.size > 32 * 1024 * 1024) {
      notify("error", "Upload is larger than the 32 MiB file manager limit.");
      return;
    }
    setFileOperationBusy("upload");
    try {
      const targetPath = joinPublicPath(listing.path, file.name);
      if (activeServerIsDemo) {
        const content = await file.text();
        const nextFiles = { ...demoFiles, [targetPath]: content };
        setDemoFiles(nextFiles);
        setListing(demoListing(listing.path, nextFiles, demoInstalledMods));
      } else {
        const contentBase64 = bufferToBase64(await file.arrayBuffer());
        await api(`/api/servers/${activeServer.id}/files/upload`, {
          method: "POST",
          body: JSON.stringify({ path: listing.path, filename: file.name, contentBase64 })
        });
        await loadFiles(activeServer.id, listing.path);
      }
      setSelectedFilePaths([targetPath]);
      notify("success", `Uploaded ${file.name}`);
    } catch (error) {
      notify("error", errorMessage(error, "Could not upload the file."));
    } finally {
      setFileOperationBusy("");
    }
  }

  async function downloadSelectedFile() {
    if (!activeServer || selectedEntries.length !== 1) return;
    if (!canDownloadSelectedFile) return;
    const entry = selectedEntries[0];
    if (entry.type !== "file") return;
    setFileOperationBusy("download");
    try {
      if (activeServerIsDemo) {
        const blob = new Blob([demoFiles[entry.path] ?? ""], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = entry.name;
        anchor.click();
        URL.revokeObjectURL(url);
      } else {
        const response = await fetch(`/api/servers/${activeServer.id}/file/download?path=${encodeURIComponent(entry.path)}`, {
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            ...(demoMode ? { "X-ServerSentinel-Demo-Mode": "true" } : {})
          },
          credentials: "same-origin"
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.message ?? payload.error ?? `Request failed with ${response.status}`);
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = entry.name;
        anchor.click();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      notify("error", errorMessage(error, "Could not download the selected file."));
    } finally {
      setFileOperationBusy("");
    }
  }

  async function renameSelectedFile() {
    if (!activeServer || selectedEntries.length !== 1 || fileOperationBusy) return;
    if (!canRenameSelectedItem) return;
    const entry = selectedEntries[0];
    if (dirty && selectedPath && publicPathContains(entry.path, selectedPath)) {
      const message = "Save or discard the open editor changes before renaming this item.";
      setNotice(message);
      notify("warning", message);
      return;
    }
    const name = window.prompt("Rename item", entry.name);
    if (name === null || name.trim() === entry.name) return;
    const nameError = fileNameValidation(name);
    if (nameError) {
      notify("error", nameError);
      return;
    }
    setFileOperationBusy("rename");
    try {
      const targetPath = joinPublicPath(parentPath(entry.path), name.trim());
      if (activeServerIsDemo) {
        const nextFiles = { ...demoFiles };
        for (const path of Object.keys(nextFiles)) {
          if (path === entry.path || path.startsWith(`${entry.path}/`)) {
            const replacement = path.replace(entry.path, targetPath);
            nextFiles[replacement] = nextFiles[path];
            delete nextFiles[path];
          }
        }
        setDemoFiles(nextFiles);
        setListing(demoListing(listing.path, nextFiles, demoInstalledMods));
      } else {
        await api(`/api/servers/${activeServer.id}/file`, {
          method: "PATCH",
          body: JSON.stringify({ path: entry.path, name: name.trim() })
        });
        await loadFiles(activeServer.id, listing.path);
      }
      setSelectedFilePaths([targetPath]);
      if (selectedPath && publicPathContains(entry.path, selectedPath)) {
        setSelectedPath(selectedPath.replace(entry.path, targetPath));
      }
      if (filePreview.path && publicPathContains(entry.path, filePreview.path)) {
        setFilePreview({ path: "", loading: false, data: null, error: "" });
      }
      notify("success", `Renamed to ${name.trim()}`);
    } catch (error) {
      notify("error", errorMessage(error, "Could not rename the selected item."));
    } finally {
      setFileOperationBusy("");
    }
  }

  async function duplicateSelectedFile() {
    if (!activeServer || selectedEntries.length !== 1 || fileOperationBusy) return;
    if (!canDuplicateSelectedFile) return;
    const entry = selectedEntries[0];
    if (entry.type !== "file") return;
    const suggestedName = defaultDuplicateName(entry.name);
    const name = window.prompt("Duplicate file as", suggestedName);
    if (name === null) return;
    const nameError = fileNameValidation(name);
    if (nameError) {
      notify("error", nameError);
      return;
    }
    setFileOperationBusy("duplicate");
    try {
      const targetPath = joinPublicPath(parentPath(entry.path), name.trim());
      if (activeServerIsDemo) {
        const nextFiles = { ...demoFiles, [targetPath]: demoFiles[entry.path] ?? "" };
        setDemoFiles(nextFiles);
        setListing(demoListing(listing.path, nextFiles, demoInstalledMods));
      } else {
        await api(`/api/servers/${activeServer.id}/file/duplicate`, {
          method: "POST",
          body: JSON.stringify({ path: entry.path, name: name.trim() })
        });
        await loadFiles(activeServer.id, listing.path);
      }
      setSelectedFilePaths([targetPath]);
      notify("success", `Duplicated ${entry.name}`);
    } catch (error) {
      notify("error", errorMessage(error, "Could not duplicate the selected file."));
    } finally {
      setFileOperationBusy("");
    }
  }

  async function saveFile() {
    if (isProvisioning || dockerOperationalLock || !canManager) return;
    if (!activeServer) return;
    if (!selectedPath || !dirty) return;
    if (fileSaving) return;
    setFileSaving(true);
    setNotice("");
    setFileReadError("");
    setFileOpenFailed(false);
    const pathError = validateSafePath(selectedPath);
    if (pathError) {
      setNotice(pathError);
      notify("error", pathError);
      setFileSaving(false);
      return;
    }
    if (new Blob([editorText]).size > 2 * 1024 * 1024) {
      const message = "File content is larger than the 2 MiB editor limit.";
      setNotice(message);
      notify("error", message);
      setFileSaving(false);
      return;
    }
    if (activeServerIsDemo) {
      const nextFiles = { ...demoFiles, [selectedPath]: editorText };
      setDemoFiles(nextFiles);
      setSavedEditorText(editorText);
      setDirty(false);
      setNotice(`Saved ${selectedPath}`);
      notify("success", `Saved ${selectedPath}`);
      setListing(demoListing(listing.path, nextFiles, demoInstalledMods));
      closeEditor();
      setFileSaving(false);
      return;
    }
    try {
      await api(`/api/servers/${activeServer.id}/file`, {
        method: "PUT",
        body: JSON.stringify({ path: selectedPath, content: editorText })
      });
      setSavedEditorText(editorText);
      setDirty(false);
      setNotice(`Saved ${selectedPath}`);
      notify("success", `Saved ${selectedPath}`);
      await loadFiles(activeServer.id, listing.path);
      closeEditor();
    } catch (error) {
      const message = errorMessage(error, "Could not save the file. Review the path and try again.");
      setFileReadError(message);
      setFileOpenFailed(false);
      setNotice(message);
      notify("error", message);
    } finally {
      setFileSaving(false);
    }
  }

  function cancelFileEdit() {
    requestCloseEditor();
  }

  async function searchMods(event: FormEvent) {
    event.preventDefault();
    if (isProvisioning) return;
    if (!activeServer) return;
    setNotice("");
    setModSearchError("");
    setModInstallModal(null);
    const searchQuery = query.trim();
    if (!effectiveAppState.modrinthApiConfigured) {
      const message = "Modrinth API is not configured. Add an API key in settings.";
      setModSearchError(message);
      setNotice(message);
      notify("error", message);
      return;
    }
    if (!searchQuery) {
      const message = "Enter a mod name or keyword to search.";
      setModSearchError(message);
      setNotice(message);
      return;
    }
    setModSearchResults([]);
    setModSearchTotal(0);
    setIsSearchingMods(true);
    setDebouncedModSearchQuery(searchQuery);
    setModSearchRequestVersion((current) => current + 1);
  }

  async function loadMoreMods() {
    if (loadMoreModsInFlightRef.current) return;
    if (isLoadingMoreMods || isSearchingMods || !activeServer) return;
    const currentOffset = modSearchResults.length;
    if (currentOffset >= modSearchTotal) return;
    loadMoreModsInFlightRef.current = true;
    setIsLoadingMoreMods(true);
    const searchQuery = query.trim();
    if (activeServerIsDemo) {
      window.setTimeout(() => {
        const value = searchQuery.toLowerCase();
        const baseFiltered = demoSearchResults.filter((mod) => !value || mod.title.toLowerCase().includes(value) || mod.description.toLowerCase().includes(value));
        const extraMods: ModrinthHit[] = [];
        if (value.length <= 3) {
          for (let i = 1; i <= 40; i++) {
            extraMods.push({
              project_id: `demo-dummy-${i}`,
              title: `Fabric Mod Helper ${i}`,
              description: `A generated dummy mod to showcase infinite scrolling in demo mode. Index ${i}.`,
              downloads: 100000 + i * 5000,
              date_modified: new Date().toISOString(),
              compatibility: {
                status: "compatible",
                compatible: true,
                reason: "Compatible server-side Fabric mod",
                serverSide: "optional",
                clientSide: "optional"
              },
              server_side: "optional",
              client_side: "optional"
            });
          }
        }
        const allFiltered = [...baseFiltered, ...extraMods];
        const nextPage = allFiltered.slice(currentOffset, currentOffset + 20);
        setModSearchResults((prev) => [...prev, ...nextPage]);
        loadMoreModsInFlightRef.current = false;
        setIsLoadingMoreMods(false);
      }, 250);
      return;
    }
    try {
      const result = await api<{ hits: ModrinthHit[]; total_hits: number }>(
        `/api/modrinth/search?query=${encodeURIComponent(searchQuery)}&serverId=${encodeURIComponent(activeServer.id)}&channel=release&offset=${currentOffset}&limit=20`
      );
      setModSearchResults((prev) => [...prev, ...result.hits]);
    } catch (error) {
      const message = errorMessage(error, "Could not load more search results.");
      notify("error", message);
    } finally {
      loadMoreModsInFlightRef.current = false;
      setIsLoadingMoreMods(false);
    }
  }

  useEffect(() => {
    if (!sentinelRef.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !isLoadingMoreMods && !isSearchingMods && modSearchResults.length < modSearchTotal) {
        void loadMoreMods();
      }
    }, {
      rootMargin: "200px"
    });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [modSearchResults.length, modSearchTotal, isLoadingMoreMods, isSearchingMods, query]);

  async function loadModInstallVersions(mod: ModrinthHit, channel: ReleaseChannel, options: { useFallbackChannel?: boolean } = {}) {
    if (!activeServer) return;
    setModInstallModal((current) => current && current.mod.project_id === mod.project_id
      ? { ...current, channel, loading: true, installing: false, error: "", step: 1, acknowledgeMinecraftMismatch: false, selectedVersionId: "", data: current.channel === channel ? current.data : null }
      : current
    );

    try {
      const fetchVersions = async (nextChannel: ReleaseChannel) => activeServerIsDemo
        ? demoInstallVersions(mod, nextChannel)
        : api<ModrinthInstallVersionsResponse>(
          `/api/modrinth/projects/${encodeURIComponent(mod.project_id)}/versions?serverId=${encodeURIComponent(activeServer.id)}&channel=${encodeURIComponent(nextChannel)}`
        );
      let resolvedChannel = channel;
      let data = await fetchVersions(resolvedChannel);
      while (options.useFallbackChannel && !hasVisibleInstallVersions(data)) {
        const fallbackChannel = nextReleaseChannel(resolvedChannel);
        if (!fallbackChannel) break;
        resolvedChannel = fallbackChannel;
        data = await fetchVersions(resolvedChannel);
      }
      const selectedVersionId = firstSelectableVersionId(data);
      setModInstallModal((current) => current && current.mod.project_id === mod.project_id
        ? {
          ...current,
          channel: resolvedChannel,
          loading: false,
          installing: false,
          error: "",
          data,
          selectedVersionId,
          showOtherVersions: current.showOtherVersions,
          acknowledgeMinecraftMismatch: false
        }
        : current
      );
    } catch (error) {
      const message = errorMessage(error, "Could not load Modrinth versions for this project.");
      setModInstallModal((current) => current && current.mod.project_id === mod.project_id
        ? { ...current, channel, loading: false, installing: false, error: message, data: null, selectedVersionId: "" }
        : current
      );
      notify("error", message);
    }
  }

  function openModInstallModal(mod: ModrinthHit) {
    if (warnIfModServerRunning()) return;
    const channel: ReleaseChannel = "release";
    setModInstallModal({
      mod,
      step: 1,
      channel,
      loading: true,
      installing: false,
      error: "",
      data: null,
      selectedVersionId: "",
      showOtherVersions: false,
      acknowledgeMinecraftMismatch: false
    });
    void loadModInstallVersions(mod, channel, { useFallbackChannel: true });
  }

  function selectInstallVersion(version: ModrinthInstallVersion) {
    if (!version.selectable) return;
    setModInstallModal((current) => current
      ? {
        ...current,
        selectedVersionId: version.id,
        acknowledgeMinecraftMismatch: version.requiresMinecraftAcknowledgement ? current.acknowledgeMinecraftMismatch : false
      }
      : current
    );
  }

  function continueModInstallReview() {
    if (!modInstallModal || !selectedInstallVersion || !canContinueModInstall) return;
    setModInstallModal((current) => current ? { ...current, step: 2 } : current);
  }

  async function uploadMod(event: ChangeEvent<HTMLInputElement>) {
    if (warnIfModServerRunning()) {
      event.target.value = "";
      return;
    }
    if (modsLocked || !canManager || !activeServer) return;
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const filenameError = validateJarFilename(file.name);
    if (filenameError) {
      notify("error", filenameError);
      return;
    }
    if (file.size <= 0 || file.size > 128 * 1024 * 1024) {
      notify("error", "Uploaded mod must be between 1 byte and 128 MiB.");
      return;
    }
    if (installedMods.some((mod) => mod.filename === file.name || mod.filename === `${file.name}.disabled`)) {
      notify("error", "A mod with that filename is already installed.");
      return;
    }
    setNotice("");
    const jobId = `upload-${file.name}-${Date.now()}`;
    const initialJob: GeneralJob = {
      id: jobId,
      type: "mod-upload",
      status: "running",
      title: "Uploading mod",
      subject: file.name,
      progress: 10,
      task: "Reading file",
      dismissible: false
    };
    setActiveJobs((current) => [...current, initialJob]);

    if (activeServerIsDemo) {
      try {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 40, task: "Uploading jar" } : j));
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 70, task: "Saving mod file" } : j));
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 95, task: "Refreshing installed mods" } : j));

        const mod: InstalledMod = {
          filename: file.name,
          displayName: file.name.replace(/\.jar$/i, "").replace(/[-_]/g, " "),
          enabled: true,
          size: file.size,
          modifiedAt: new Date().toISOString()
        };
        setDemoInstalledMods((current) => [mod, ...current.filter((candidate) => candidate.filename !== mod.filename)]);
        setInstalledMods((current) => [mod, ...current.filter((candidate) => candidate.filename !== mod.filename)]);
        notify("success", `Uploaded ${file.name}`);

        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, status: "succeeded", progress: 100, task: `Uploaded ${file.name}`, dismissible: true } : j));
        window.setTimeout(() => {
          setActiveJobs((current) => current.filter((j) => j.id !== jobId));
        }, 4000);
      } catch (err) {
        const msg = (err as Error).message;
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, status: "failed", task: "Upload failed", error: msg, dismissible: true } : j));
      }
      return;
    }

    try {
      const arrayBuffer = await file.arrayBuffer();
      setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 40, task: "Uploading jar" } : j));

      await api(`/api/servers/${activeServer.id}/mods/upload`, {
        method: "POST",
        body: JSON.stringify({ filename: file.name, contentBase64: bufferToBase64(arrayBuffer) })
      });
      notify("success", `Uploaded ${file.name}`);

      setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 90, task: "Refreshing installed mods" } : j));
      try {
        await loadInstalledMods(activeServer.id);
        await loadFiles(activeServer.id, "/mods");
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, status: "succeeded", progress: 100, task: `Uploaded ${file.name}`, dismissible: true } : j));
      } catch (refreshErr) {
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, status: "succeeded", progress: 100, task: `Uploaded ${file.name}, but failed to refresh mod list`, error: (refreshErr as Error).message, dismissible: true } : j));
      }

      window.setTimeout(() => {
        setActiveJobs((current) => current.filter((j) => j.id !== jobId));
      }, 4000);
    } catch (error) {
      const message = (error as Error).message;
      setNotice(message);
      notify("error", message);
      setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, status: "failed", task: "Upload failed", error: message, dismissible: true } : j));
    } finally {
      setIsSearchingMods(false);
    }
  }

  async function installSelectedMod() {
    if (warnIfModServerRunning()) return;
    if (modsLocked || !canManager) return;
    if (!activeServer) return;
    if (!modInstallModal || !modInstallModal.data || !selectedInstallVersion || !selectedInstallVersion.selectable) return;
    const projectId = modInstallModal.mod.project_id;
    const title = modInstallModal.data.project.title || modInstallModal.mod.title;
    const forceIncompatible = !selectedInstallVersion.compatible;
    const overrideMinecraftVersion = selectedInstallVersion.requiresMinecraftAcknowledgement;
    if (overrideMinecraftVersion && !modInstallModal.acknowledgeMinecraftMismatch) return;
    setNotice("");
    setModInstallModal((current) => current ? { ...current, installing: true, error: "" } : current);
    const jobId = `install-${projectId}-${selectedInstallVersion.id}-${Date.now()}`;
    const initialJob: GeneralJob = {
      id: jobId,
      type: "mod-install",
      status: "running",
      title: "Installing mod",
      subject: `${title} ${selectedInstallVersion.versionNumber}`,
      progress: 10,
      task: "Resolving version",
      dismissible: false
    };
    setActiveJobs((current) => [...current, initialJob]);

    if (activeServerIsDemo) {
      try {
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 40, task: "Resolving version" } : j));
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 70, task: "Downloading jar" } : j));
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 90, task: "Saving mod file" } : j));
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 95, task: "Refreshing installed mods" } : j));

        const filename = selectedInstallVersion.file?.filename || `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || projectId}-demo.jar`;
        const mod: InstalledMod = {
          filename,
          displayName: title,
          enabled: true,
          size: selectedInstallVersion.file?.size ?? 1_048_576 + Math.round(Math.random() * 2_000_000),
          modifiedAt: new Date().toISOString(),
          iconUrl: modInstallModal.data.project.iconUrl || modInstallModal.mod.icon_url,
          description: modInstallModal.data.project.description || modInstallModal.mod.description,
          modrinth: {
            projectId,
            versionId: selectedInstallVersion.id,
            filename,
            versionNumber: selectedInstallVersion.versionNumber,
            versionType: selectedInstallVersion.releaseChannel,
            gameVersions: selectedInstallVersion.minecraftVersions,
            loaders: selectedInstallVersion.loaders,
            hashes: selectedInstallVersion.file?.hashes,
            installedAt: new Date().toISOString(),
            installedWithForceIncompatible: forceIncompatible,
            incompatibilityReason: forceIncompatible ? selectedInstallVersion.reason : undefined,
            overrideMinecraftVersion,
            overrideReason: overrideMinecraftVersion ? selectedInstallVersion.reason : undefined,
            clientSide: modInstallModal.data.project.clientSide,
            serverSide: modInstallModal.data.project.serverSide,
            forceIncompatible
          }
        };
        setDemoInstalledMods((current) => [mod, ...current.filter((candidate) => candidate.filename !== filename)]);
        setInstalledMods((current) => [mod, ...current.filter((candidate) => candidate.filename !== filename)]);
        setActiveJobs((current) => current.filter((j) => j.id !== jobId));
        notify("success", `Installed ${title}`);
        setModInstallModal(null);
      } catch (err) {
        const msg = (err as Error).message;
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, status: "failed", task: "Install failed", error: msg, dismissible: true } : j));
        setModInstallModal((current) => current ? { ...current, installing: false, error: msg } : current);
      }
      return;
    }

    try {
      setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 35, task: "Downloading jar" } : j));

      const result = await api<{
        filename: string;
        version: string;
        channel: ReleaseChannel;
        installed?: Array<{ filename: string; dependencyType: "root" | "required" }>;
        optionalDependencies?: Array<{ projectId?: string; versionId?: string; dependencyType: string; reason: string }>;
      }>("/api/modrinth/install", {
        method: "POST",
        body: JSON.stringify({
          serverId: activeServer.id,
          projectId,
          versionId: selectedInstallVersion.id,
          channel: modInstallModal.channel,
          forceIncompatible,
          overrideMinecraftVersion
        })
      });
      setModInstallModal(null);

      setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 75, task: "Saving file" } : j));
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 90, task: "Refreshing installed mods" } : j));
      try {
        await loadInstalledMods(activeServer.id);
        await loadFiles(activeServer.id, "/mods");
        const requiredCount = result.installed?.filter((item) => item.dependencyType === "required").length ?? 0;
        const installSummary = requiredCount > 0 ? `Installed ${title} and ${requiredCount} required ${requiredCount === 1 ? "dependency" : "dependencies"}` : `Installed ${title}`;
        setActiveJobs((current) => current.filter((j) => j.id !== jobId));
        notify("success", installSummary);
      } catch (refreshErr) {
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, status: "succeeded", progress: 100, task: `Installed ${title}, but failed to refresh mod list`, error: (refreshErr as Error).message, dismissible: true } : j));
      }

      window.setTimeout(() => {
        setActiveJobs((current) => current.filter((j) => j.id !== jobId));
      }, 4000);
    } catch (error) {
      const message = (error as Error).message;
      setNotice(message);
      notify("error", message);
      setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, status: "failed", task: "Install failed", error: message, dismissible: true } : j));
      setModInstallModal((current) => current ? { ...current, installing: false, error: message } : current);
      void loadInstalledMods(activeServer.id);
      void loadFiles(activeServer.id, "/mods");
    }
  }

  async function updateMod(mod: InstalledMod) {
    if (warnIfModServerRunning()) return;
    if (modsLocked || !canManager || !activeServer || !mod.modrinth) return;
    setNotice("");
    const projectId = mod.modrinth.projectId;
    const title = mod.displayName;
    const oldFilename = mod.filename;
    const jobId = `update-${projectId}-${Date.now()}`;
    const initialJob: GeneralJob = {
      id: jobId,
      type: "mod-install",
      status: "running",
      title: "Updating mod",
      subject: title,
      progress: 10,
      task: "Checking compatibility",
      dismissible: false
    };
    setActiveJobs((current) => [...current, initialJob]);

    if (activeServerIsDemo) {
      try {
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 45, task: "Downloading update" } : j));
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 80, task: "Removing old jar" } : j));
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 95, task: "Refreshing installed mods" } : j));

        const updatedMod: InstalledMod = {
          ...mod,
          filename: "sodium-fabric-0.6.0+mc26.1.2.jar",
          size: 1250000,
          modifiedAt: new Date().toISOString(),
          versionInfo: {
            currentVersion: "0.6.0",
            currentChannel: "release",
            latestVersion: "0.6.0",
            latestChannel: "release",
            upToDate: true
          },
          modrinth: {
            ...mod.modrinth,
            filename: "sodium-fabric-0.6.0+mc26.1.2.jar",
            versionNumber: "0.6.0",
            installedAt: new Date().toISOString()
          }
        };

        setDemoInstalledMods((current) => [updatedMod, ...current.filter((candidate) => candidate.filename !== oldFilename)]);
        setInstalledMods((current) => [updatedMod, ...current.filter((candidate) => candidate.filename !== oldFilename)]);
        notify("success", `Updated ${title} to 0.6.0`);

        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, status: "succeeded", progress: 100, task: `Updated ${title}`, dismissible: true } : j));
        window.setTimeout(() => {
          setActiveJobs((current) => current.filter((j) => j.id !== jobId));
        }, 4000);
      } catch (err) {
        const msg = (err as Error).message;
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, status: "failed", task: "Update failed", error: msg, dismissible: true } : j));
      }
      return;
    }

    try {
      setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 30, task: "Downloading new version" } : j));
      
      const result = await api<{ filename: string; version: string; channel: ReleaseChannel }>("/api/modrinth/install", {
        method: "POST",
        body: JSON.stringify({ serverId: activeServer.id, projectId, channel: mod.preferredChannel || "release", forceIncompatible: mod.modrinth.installedWithForceIncompatible })
      });

      setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 70, task: "Removing old version" } : j));

      await api(`/api/servers/${activeServer.id}/mods?filename=${encodeURIComponent(oldFilename)}`, {
        method: "DELETE"
      });

      notify("success", `Updated ${title} to ${result.version}`);

      setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 90, task: "Refreshing installed mods" } : j));
      try {
        await loadInstalledMods(activeServer.id);
        await loadFiles(activeServer.id, "/mods");
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, status: "succeeded", progress: 100, task: `Updated ${title}`, dismissible: true } : j));
      } catch (refreshErr) {
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, status: "succeeded", progress: 100, task: `Updated ${title}, but failed to refresh mod list`, error: (refreshErr as Error).message, dismissible: true } : j));
      }

      window.setTimeout(() => {
        setActiveJobs((current) => current.filter((j) => j.id !== jobId));
      }, 4000);
    } catch (error) {
      const message = (error as Error).message;
      setNotice(message);
      notify("error", message);
      setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, status: "failed", task: "Update failed", error: message, dismissible: true } : j));
      void loadInstalledMods(activeServer.id);
      void loadFiles(activeServer.id, "/mods");
    }
  }

  async function processModToggleQueue(filename: string, modDisplayName: string) {
    const queueItem = modToggleStateQueueRef.current[filename];
    if (!queueItem || queueItem.inFlightEnabled !== null) {
      return;
    }

    let currentFilename = filename;
    while (true) {
      const runEnabled = queueItem.targetEnabled;
      queueItem.inFlightEnabled = runEnabled;

      if (activeServerIsDemo) {
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      } else if (activeServer) {
        try {
          const result = await api<{ filename: string; enabled: boolean }>(`/api/servers/${activeServer.id}/mods`, {
            method: "PATCH",
            body: JSON.stringify({ filename: currentFilename, enabled: runEnabled })
          });
          const nextFilename = result.filename || currentFilename;
          setInstalledMods((current) => current.map((m) => m.filename === currentFilename ? {
            ...m,
            filename: nextFilename,
            displayName: nextFilename.replace(/\.jar\.disabled$/, ".jar"),
            enabled: result.enabled
          } : m));
          currentFilename = nextFilename;
          void loadFiles(activeServer.id, "/mods");
        } catch (error) {
          const errorMsg = (error as Error).message;
          setNotice(`Failed to toggle mod ${modDisplayName}: ${errorMsg}`);
          notify("error", `Failed to toggle mod ${modDisplayName}: ${errorMsg}`);

          const rollBackTo = !runEnabled;
          setInstalledMods((current) => current.map((m) => m.filename === currentFilename ? { ...m, enabled: rollBackTo } : m));
          if (demoMode) {
            setDemoInstalledMods((current) => current.map((m) => m.filename === currentFilename ? { ...m, enabled: rollBackTo } : m));
          }
          break;
        }
      }

      queueItem.inFlightEnabled = null;
      if (queueItem.targetEnabled === runEnabled) {
        break;
      }
    }

    delete modToggleStateQueueRef.current[filename];
    if (activeServer && !activeServerIsDemo) {
      void loadInstalledMods(activeServer.id);
    }
  }

  async function setInstalledModEnabled(mod: InstalledMod, enabled: boolean) {
    if (modToggleLocked || !canManager || !activeServer) return;
    setNotice("");

    // Optimistically update UI instantly
    setInstalledMods((current) => current.map((m) => m.filename === mod.filename ? { ...m, enabled } : m));
    if (demoMode) {
      setDemoInstalledMods((current) => current.map((m) => m.filename === mod.filename ? { ...m, enabled } : m));
    }

    // Initialize or update queue
    let queueItem = modToggleStateQueueRef.current[mod.filename];
    if (!queueItem) {
      queueItem = {
        targetEnabled: enabled,
        inFlightEnabled: null
      };
      modToggleStateQueueRef.current[mod.filename] = queueItem;
    } else {
      queueItem.targetEnabled = enabled;
    }

    // Trigger processing
    void processModToggleQueue(mod.filename, mod.displayName);
  }

  async function removeInstalledMod(mod: InstalledMod) {
    if (warnIfModServerRunning()) return;
    if (modsLocked || !canManager || !activeServer) return;
    setNotice("");
    if (!window.confirm(`Remove ${mod.displayName}?\n\nThis deletes ${mod.filename} from the server's mods folder.`)) return;
    if (activeServerIsDemo) {
      setDemoInstalledMods((current) => current.filter((candidate) => candidate.filename !== mod.filename));
      setInstalledMods((current) => current.filter((candidate) => candidate.filename !== mod.filename));
      notify("success", `Removed ${mod.displayName}`);
      return;
    }
    try {
      await api(`/api/servers/${activeServer.id}/mods?filename=${encodeURIComponent(mod.filename)}`, {
        method: "DELETE"
      });
      notify("success", `Removed ${mod.displayName}`);
      await loadInstalledMods(activeServer.id);
      await loadFiles(activeServer.id, "/mods");
    } catch (error) {
      const message = errorMessage(error, "Could not remove the mod.");
      setNotice(message);
      notify("error", message);
    }
  }

  async function createSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isProvisioning || scheduleBusy || dockerOperationalLock || !canExpanded || !activeServer) return false;
    setNotice("");
    setScheduleBusy(true);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const scheduleName = trimFormValue(form, "name");
    const cron = trimFormValue(form, "cron");
    const commands = form.getAll("commands").map(String);
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
        commands: commands.map((command) => command.trim()).filter(Boolean),
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
    if (isProvisioning || scheduleBusy || dockerOperationalLock || !canExpanded || !activeServer) return false;
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
    if (isProvisioning || scheduleBusy || dockerOperationalLock || !canExpanded || !activeServer) return;
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
    if (isProvisioning || serverSettingsSaving || dockerOperationalLock || !canManager) return;
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

  const notificationTray = (
    <Notifications
      notices={notices}
      activeJobs={activeJobs}
      onDismissJob={(jobId) => setActiveJobs(current => current.filter(j => j.id !== jobId))}
      onDismissNotice={(noticeId) => setNotices(current => current.filter(notice => notice.id !== noticeId))}
    />
  );

  if (!authSession) {
    return (
      <>
        {notificationTray}
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
        {notificationTray}
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
  const pageDescriptions: Partial<Record<ActivePage, string>> = {
    servers: "Choose a managed server or create a new one.",
    create: "Follow the steps below to create and configure your Minecraft server.",
    overview: "Runtime, resources, and recent activity.",
    console: "Live log output and command input.",
    files: "Browse, preview, and edit server files.",
    mods: "Review installed mods or search Modrinth.",
    schedule: "Create and manage scheduled console commands.",
    properties: "Edit server configuration and deletion settings.",
    settings: "Interface, integrations, users, and container status.",
    nodes: "Manage node hosts and server placement."
  };
  const currentPageTitle = pageTitles[activePage] ?? (!applicationReady ? "Loading" : "Welcome");
  const currentPageDescription = pageDescriptions[activePage];

  function resetPageToDefault(page: ActivePage) {
    if (page === "mods") {
      setModsView("manager");
      setQuery("");
      setDebouncedModSearchQuery("");
      setModSearchRequestVersion((current) => current + 1);
      setModSearchResults([]);
      setModSearchTotal(0);
      setModSearchError("");
      setModInstallModal(null);
      setDetailsMod(null);
      setInstalledQuery("");
      return;
    }
    if (page === "files") {
      setSelectedFilePaths([]);
      setFileBackStack([]);
      setFileForwardStack([]);
      setFileReadError("");
      setFilePreview({ path: "", loading: false, data: null, error: "" });
      resetEditorState();
      if (activeServer) void navigateFiles("/");
      return;
    }
    if (page === "console") {
      setCommandInput("");
      setHistoryIndex(null);
      setConsolePinnedToBottom(true);
      setPendingConsoleEntries(0);
      window.requestAnimationFrame(() => {
        consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
      });
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
  }

  function resetActiveSidebarPage(page: ActivePage) {
    if (activePage !== page) return;
    resetPageToDefault(page);
  }

  return (
    <main className={`appShell ${sidebarCollapsed ? "sidebarCollapsed" : ""} ${darkMode ? "themeDark" : "themeLight"}`}>
      {notificationTray}
      <aside className="sidebar">
        <div className="brandBlock">
          <div className="brandLockup">
            <img className="brandLogo" src="/logo.png" alt="" />
            <div>
              <h1>ServerSentinel</h1>
              <p>Managed server web panel</p>
            </div>
          </div>
          <button className="iconButton" onClick={() => setSidebarCollapsed((value) => !value)} aria-label="Toggle sidebar" disabled={isProvisioning} title={isProvisioning ? provisioningNavigationReason : "Toggle sidebar"}>
            <SidebarToggleIcon collapsed={sidebarCollapsed} />
          </button>
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
              <span className="settingsVersionText">v{appVersion}</span>
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
            <button type="button" className="accountLogoutButton" onClick={logout} disabled={isProvisioning} aria-label={demoMode ? "Exit demo" : "Log out"} title={isProvisioning ? provisioningNavigationReason : demoMode ? "Exit demo" : "Log out"}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M10 5H5v14h5" />
                <path d="M14 8l4 4-4 4" />
                <path d="M8 12h10" />
              </svg>
            </button>
          </div>
        </nav>
      </aside>

      <section className="workspace">
        <header className="workspaceHeader">
          <div>
            <h2>{currentPageTitle}</h2>
            {currentPageDescription && <p>{currentPageDescription}</p>}
          </div>
          <div className="workspaceActions">
            {activePage === "servers" && <button onClick={() => openCreateServerForNode()} disabled={demoMode || isProvisioning || serverCreationBlocked || !canCreateServers} title={demoMode || isProvisioning || serverCreationBlocked || !canCreateServers ? createServerDisabledReason : "Create a managed server"}>New managed server</button>}
            {activePage === "create" && <button onClick={() => setActivePage("servers")} disabled={isProvisioning} title={isProvisioning ? provisioningNavigationReason : "Cancel server creation"}>Cancel</button>}
            {isServerWorkspacePage(activePage) && activeServer && <button onClick={() => activeNodeRuntimeBlocked ? refreshApp() : refreshStatus()} disabled={isProvisioning} title={isProvisioning ? provisioningNavigationReason : activeNodeRuntimeBlocked ? "Refresh app and node status" : "Refresh server status"}>Refresh</button>}
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
            message={`${appLoadError} Check that the ServerSentinel backend is reachable, then try again.`}
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
                      <strong>{server.displayName}</strong>
                      <span>{minecraftVersion === "Unknown" ? "Version unknown" : minecraftVersion} - Fabric</span>
                      {lockedByDemo && <small>Demo mode is enabled. Disable it in settings to access this server.</small>}
                    </button>
                  );
                })}
              </section>
            ) : (
              <div className="emptyState">
                <h2>No managed servers yet</h2>
                {panelOnlyMode && usableContextNodes.length === 0 ? (
                  <>
                    <p>No node is connected yet. Add a node first so ServerSentinel has a host where it can create Minecraft servers.</p>
                    <button
                      onClick={() => {
                        setActivePage("nodes");
                        setAddNodeResult(null);
                        setNodeInstallMethod("run");
                        if (canManageUsers) setAddNodeOpen(true);
                      }}
                      disabled={demoMode || isProvisioning || Boolean(nodeBusyId) || !canManageUsers}
                      title={demoMode ? "Exit demo mode before adding real nodes." : isProvisioning ? provisioningNavigationReason : nodeBusyId ? "A node action is already in progress." : !canManageUsers ? "Manage users permission is required." : "Add a remote node"}
                    >
                      Add node
                    </button>
                  </>
                ) : (
                  <>
                    <p>No managed servers have been created yet. Create one to set up Fabric files and start managing a Minecraft server from this panel.</p>
                    <button onClick={() => openCreateServerForNode()} disabled={demoMode || isProvisioning || serverCreationBlocked || !canCreateServers} title={demoMode || isProvisioning || serverCreationBlocked || !canCreateServers ? createServerDisabledReason : "Create a managed server"}>Create managed server</button>
                  </>
                )}
              </div>
            )}
          </section>
        )}

        {activePage === "create" && (
          <section className="createServerPanel">
            {currentProvisionJob && currentProvisionJob.status === "running" && (
              <InlineState
                tone="loading"
                title="Creating server"
                message={`${currentProvisionJob.task || "Server setup is running."} Progress: ${Math.round(currentProvisionJob.progress)}%.`}
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
                <button type="button" onClick={() => {
                  setProvisioningError("");
                  setProvisioningErrorDetails("");
                }}>Clear error</button>
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
                </div>
                <span className="settingsStatus">v{appVersion}</span>
              </div>
              {demoMode && (
                <div className="settingsRow">
                  <div>
                    <strong>Demo mode</strong>
                  </div>
                  <button type="button" className="secondaryButton" onClick={logout} disabled={isProvisioning}>Exit demo mode</button>
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
                  </div>
                  <button type="button" onClick={() => setUserModal("create")} disabled={userSaving || !canManageUsers} title={!canManageUsers ? "Manage users permission is required" : "Create user"}>New user</button>
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
                </div>
                <span className={`settingsStatus ${panelOnlyMode ? "" : (effectiveAppState.dockerSocketMounted ? "ready" : "limited")}`}>
                  {panelOnlyMode ? "Unsupported" : (demoMode ? "Demo override" : effectiveAppState.dockerSocketMounted ? "Connected" : "Not mounted")}
                </span>
              </div>
            </section>
          </section>
        )}

        {activePage === "nodes" && (
          <NodesPage
            nodes={contextNodes}
            panelVersion={appVersion}
            canManageNodes={canManageUsers}
            busy={Boolean(nodeBusyId)}
            busyNodeId={nodeBusyId}
            defaultPanelUrl={currentPanelUrl()}
            selectedNode={nodeDetails}
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
          <section className="emptyState">
            <h2>Welcome to ServerSentinel</h2>
            {panelOnlyMode && usableContextNodes.length === 0 ? (
              <>
                <p>No node is connected yet. Add a node first so ServerSentinel has a host where it can create Minecraft servers.</p>
                <button
                  onClick={() => {
                    setActivePage("nodes");
                    setAddNodeResult(null);
                    setNodeInstallMethod("run");
                    if (canManageUsers) setAddNodeOpen(true);
                  }}
                  disabled={demoMode || isProvisioning || Boolean(nodeBusyId) || !canManageUsers}
                  title={demoMode ? "Exit demo mode before adding real nodes." : isProvisioning ? provisioningNavigationReason : nodeBusyId ? "A node action is already in progress." : !canManageUsers ? "Manage users permission is required." : "Add a remote node"}
                >
                  Add node
                </button>
              </>
            ) : (
              <>
                <p>No managed servers have been created yet. Create one to set up Fabric files and start managing a Minecraft server from this panel.</p>
                <button onClick={() => openCreateServerForNode()} disabled={demoMode || isProvisioning || serverCreationBlocked || !canCreateServers} title={demoMode || isProvisioning || serverCreationBlocked || !canCreateServers ? createServerDisabledReason : "Create a managed server"}>Create managed server</button>
              </>
            )}
          </section>
        )}

        {applicationReady && isServerWorkspacePage(activePage) && !activeServer && effectiveAppState.servers.length > 0 && (
          <section className="emptyState">
            <h2>No server selected</h2>
            <p>A server exists, but none is open right now. Choose one from the Servers page to view its console, files, mods, and settings.</p>
            <button onClick={() => setActivePage("servers")}>Open servers</button>
          </section>
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
                    <strong>{activeServer.displayName}</strong>
                  </div>
                  <div className="serverStripMetaRow">
                    <span className={`runtimeBadge ${runtimeTone(activeStatus, activeServerDockerSocketMounted)}`}>
                      {runtimeLabel(activeStatus, activeServerDockerSocketMounted)}
                    </span>
                    <small className="serverStripMeta">
                      Fabric {activeMinecraftVersion === "Unknown" ? "version unknown" : activeMinecraftVersion}
                    </small>
                    <small className="serverStripMeta nodeStripMeta">
                      <span className={`nodeStatusDot ${activeNode.status}`} aria-hidden="true" />
                      {activeNode.name}
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
                />
                <button
                  type="button"
                  className={`quickActionButton consoleLink ${activePage === "console" ? "active" : ""}`}
                  onClick={() => setActivePage("console")}
                  title="Open console"
                >
                  <svg className="buttonIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="4 17 10 11 4 5" />
                    <line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                  <span>Console</span>
                </button>
                <div className="overflowMenuContainer">
                  <button
                    type="button"
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
                  </button>
                  {overflowOpen && (
                    <div className="overflowDropdown" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => {
                          refreshStatus();
                          setOverflowOpen(false);
                        }}
                        disabled={isProvisioning}
                        title={isProvisioning ? provisioningNavigationReason : "Refresh server status"}
                      >
                        Refresh status
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          downloadConsoleLogs();
                          setOverflowOpen(false);
                        }}
                        disabled={logs.length === 0}
                        title={logs.length === 0 ? "No console log lines are available to download." : "Download console log"}
                      >
                        Download log
                      </button>
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
                {overviewLoading && (
                  <InlineState
                    tone="loading"
                    title="Loading overview"
                    message="Loading server activity, health, and recent events."
                  />
                )}
                {overviewError && (
                  <InlineState
                    tone="warning"
                    title="Overview is not up to date"
                    message={`${overviewError} Previously loaded activity is still shown when available.`}
                    actionLabel="Retry"
                    onAction={() => {
                      setOverviewError("");
                      setOverviewLoading(true);
                      void api<ServerOverviewData>(`/api/servers/${activeServer.id}/events`)
                        .then((data) => setOverviewData(data))
                        .catch((error) => setOverviewError(errorMessage(error, "Could not load overview activity. Previously loaded data is preserved.")))
                        .finally(() => setOverviewLoading(false));
                    }}
                    busy={overviewLoading}
                  />
                )}
                <OverviewSummary
                  server={activeServer}
                  status={activeStatus}
                  dockerSocketMounted={activeServerDockerSocketMounted}
                  activity={overviewData.activity}
                  formatDate={formatDisplayDate}
                />

                <ResourcePanel
                  server={activeServer}
                  samples={resourceSamples}
                  status={activeStatus}
                  dockerSocketMounted={activeServerDockerSocketMounted}
                  formatNumber={formatDisplayNumber}
                />

                <ActivityHealthPanel activity={overviewData.activity} formatDate={formatDisplayDate} />
                <RecentEventsPanel events={overviewData.events} eventsStatus={overviewData.eventsStatus} onOpenConsole={() => setActivePage("console")} />

              </section>
            )}

            {activePage === "console" && (
              <section className="tabPage">
                <section className="panel consolePanel">
                  <div className="panelHeader">
                    <h2>Console</h2>
                    <div className="consoleHeaderActions">
                      <button type="button" onClick={downloadConsoleLogs} disabled={logs.length === 0} title={logs.length === 0 ? "No console log lines are available to download." : "Download console log"}>
                        Download log
                      </button>
                      <span className="muted">
                        {activeStatus?.commandInputAvailable
                          ? "Command input enabled"
                          : activeStatus?.commandInputMessage === "Start the runtime container before sending console commands" ||
                            activeStatus?.commandInputMessage === "Start the server before sending console commands." ||
                            activeStatus?.commandInputMessage === "Start the demo server to enable simulated console input."
                          ? ""
                          : activeStatus?.commandInputMessage}
                      </span>
                    </div>
                  </div>
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
                    <div className="console" ref={consoleRef} onScroll={handleConsoleScroll}>
                      {logs.length ? <ConsoleLog entries={logs} /> : <span className="terminalMuted">No console output yet. Start the server or wait for new log lines to appear.</span>}
                    </div>
                    {pendingConsoleEntries > 0 && (
                      <button type="button" className="consoleNotice" onClick={jumpToLatestLogs}>
                        {pendingConsoleEntries} new {pendingConsoleEntries === 1 ? "entry" : "entries"} - Jump to latest
                      </button>
                    )}
                    <form onSubmit={sendCommand} className="terminalPrompt">
                      <span>&gt;</span>
                      <div className="commandInputWrap">
                        <input
                          value={commandInput}
                          onChange={(event) => {
                            setCommandInput(event.target.value);
                            setHistoryIndex(null);
                          }}
                          onKeyDown={handleCommandKeyDown}
                          onFocus={() => setCommandInputFocused(true)}
                          onBlur={() => window.setTimeout(() => setCommandInputFocused(false), 120)}
                          placeholder={
                            activeStatus?.commandInputAvailable
                              ? "Enter command"
                              : activeStatus?.commandInputMessage === "Start the runtime container before sending console commands"
                              ? "Start the runtime container before sending console commands"
                              : activeStatus?.commandInputMessage === "Start the server before sending console commands."
                              ? "Start the server before sending console commands."
                              : activeStatus?.commandInputMessage === "Start the demo server to enable simulated console input."
                              ? "Start the demo server to enable simulated console input."
                              : "Console input unavailable"
                          }
                          disabled={isProvisioning || dockerOperationalLock || !canExpanded || !activeStatus?.commandInputAvailable}
                          title={isProvisioning || dockerOperationalLock || !canExpanded || !activeStatus?.commandInputAvailable ? consoleCommandDisabledReason : "Enter a console command"}
                          spellCheck={false}
                          autoComplete="off"
                        />
                        {commandInputFocused && commandInput.trim().length > 0 && activeStatus?.commandInputAvailable && commandSuggestions.length > 0 && (
                          <div className="suggestions">
                            {commandSuggestions.map((suggestion) => (
                              <button
                                key={suggestion.command}
                                type="button"
                                onClick={() => {
                                  setCommandInput(suggestion.command);
                                  setHistoryIndex(null);
                                }}
                              >
                                <strong>{suggestion.command}</strong>
                                <span>{suggestion.description}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <button disabled={commandSending || isProvisioning || dockerOperationalLock || !canExpanded || !activeStatus?.commandInputAvailable || !commandInput.trim()} title={consoleCommandDisabledReason || "Send command"}>
                        {commandSending ? "Sending" : "Send"}
                      </button>
                    </form>
                  </div>
                </section>
              </section>
            )}

            {activePage === "files" && (
              <section className="tabPage filesPage">
                <section className="filesExplorer">
                  <section className="panel filesPanel">
                    <div className="fileNavBar">
                      <div className="fileNavButtons">
                        <button type="button" className="iconOnlyButton" onClick={navigateBackFiles} disabled={isProvisioning || fileBackStack.length === 0} title={fileBackStack.length === 0 ? "No previous folder" : "Back"} aria-label="Back">
                          <AppIcon name="chevronLeft" />
                        </button>
                        <button type="button" className="iconOnlyButton" onClick={navigateForwardFiles} disabled={isProvisioning || fileForwardStack.length === 0} title={fileForwardStack.length === 0 ? "No forward folder" : "Forward"} aria-label="Forward">
                          <AppIcon name="chevronRight" />
                        </button>
                        <button type="button" className="iconOnlyButton" onClick={() => void navigateFiles("/")} disabled={isProvisioning || listing.path === "/"} title={listing.path === "/" ? "Already at server root" : "Go to server root"} aria-label="Go to server root">
                          <AppIcon name="home" />
                        </button>
                      </div>
                      <div className="fileBreadcrumbs" aria-label="Current folder">
                        {fileBreadcrumbs.map((crumb) => (
                          <button key={crumb.path} type="button" onClick={() => void navigateFiles(crumb.path)} className={crumb.path === listing.path ? "active" : ""} title={crumb.path}>
                            {crumb.label}
                          </button>
                        ))}
                      </div>
                      <div className="fileToolbar">
                        <input ref={fileUploadRef} className="hiddenInput" type="file" onChange={uploadFile} />
                        <button type="button" className="secondaryButton compactButton" onClick={() => fileUploadRef.current?.click()} disabled={isProvisioning || dockerOperationalLock || !canManager || Boolean(fileOperationBusy)} title={fileActionBlockedReason || "Upload a file to this folder"}>
                          <AppIcon name="fileUp" />
                          Upload
                        </button>
                        <button type="button" className="secondaryButton compactButton" onClick={createFolder} disabled={isProvisioning || dockerOperationalLock || !canManager || Boolean(fileOperationBusy)} title={fileActionBlockedReason || "Create a folder here"}>
                          <AppIcon name="folderPlus" />
                          New folder
                        </button>
                        <button type="button" className="secondaryButton compactButton" onClick={() => loadFiles(activeServer.id, listing.path)} disabled={isProvisioning || filesLoading} title="Reload this folder">
                          <AppIcon name="refresh" />
                          {filesLoading ? "Refreshing" : "Refresh"}
                        </button>
                      </div>
                    </div>

                    <div className="selectionActionBar" aria-label="File selection actions">
                      <span className="selectionSummary">{selectionSummary}</span>
                      <div className="selectionActions">
                        <button type="button" className="secondaryButton compactButton" onClick={() => selectedEntry && openFile(selectedEntry.path)} disabled={!canEditSelectedFile} title={!selectedEntry ? "Select one editable file" : selectedEntry.type !== "file" ? "Folders cannot be edited" : !isEditableFile(selectedEntry) ? "Only small text files can be edited" : fileActionBlockedReason || "Edit selected file"}>
                          <AppIcon name="edit" />
                          Edit
                        </button>
                        <button type="button" className="secondaryButton compactButton" onClick={downloadSelectedFile} disabled={!canDownloadSelectedFile} title={!selectedEntry ? "Select one file to download" : selectedEntry.type !== "file" ? "Folders cannot be downloaded from this toolbar" : fileReadActionBlockedReason || "Download selected file"}>
                          <AppIcon name="download" />
                          Download
                        </button>
                        <button type="button" className="secondaryButton compactButton" onClick={duplicateSelectedFile} disabled={!canDuplicateSelectedFile} title={!selectedEntry ? "Select one file to duplicate" : selectedEntry.type === "directory" ? "Directory duplication is not supported" : fileActionBlockedReason || "Duplicate selected file"}>
                          <AppIcon name="copy" />
                          Duplicate
                        </button>
                        <button type="button" className="secondaryButton compactButton" onClick={renameSelectedFile} disabled={!canRenameSelectedItem} title={!selectedEntry ? "Select one item to rename" : fileActionBlockedReason || "Rename selected item"}>
                          <AppIcon name="rename" />
                          Rename
                        </button>
                        <button type="button" className="dangerButton compactButton" onClick={deleteSelectedFiles} disabled={!canDeleteSelectedItems} title={!selectedEntries.length ? "Select items to delete" : fileActionBlockedReason || "Delete selected items"}>
                          <AppIcon name="trash" />
                          Delete
                        </button>
                      </div>
                    </div>

                    {filesLoading && listing.entries.length === 0 && (
                      <InlineState tone="loading" title="Loading files" message={`Loading the contents of ${listing.path}.`} />
                    )}
                    {filesError && (
                      <InlineState
                        tone="error"
                        title="Could not load this folder"
                        message={`${filesError} Check that the server files are available, then retry.`}
                        actionLabel="Retry"
                        onAction={() => void loadFiles(activeServer.id, listing.path)}
                        busy={filesLoading}
                      />
                    )}

                    <div className="fileTable" role="table" aria-label="Server files">
                      <div className="fileTableHead" role="row">
                        <label className="fileCheckboxCell fileSelectAllCell" aria-label={allVisibleFilesSelected ? "Clear visible selection" : "Select all visible files"}>
                          <input
                            ref={fileSelectAllRef}
                            type="checkbox"
                            checked={allVisibleFilesSelected}
                            disabled={sortedFileEntries.length === 0}
                            onChange={(event) => {
                              const checked = event.target.checked;
                              setSelectedFilePaths((current) => {
                                const visible = new Set(visibleFilePaths);
                                return checked
                                  ? [...new Set([...current, ...visibleFilePaths])]
                                  : current.filter((path) => !visible.has(path));
                              });
                            }}
                          />
                        </label>
                        {([
                          ["name", "Name"],
                          ["modifiedAt", "Date Modified"],
                          ["type", "Type"],
                          ["size", "Size"]
                        ] as Array<[FileSortKey, string]>).map(([key, label]) => (
                          <button key={key} type="button" onClick={() => setFileSort((current) => current.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" })}>
                            {label}
                            {fileSort.key === key ? (fileSort.direction === "asc" ? " asc" : " desc") : ""}
                          </button>
                        ))}
                      </div>
                      {!filesLoading && !filesError && sortedFileEntries.length === 0 && (
                        <InlineState tone="empty" title="This folder is empty" message="There are no files or folders here yet. Upload a file or create a folder to add content." />
                      )}
                      {sortedFileEntries.map((entry) => {
                        const selected = selectedFilePaths.includes(entry.path);
                        return (
                          <div key={entry.path} className={`fileTableRow ${selected ? "selected" : ""}`} role="row" onDoubleClick={() => entry.type === "directory" ? navigateFiles(entry.path) : openFile(entry.path)}>
                            <label className="fileCheckboxCell" aria-label={`Select ${entry.name}`}>
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={(event) => {
                                  const checked = event.target.checked;
                                  setSelectedFilePaths((current) => checked ? [...new Set([...current, entry.path])] : current.filter((path) => path !== entry.path));
                                }}
                              />
                            </label>
                            <button type="button" className="fileNameCell" onClick={() => entry.type === "directory" ? navigateFiles(entry.path) : setSelectedFilePaths([entry.path])} title={entry.path}>
                              <FileTypeIcon entry={entry} />
                              <span>{entry.name}</span>
                            </button>
                            <span>{dateTimeFormatter.format(new Date(entry.modifiedAt))}</span>
                            <span>{fileDisplayType(entry)}</span>
                            <span>{entry.type === "file" ? formatBytes(entry.size) : "-"}</span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="fileTableFooter">
                      <span>{sortedFileEntries.length} items</span>
                      <span>{selectedEntries.length > 0 ? `${selectedEntries.length} selected (${formatBytes(selectedTotalSize)})` : listing.path}</span>
                    </div>
                  </section>

                </section>

                <aside className="panel fileDetailsPanel">
                  {!selectedEntry && selectedEntries.length === 0 && (
                    <div className="fileDetailsEmpty">
                      <h2>No file selected</h2>
                      <p>Select a file or folder from the list to view details. Text files will also show a read-only preview here.</p>
                    </div>
                  )}
                  {selectedEntries.length > 1 && (
                    <div className="fileDetailsContent">
                      <h2>{selectedEntries.length} items selected</h2>
                      <dl>
                        <div><dt>Total file size</dt><dd>{formatBytes(selectedTotalSize)}</dd></div>
                        <div><dt>Folders</dt><dd>{selectedEntries.filter((entry) => entry.type === "directory").length}</dd></div>
                        <div><dt>Files</dt><dd>{selectedEntries.filter((entry) => entry.type === "file").length}</dd></div>
                      </dl>
                    </div>
                  )}
                  {selectedEntry && (
                    <div className="fileDetailsContent">
                      <div className="fileDetailsTitle">
                        <FileTypeIcon entry={selectedEntry} />
                        <div>
                          <h2>{selectedEntry.name}</h2>
                          <span>{fileDisplayType(selectedEntry)}</span>
                        </div>
                      </div>
                      <dl>
                        <div><dt>Location</dt><dd>{selectedEntry.path}</dd></div>
                        <div><dt>Type</dt><dd>{fileDisplayType(selectedEntry)}</dd></div>
                        <div><dt>Size</dt><dd>{selectedEntry.type === "file" ? formatBytes(selectedEntry.size) : "-"}</dd></div>
                        <div><dt>Modified</dt><dd>{dateTimeFormatter.format(new Date(selectedEntry.modifiedAt))}</dd></div>
                        {selectedEntry.permissions && <div><dt>Permissions</dt><dd>{selectedEntry.permissions}</dd></div>}
                        {selectedEntry.owner && <div><dt>Owner</dt><dd>{selectedEntry.owner}</dd></div>}
                        <div><dt>Status</dt><dd>{fileStatusLabel(selectedEntry)}</dd></div>
                      </dl>
                      <section className="filePreviewPanel">
                        <h3>Preview</h3>
                        {filePreview.loading && <InlineState tone="loading" title="Loading preview" message="Reading a small preview of this file." />}
                        {filePreview.error && <InlineState tone="error" title="Preview is unavailable" message={`${filePreview.error} You can still download or edit supported text files from the toolbar.`} />}
                        {!filePreview.loading && !filePreview.error && filePreview.data?.preview === "text" && (
                          <pre>
                            {(filePreview.data.content ?? "").split(/\r?\n/).slice(0, 80).map((line, index) => (
                              <span key={`${index}-${line.slice(0, 8)}`}><b>{index + 1}</b>{line || " "}</span>
                            ))}
                          </pre>
                        )}
                        {!filePreview.loading && !filePreview.error && filePreview.data?.preview !== "text" && (
                          <div className="previewUnavailable">
                            <strong>Preview unavailable</strong>
                            <span>{filePreview.data?.message ?? "This item cannot be previewed here. You can still use the available file actions above."}</span>
                          </div>
                        )}
                      </section>
                    </div>
                  )}
                </aside>

                <FileEditorModal
                  selectedPath={selectedPath}
                  editorText={editorText}
                  dirty={dirty}
                  fileOpening={fileOpening}
                  fileOpenFailed={fileOpenFailed}
                  fileReadError={fileReadError}
                  fileSaving={fileSaving}
                  editorDisabled={isProvisioning || dockerOperationalLock || !canManager || !selectedPath || fileOpenFailed}
                  saveDisabled={fileSaving || isProvisioning || dockerOperationalLock || !canManager || !selectedPath || !dirty || fileOpening || fileOpenFailed}
                  discardRequestOpen={Boolean(discardEditorRequest)}
                  onTextChange={(nextText) => {
                    setEditorText(nextText);
                    setDirty(nextText !== savedEditorText);
                  }}
                  onRequestClose={requestCloseEditor}
                  onCancel={cancelFileEdit}
                  onSave={saveFile}
                  onRetryOpen={() => {
                    if (selectedPath) void openFile(selectedPath, true);
                  }}
                  onKeepEditing={() => setDiscardEditorRequest(null)}
                  onDiscardChanges={discardEditorChanges}
                />
              </section>
            )}

            {activePage === "mods" && (
              <section className="tabPage">
                <section className="panel modsPanel">
                  <div className="panelHeader modsPanelHeader">
                    <div className="modsPanelHeaderLeft">
                      {modsView === "search" && (
                        <button
                          type="button"
                          className="secondaryButton compactButton"
                          onClick={() => {
                            setQuery("");
                            setModSearchResults([]);
                            setModsView("manager");
                          }}
                        >
                          Back to Installed Mods
                        </button>
                      )}
                      <h2>{modsView === "search" ? "Search Modrinth Mods" : "Installed Mods"}</h2>
                    </div>
                    <div className="modsContext modsContextRow">
                      <span className={modsLocked || modServerRunning ? "warn" : "ok"}>
                        {!activeStatus ? "Checking server state" : activeStatus.docker.running ? "Server running" : "Mod changes enabled"}
                      </span>
                    </div>
                  </div>
                  {!effectiveAppState.modrinthApiConfigured && (
                    <section className="systemBanner accent">
                      <strong>Modrinth API key is not configured.</strong>
                      <span>Installed mod management still works. Add a key in Settings to search and install new mods.</span>
                    </section>
                  )}
                  <input ref={modUploadRef} className="hiddenInput" type="file" accept=".jar" onChange={uploadMod} />

                  {modsView === "manager" && (
                    <div className="mods">
                      <div className="modsCardsGrid">
                        <button
                          type="button"
                          className="modsCard"
                          onClick={() => {
                            if (warnIfModServerRunning()) return;
                            setModsView("search");
                          }}
                          disabled={isProvisioning || !canManager || !effectiveAppState.modrinthApiConfigured}
                        >
                          <span className="modsCardIcon">
                            <AppIcon name="plus" />
                          </span>
                          <div className="modsCardText">
                            <strong>Add mod from Modrinth</strong>
                            <p>Search Modrinth for compatible Fabric mods.</p>
                          </div>
                        </button>
                        <button
                          type="button"
                          className="modsCard"
                          onClick={() => {
                            if (warnIfModServerRunning()) return;
                            modUploadRef.current?.click();
                          }}
                          disabled={modsLocked}
                        >
                          <span className="modsCardIcon">
                            <AppIcon name="fileUp" />
                          </span>
                          <div className="modsCardText">
                            <strong>Upload jar</strong>
                            <p>Add a local Fabric mod file to this server.</p>
                          </div>
                        </button>
                      </div>

                      <div className="modsToolbarCompact">
                        <div className="modsSearchInputCompact">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="square" strokeLinejoin="miter">
                            <circle cx="11" cy="11" r="6" />
                            <path d="m16 16 4 4" />
                          </svg>
                          <input
                            type="text"
                            placeholder="Search installed mods..."
                            value={installedQuery}
                            onChange={(e) => setInstalledQuery(e.target.value)}
                          />
                        </div>
                      </div>

                      {modsLoading && installedMods.length === 0 && (
                        <InlineState tone="loading" title="Loading installed mods" message="Checking the server mods folder and compatibility information." />
                      )}
                      {modsError && (
                        <InlineState
                          tone="error"
                          title="Could not load installed mods"
                          message={`${modsError} Check that the mods folder is available, then retry.`}
                          actionLabel="Retry"
                          onAction={() => void loadInstalledMods(activeServer.id)}
                          busy={modsLoading}
                        />
                      )}

                      <div className="modsTableFrame">
                        <div className="modsTable">
                          <div className="modsTableHeader">
                            <div className="modsTableCell">Mod</div>
                            <div className="modsTableCell">Compatibility</div>
                            <div className="modsTableCell">Installed Version</div>
                            <div className="modsTableCell">Update Status</div>
                            <div className="modsTableCell">Source</div>
                            <div className="modsTableCell">Status</div>
                            <div className="modsTableCell alignEnd">Actions</div>
                          </div>

                          <div className="modsTableBody">
                            {filteredInstalledMods.length === 0 ? (
                              <div className="emptyInline noBorder">
                                <strong>{installedMods.length === 0 ? "No installed mods" : "No matching mods"}</strong>
                                <span>{installedMods.length === 0 ? "This server does not have any mods installed yet. Add one from Modrinth or upload a jar file to get started." : "No installed mods match this search. Clear or change the search text to see the full list."}</span>
                              </div>
                            ) : (
                              filteredInstalledMods.map((mod) => {
                                const isComp = mod.compatibility?.compatible;
                                const compStatus = mod.compatibility?.status;
                                const iconSrc = modIconSource(mod.iconUrl);
                                return (
                                  <article key={mod.filename} className={`modsTableRow ${mod.enabled ? "" : "disabled"}`}>
                                <div className="modsTableCell mod-col">
                                  <div className="modInfoCol">
                                    {iconSrc ? (
                                      <img src={iconSrc} alt={mod.displayName} />
                                    ) : (
                                      <div className="modFileIcon">JAR</div>
                                    )}
                                    <div className="modInfoText">
                                      <strong>{mod.displayName}</strong>
                                      <span className="filename">{mod.filename}</span>
                                      {mod.description && (
                                        <p className="description">{mod.description}</p>
                                      )}
                                    </div>
                                  </div>
                                </div>

                                <div className="modsTableCell" data-label="Compatibility">
                                  <div className="compatCol">
                                    <span className={`compatStatus ${
                                      isComp
                                        ? "compatible"
                                        : (compStatus === "unknown" || mod.compatibility?.serverSide === "unknown" || mod.compatibility?.reason === "Server-side support unknown")
                                          ? "unknown"
                                          : "incompatible"
                                    }`}>
                                      {isComp ? (
                                        <>
                                          <svg className="buttonIcon statusIconSmall" viewBox="0 0 24 24">
                                            <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" />
                                          </svg>
                                          <span>Compatible</span>
                                        </>
                                      ) : (compStatus === "unknown" || mod.compatibility?.serverSide === "unknown" || mod.compatibility?.reason === "Server-side support unknown") ? (
                                        <>
                                          <svg className="buttonIcon statusIconSmall" viewBox="0 0 24 24">
                                            <path d="M12 9v4m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
                                          </svg>
                                          <span>{compatibilityLabel(mod.compatibility)}</span>
                                        </>
                                      ) : (
                                        <>
                                          <svg className="buttonIcon statusIconSmall" viewBox="0 0 24 24">
                                            <path d="M18 6 6 18M6 6l12 12" fill="none" stroke="currentColor" />
                                          </svg>
                                          <span>{compatibilityLabel(mod.compatibility)}</span>
                                        </>
                                      )}
                                    </span>
                                    {mod.compatibility?.reason && (
                                      <span className="compatMeta">{mod.compatibility.reason}</span>
                                    )}
                                  </div>
                                </div>

                                <div className="modsTableCell" data-label="Version">
                                  <div className="compatCol">
                                    <span className="strongValue">{mod.versionInfo?.currentVersion || mod.modrinth?.versionNumber || "Unknown"}</span>
                                    {mod.modrinth?.loaders && mod.modrinth.loaders.length > 0 && (
                                      <span className="compatMeta capitalize">
                                        {mod.modrinth.loaders.join(", ")}
                                      </span>
                                    )}
                                  </div>
                                </div>

                                <div className="modsTableCell" data-label="Update">
                                  <div className="updateCol">
                                    {mod.versionInfo?.upToDate === true ? (
                                      <span className="updateStatus up-to-date">
                                        <svg className="buttonIcon statusIconSmall" viewBox="0 0 24 24">
                                          <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" />
                                        </svg>
                                        <span>Up to date</span>
                                      </span>
                                    ) : mod.versionInfo?.upToDate === false ? (
                                      <>
                                        <span className="updateStatus update-available">
                                          <svg className="buttonIcon statusIconSmall" viewBox="0 0 24 24">
                                            <path d="m12 5 7 7-7 7M5 12h14" fill="none" stroke="currentColor" />
                                          </svg>
                                          <span>Update available</span>
                                        </span>
                                        <span className="updateMeta" title={mod.versionInfo.latestVersion ? `Latest: ${mod.versionInfo.latestVersion}` : "Latest version could not be determined"}>
                                          {mod.versionInfo.latestVersion ? (
                                            <>
                                              Latest: <span className="updateVersionText">{mod.versionInfo.latestVersion}</span>
                                            </>
                                          ) : (
                                            "Latest unknown"
                                          )}
                                        </span>
                                      </>
                                    ) : (
                                      <span className="updateStatus unknown">Unknown</span>
                                    )}
                                  </div>
                                </div>

                                <div className="modsTableCell" data-label="Source">
                                  <div className="sourceCol">
                                    {mod.modrinth ? "Modrinth" : "Uploaded"}
                                  </div>
                                </div>

                                <div className="modsTableCell" data-label="Status">
                                  <label className="switch">
                                    <input
                                      type="checkbox"
                                      checked={mod.enabled}
                                      onChange={() => setInstalledModEnabled(mod, !mod.enabled)}
                                      disabled={modToggleLocked}
                                    />
                                    <span className="slider"></span>
                                    <span className={`switchStateLabel ${mod.enabled ? "enabled" : ""}`}>
                                      {mod.enabled ? "Enabled" : "Disabled"}
                                    </span>
                                  </label>
                                </div>

                                <div className="modsTableCell actions" data-label="Actions">
                                  <button className="secondaryButton" onClick={() => setDetailsMod(mod)}>Details</button>
                                  {mod.versionInfo?.upToDate === false && (
                                    <button
                                      className="warningTextButton"
                                      onClick={() => updateMod(mod)}
                                      disabled={modsLocked}
                                    >
                                      Update
                                    </button>
                                  )}
                                  <button className="dangerTextButton" onClick={() => removeInstalledMod(mod)} disabled={modsLocked}>Remove</button>
                                </div>
                                  </article>
                                );
                              })
                            )}
                          </div>
                        </div>
                      </div>

                    </div>
                  )}

                  {modsView === "search" && (
                    <div className={`modSearchView ${isSearchingMods ? "searching" : ""} ${!query.trim() && !isSearchingMods && !modSearchError && modSearchResults.length === 0 ? "empty" : ""}`}>
                      <form onSubmit={searchMods} className="modSearchToolbar">
                        <label className="modSearchInput">
                          <span aria-hidden="true">
                            <svg viewBox="0 0 24 24">
                              <circle cx="11" cy="11" r="6" />
                              <path d="m16 16 4 4" />
                            </svg>
                          </span>
                          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Modrinth mods..." disabled={isProvisioning || !canManager || !effectiveAppState.modrinthApiConfigured || activeModVersionsUnknown} />
                        </label>
                        <button className="modSearchButton" disabled={isProvisioning || !canManager || isSearchingMods || !effectiveAppState.modrinthApiConfigured || activeModVersionsUnknown || !query.trim()}>{isSearchingMods ? "Searching" : "Search"}</button>
                      </form>
                      <div className={`modResultsHeader ${isSearchingMods || query.trim() || modSearchResults.length > 0 || modSearchError ? "" : "placeholder"}`} aria-hidden={!(isSearchingMods || query.trim() || modSearchResults.length > 0 || modSearchError)}>
                        <strong>Search results</strong>
                        <span>{isSearchingMods ? "Searching..." : query.trim() ? (modSearchTotal > 0 ? `${formatDisplayNumber(modSearchResults.length)} of ${formatDisplayNumber(modSearchTotal)} shown` : `${formatDisplayNumber(modSearchResults.length)} shown`) : "No query entered"}</span>
                      </div>
                      <div className="mods">
                        {isSearchingMods && Array.from({ length: 4 }, (_, index) => (
                          <article key={`mod-skeleton-${index}`} className="modRow modSkeleton" aria-hidden="true">
                            <span className="skeletonBlock icon" />
                            <div>
                              <span className="skeletonBlock title" />
                              <span className="skeletonBlock line" />
                              <span className="skeletonBlock meta" />
                            </div>
                            <span className="skeletonBlock button" />
                          </article>
                        ))}
                        {!isSearchingMods && !effectiveAppState.modrinthApiConfigured && (
                          <div className="emptyInline">
                            <strong>Modrinth API key is not configured</strong>
                            <span>Add an API key in Settings to search and install mods from Modrinth.</span>
                          </div>
                        )}
                        {!isSearchingMods && effectiveAppState.modrinthApiConfigured && activeModVersionsUnknown && (
                          <div className="emptyInline">
                            <strong>Server version unknown</strong>
                            <span>{activeModContext}. Set the Minecraft and Fabric versions in server settings, then search again.</span>
                          </div>
                        )}
                        {!isSearchingMods && effectiveAppState.modrinthApiConfigured && !activeModVersionsUnknown && !query.trim() && (
                          <div className="emptyInline">
                            <strong>Search Modrinth mods</strong>
                            <span>Enter a mod name to find Fabric mods that fit this server.</span>
                          </div>
                        )}
                        {!isSearchingMods && modSearchError && (
                          <InlineState
                            tone="error"
                            title="Search failed"
                            message={`${modSearchError} Try again, or check the Modrinth API key in Settings.`}
                            actionLabel={query.trim() ? "Retry search" : undefined}
                            onAction={query.trim() ? () => {
                              setModSearchError("");
                              void searchMods({ preventDefault() {} } as FormEvent);
                            } : undefined}
                            busy={isSearchingMods}
                          />
                        )}
                        {!isSearchingMods && !modSearchError && query.trim() && modSearchResults.length === 0 && (
                          <div className="emptyInline">
                            <strong>No mods found</strong>
                            <span>No Modrinth results matched this search. Try a different mod name or a shorter search term.</span>
                          </div>
                        )}
                        {!isSearchingMods && modSearchResults.map((mod) => {
                          const iconSrc = modIconSource(mod.icon_url);
                          const alreadyInstalled = installedModrinthProjectIds.has(mod.project_id);
                          return (
                            <article key={mod.project_id} className="modRow modSearchResult">
                              {iconSrc ? <img src={iconSrc} alt="" /> : <div className="modFileIcon">MOD</div>}
                              <div className="modResultMain">
                                <div className="modTitleLine">
                                  <strong>{mod.title}</strong>
                                </div>
                                <p>{mod.description}</p>
                                <small>
                                  {formatDisplayNumber(mod.downloads)} downloads
                                  {formatOptionalModDate(mod.date_modified) && ` - ${formatOptionalModDate(mod.date_modified)}`}
                                </small>
                              </div>
                              <div className="modCompatibilityColumn">
                                <span className={`compatibilityBadge ${compatibilityClass(mod.compatibility)}`}>
                                  {compatibilityLabel(mod.compatibility)}
                                </span>
                                <p className={mod.compatibility?.compatible ? "compatibilityReason ok" : "compatibilityReason"}>{modCompatibilityNote(mod)}</p>
                              </div>
                              <div className="modResultAction">
                                {alreadyInstalled ? (
                                  <button type="button" className="installedSearchButton" disabled title="This mod is already installed">
                                    Installed
                                  </button>
                                ) : (
                                  <button onClick={() => openModInstallModal(mod)} disabled={modsLocked || !effectiveAppState.modrinthApiConfigured}>
                                    {mod.compatibility?.compatible ? "Install" : "Review"}
                                  </button>
                                )}
                              </div>
                            </article>
                          );
                        })}
                        {isLoadingMoreMods && Array.from({ length: 2 }, (_, index) => (
                          <article key={`mod-loadmore-skeleton-${index}`} className="modRow modSkeleton" aria-hidden="true" style={{ opacity: 0.6 }}>
                            <span className="skeletonBlock icon" />
                            <div>
                              <span className="skeletonBlock title" />
                              <span className="skeletonBlock line" />
                              <span className="skeletonBlock meta" />
                            </div>
                            <span className="skeletonBlock button" />
                          </article>
                        ))}
                        {modSearchResults.length > 0 && modSearchResults.length < modSearchTotal && (
                          <div ref={sentinelRef} style={{ height: "1px", margin: "10px 0" }} />
                        )}
                      </div>
                    </div>
                  )}
                  {modInstallModal && (
                    <div className="modalBackdrop modInstallBackdrop" role="presentation">
                      <section className="modalPanel modInstallPanel" role="dialog" aria-modal="true" aria-labelledby="mod-install-title">
                        <div className="modInstallHeader">
                          <div className="modInstallTitleBlock">
                            <h2 id="mod-install-title">{modInstallModal.step === 2 ? `Install ${modInstallModal.data?.project.title || modInstallModal.mod.title}` : "Install mod"}</h2>
                            {modInstallModal.step === 1 && <strong>{modInstallModal.data?.project.title || modInstallModal.mod.title}</strong>}
                          </div>
                          <button type="button" className="iconButton modalCloseButton" onClick={() => setModInstallModal(null)} disabled={modInstallModal.installing} aria-label="Close install modal" title={modInstallModal.installing ? "Mod install is still running." : "Close install modal"}>
                            <AppIcon name="x" />
                          </button>
                        </div>

                        <div className="modInstallBody">
                          <div className="modInstallStepper" aria-label="Install progress">
                            <div className={modInstallModal.step === 2 ? "completed" : "active"}><span>{modInstallModal.step === 2 ? <AppIcon name="check" /> : "1"}</span><strong>Select version</strong></div>
                            <i />
                            <div className={modInstallModal.step === 2 ? "active" : ""}><span>2</span><strong>Confirm & install</strong></div>
                            <i />
                            <div><span>3</span><strong>Install</strong></div>
                          </div>

                          {modInstallModal.step === 1 && (
                            <>
                              <div className="modInstallTargetSummary">
                                <div>
                                  <small>Target server</small>
                                  <strong>{modInstallModal.data?.target.serverName || activeServer?.displayName || "Server"}</strong>
                                </div>
                                <div>
                                  <small>Minecraft</small>
                                  <strong>{modInstallModal.data?.target.minecraftVersion || activeServer?.minecraftVersion || "Unknown"}</strong>
                                </div>
                                <div>
                                  <small>Loader</small>
                                  <strong>{modInstallModal.data?.target.loader || "Fabric"}</strong>
                                </div>
                                <div>
                                  <small>Server-side support</small>
                                  <strong className={modInstallModal.data?.project.serverSide === "unsupported" ? "dangerText" : "successText"}>
                                    {modSideSupportLabel(modInstallModal.data?.project.serverSide ?? modInstallModal.mod.server_side)}
                                  </strong>
                                </div>
                              </div>

                              <div className="modInstallStepIntro">
                                <h3>Step 1: Select version</h3>
                                <p>Compatible versions for this server are shown first. You can review and select other versions manually if needed.</p>
                              </div>

                              <div className="modInstallChannelRow">
                                <strong>Release channel</strong>
                                <div className="modInstallChannelButtons" role="group" aria-label="Release channel">
                                  {(["release", "beta", "alpha"] as ReleaseChannel[]).map((channel) => (
                                    <button
                                      key={channel}
                                      type="button"
                                      className={modInstallModal.channel === channel ? "active" : ""}
                                      onClick={() => void loadModInstallVersions(modInstallModal.mod, channel)}
                                      disabled={modInstallModal.loading}
                                    >
                                      {channel[0].toUpperCase() + channel.slice(1)}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              {modInstallModal.loading && (
                                <ModInstallVersionSkeleton />
                              )}
                              {!modInstallModal.loading && modInstallModal.error && (
                                <InlineState
                                  tone="error"
                                  title="Versions unavailable"
                                  message={modInstallModal.error}
                                  actionLabel="Retry"
                                  onAction={() => void loadModInstallVersions(modInstallModal.mod, modInstallModal.channel)}
                                />
                              )}

                              {!modInstallModal.loading && modInstallModal.data && (
                                <div className="modInstallVersionGroups">
                                  <section className="modInstallVersionGroup">
                                    <div className="modInstallVersionGroupHeader">
                                      <strong>Compatible versions</strong>
                                      <span>{formatDisplayNumber(modInstallModal.data.compatibleVersions.length)}</span>
                                    </div>
                                    {modInstallModal.data.compatibleVersions.length === 0 ? (
                                      <div className="emptyInline">
                                        <strong>{hasVisibleInstallVersions(modInstallModal.data) ? "No compatible versions found" : "No version available"}</strong>
                                        <span>{hasVisibleInstallVersions(modInstallModal.data) ? "Review other available versions below, or try a different release channel." : `No ${releaseChannelLabel(modInstallModal.channel).toLowerCase()} files are available for this mod.`}</span>
                                      </div>
                                    ) : (
                                      <div className="modInstallVersionTable">
                                        <div className="modInstallVersionTableHeader">
                                          <span>Version</span>
                                          <span>Minecraft</span>
                                          <span>Release type</span>
                                          <span>Published</span>
                                          <span>Size</span>
                                          <span>Status</span>
                                        </div>
                                        {modInstallModal.data.compatibleVersions.map((version) => (
                                          <button
                                            key={version.id}
                                            type="button"
                                            className={`modInstallVersionRow ${modInstallModal.selectedVersionId === version.id ? "selected" : ""}`}
                                            onClick={() => selectInstallVersion(version)}
                                          >
                                            <span><input type="radio" checked={modInstallModal.selectedVersionId === version.id} readOnly />{version.versionNumber}</span>
                                            <span>{formatVersionList(version.minecraftVersions)}</span>
                                            <span>{releaseChannelLabel(version.releaseChannel)}</span>
                                            <span>{version.publishedAt ? formatDisplayDate(version.publishedAt) : "-"}</span>
                                            <span>{version.file?.size ? formatBytes(version.file.size) : "-"}</span>
                                            <span><mark className={`installStatusBadge ${modInstallStatusClass(version)}`}>{version.statusLabel}</mark></span>
                                          </button>
                                        ))}
                                      </div>
                                    )}
                                  </section>

                                  <section className="modInstallVersionGroup">
                                    <button
                                      type="button"
                                      className="modInstallVersionGroupHeader modInstallDisclosure"
                                      aria-expanded={modInstallModal.showOtherVersions}
                                      onClick={() => setModInstallModal((current) => {
                                        if (!current) return current;
                                        const showOtherVersions = !current.showOtherVersions;
                                        return {
                                          ...current,
                                          showOtherVersions,
                                          selectedVersionId: showOtherVersions ? current.selectedVersionId : current.data ? firstSelectableVersionId(current.data) : "",
                                          acknowledgeMinecraftMismatch: false
                                        };
                                      })}
                                    >
                                      <strong>Other available versions</strong>
                                      <span className="modInstallDisclosureMeta">
                                        {formatDisplayNumber(modInstallModal.data.otherVersions.length)}
                                        <AppIcon name={modInstallModal.showOtherVersions ? "chevronUp" : "chevronDown"} />
                                      </span>
                                    </button>
                                    {modInstallModal.showOtherVersions && (
                                      <div className="modInstallVersionTable">
                                        <div className="modInstallVersionTableHeader">
                                          <span>Version</span>
                                          <span>Minecraft</span>
                                          <span>Release type</span>
                                          <span>Published</span>
                                          <span>Size</span>
                                          <span>Status</span>
                                        </div>
                                        {modInstallModal.data.otherVersions.length === 0 ? (
                                          <div className="modInstallVersionEmpty">No other versions matched this release channel.</div>
                                        ) : modInstallModal.data.otherVersions.map((version) => (
                                          <button
                                            key={version.id}
                                            type="button"
                                            className={`modInstallVersionRow ${modInstallModal.selectedVersionId === version.id ? "selected" : ""}`}
                                            onClick={() => selectInstallVersion(version)}
                                            disabled={!version.selectable}
                                            title={!version.selectable ? version.reason : undefined}
                                          >
                                            <span><input type="radio" checked={modInstallModal.selectedVersionId === version.id} readOnly disabled={!version.selectable} />{version.versionNumber}</span>
                                            <span>{formatVersionList(version.minecraftVersions)}</span>
                                            <span>{releaseChannelLabel(version.releaseChannel)}</span>
                                            <span>{version.publishedAt ? formatDisplayDate(version.publishedAt) : "-"}</span>
                                            <span>{version.file?.size ? formatBytes(version.file.size) : "-"}</span>
                                            <span><mark className={`installStatusBadge ${modInstallStatusClass(version)}`}>{version.statusLabel}</mark></span>
                                          </button>
                                        ))}
                                      </div>
                                    )}
                                  </section>

                                  {selectedInstallVersion?.requiresMinecraftAcknowledgement && (
                                    <div className="modInstallRiskBox">
                                      <strong>These versions are not marked as compatible with Minecraft {modInstallModal.data.target.minecraftVersion}.</strong>
                                      <p>You will be asked to confirm before continuing if you select one of these.</p>
                                      <label className="modInstallCheckbox">
                                        <input
                                          type="checkbox"
                                          checked={modInstallModal.acknowledgeMinecraftMismatch}
                                          onChange={(event) => setModInstallModal((current) => current ? { ...current, acknowledgeMinecraftMismatch: event.target.checked } : current)}
                                        />
                                        <span>I understand this version is not marked as compatible with this Minecraft version.</span>
                                      </label>
                                    </div>
                                  )}
                                </div>
                              )}
                            </>
                          )}

                          {modInstallModal.step === 2 && modInstallModal.data && selectedInstallVersion && (
                            <div className="modInstallConfirm">
                              <p className="modInstallReviewCopy">
                                {selectedPendingRequiredDependencyCount > 0
                                  ? `Review the selected mod and ${selectedPendingRequiredDependencyCount} required ${selectedPendingRequiredDependencyCount === 1 ? "dependency" : "dependencies"} before installing all files.`
                                  : "Review the details below before installing."}
                              </p>
                              <section className="modConfirmSection">
                                <div className="modConfirmSectionHeader">
                                  <strong>Selected mod version</strong>
                                </div>
                                <div className="modConfirmSelectedVersion">
                                  {modIconSource(modInstallModal.data.project.iconUrl || modInstallModal.mod.icon_url) ? (
                                    <img src={modIconSource(modInstallModal.data.project.iconUrl || modInstallModal.mod.icon_url)} alt="" />
                                  ) : (
                                    <div className="modDetailsIconFallback">MOD</div>
                                  )}
                                  <div className="modConfirmSelectedText">
                                    <strong>{modInstallModal.data.project.title || modInstallModal.mod.title}</strong>
                                    {modInstallModal.mod.author && <small>by {modInstallModal.mod.author}</small>}
                                    <div className="modConfirmMetaLine">
                                      <span className="subtlePill">{releaseChannelLabel(selectedInstallVersion.releaseChannel)}</span>
                                      <span>{selectedInstallVersion.versionNumber}</span>
                                      <span>{selectedInstallVersion.loaders.includes("fabric") ? "Fabric" : selectedInstallVersion.loaders.join(", ")}</span>
                                      <span>For Minecraft: {formatVersionList(selectedInstallVersion.minecraftVersions)}</span>
                                      <span>{selectedInstallVersion.publishedAt ? `Released: ${formatDisplayDate(selectedInstallVersion.publishedAt)}` : "Released: unknown"}</span>
                                    </div>
                                    <div className="modConfirmFilename">{selectedInstallVersion.file?.filename || "No selected jar"}{selectedInstallVersion.file?.size ? ` - ${formatBytes(selectedInstallVersion.file.size)}` : ""}</div>
                                  </div>
                                  <button type="button" className="secondaryButton" onClick={() => setModInstallModal((current) => current ? { ...current, step: 1, installing: false } : current)}>Change selection</button>
                                </div>
                                {selectedInstallVersion.requiresMinecraftAcknowledgement && (
                                  <div className="modConfirmInfoBanner">
                                    This version was not built for Minecraft {modInstallModal.data.target.minecraftVersion} but may still be compatible.
                                  </div>
                                )}
                              </section>

                              <section className="modConfirmSection">
                                <div className="modConfirmSectionHeader"><strong>Install location</strong></div>
                                <div className="modConfirmLocation">
                                  <div className="modConfirmLocationIcon"><FileTypeIcon entry={{ name: "server", path: "/", type: "directory", size: 0, modifiedAt: new Date().toISOString() }} /></div>
                                  <div>
                                    <strong>{modInstallModal.data.target.serverName}</strong>
                                    <span>{modInstallModal.data.target.loader} {modInstallModal.data.target.minecraftVersion}</span>
                                  </div>
                                </div>
                              </section>

                              <section className="modConfirmSection">
                                <div className="modConfirmSectionHeader"><strong>Compatibility</strong></div>
                                <div className="modConfirmRows">
                                  <div>
                                    <span>Minecraft Version</span>
                                    <strong>Server: {modInstallModal.data.target.minecraftVersion} <span aria-hidden="true">to</span> Mod: {formatVersionList(selectedInstallVersion.minecraftVersions)}</strong>
                                    <mark className={`installStatusBadge ${selectedInstallVersion.requiresMinecraftAcknowledgement ? "warning" : "ok"}`}>{selectedInstallVersion.requiresMinecraftAcknowledgement ? "Overridden" : "Compatible"}</mark>
                                  </div>
                                  <div>
                                    <span>Loader</span>
                                    <strong>Fabric</strong>
                                    <mark className="installStatusBadge ok">Compatible</mark>
                                  </div>
                                  <div>
                                    <span>Server-side support</span>
                                    <strong>{modSideSupportLabel(modInstallModal.data.project.serverSide)}</strong>
                                    <mark className={`installStatusBadge ${modInstallModal.data.project.serverSide === "unsupported" ? "danger" : modInstallModal.data.project.serverSide === "unknown" ? "warning" : "ok"}`}>
                                      {modInstallModal.data.project.serverSide === "unsupported" ? "Unsupported" : modInstallModal.data.project.serverSide === "unknown" ? "Unknown" : "Supported"}
                                    </mark>
                                  </div>
                                </div>
                              </section>

                              <section className="modConfirmSection">
                                <div className="modConfirmSectionHeader"><strong>Dependencies</strong></div>
                                {selectedInstallVersion.dependencies.length === 0 ? (
                                  <div className="modInstallVersionEmpty">No dependencies were listed for this version.</div>
                                ) : (
                                  <div className="modDependencyList">
                                    {selectedInstallVersion.dependencies.map((dependency, index) => {
                                      const status = dependencyInstallStatus(dependency);
                                      return (
                                        <div key={`${dependency.projectId || dependency.versionId || "dependency"}-${index}`} className="modDependencyRow">
                                          {modIconSource(dependency.iconUrl) ? <img src={modIconSource(dependency.iconUrl)} alt="" /> : <div className="modDependencyFallback">?</div>}
                                          <div>
                                            <strong>{dependency.title || dependency.projectId || dependency.versionId || "Unknown dependency"}</strong>
                                            <span><mark className="subtlePill">{dependencyTypeLabel(dependency.dependencyType)}</mark> {status}</span>
                                          </div>
                                          <mark className={`installStatusBadge ${status === "Already installed" ? "ok" : dependency.dependencyType === "required" ? "warning" : "ok"}`}>{status}</mark>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </section>

                              {selectedInstallVersion.requiresMinecraftAcknowledgement && (
                                <div className="modInstallRiskBox">
                                  <strong>Confirm Minecraft version override</strong>
                                  <label className="modInstallCheckbox">
                                    <input
                                      type="checkbox"
                                      checked={modInstallModal.acknowledgeMinecraftMismatch}
                                      onChange={(event) => setModInstallModal((current) => current ? { ...current, acknowledgeMinecraftMismatch: event.target.checked } : current)}
                                    />
                                    <span>I understand this version is not marked as compatible with Minecraft {modInstallModal.data.target.minecraftVersion}.</span>
                                  </label>
                                </div>
                              )}
                            </div>
                          )}
                        </div>

                        <div className="modInstallFooter">
                          {modInstallModal.step === 2 && <button type="button" className="secondaryButton" onClick={() => setModInstallModal((current) => current ? { ...current, step: 1, installing: false } : current)} disabled={modInstallModal.installing}>Back</button>}
                          <span className="modInstallFooterSpacer" />
                          <button type="button" className="secondaryButton" onClick={() => setModInstallModal(null)} disabled={modInstallModal.installing}>Cancel</button>
                          {modInstallModal.step === 1 ? (
                            <button type="button" onClick={continueModInstallReview} disabled={!canContinueModInstall || modInstallModal.loading}>
                              Continue
                            </button>
                          ) : (
                            <button type="button" onClick={installSelectedMod} disabled={!canContinueModInstall || modInstallModal.installing}>
                              {modInstallModal.installing ? "Installing" : selectedPendingRequiredDependencyCount > 0 ? "Install all" : "Install mod"}
                            </button>
                          )}
                        </div>
                      </section>
                    </div>
                  )}

                  {detailsMod && (
                    <div className="modalBackdrop" role="presentation" onClick={() => setDetailsMod(null)}>
                      <section className="modalPanel modDetailsPanel" role="dialog" aria-modal="true" aria-labelledby="details-title" onClick={(e) => e.stopPropagation()}>
                        <div className="panelHeader">
                          <h2 id="details-title">Mod details</h2>
                          <button type="button" className="iconButton modalCloseButton" onClick={() => setDetailsMod(null)} aria-label="Close details" title="Close details">
                            <AppIcon name="x" />
                          </button>
                        </div>
                        <div className="modDetailsHeaderRow">
                          {modIconSource(detailsMod.iconUrl) ? (
                            <img src={modIconSource(detailsMod.iconUrl)} alt={detailsMod.displayName} className="modDetailsIcon" />
                          ) : (
                            <div className="modDetailsIconFallback">JAR</div>
                          )}
                          <div className="modDetailsHeaderText">
                            <strong>{detailsMod.displayName}</strong>
                            <span className="modDetailsFilename">{detailsMod.filename}</span>
                          </div>
                        </div>
                        <div className="modDetailsBody">
                          {detailsMod.description && (
                            <div className="modDetailsField">
                              <strong className="fieldLabel">Description</strong>
                              <p className="modDetailsDesc">{detailsMod.description}</p>
                            </div>
                          )}
                          <div className="modDetailsGridTwoCol">
                            <div className="modDetailsField">
                              <strong className="fieldLabel">Size</strong>
                              <div>{formatBytes(detailsMod.size)}</div>
                            </div>
                            <div className="modDetailsField">
                              <strong className="fieldLabel">Last Modified</strong>
                              <div>{formatDisplayDate(detailsMod.modifiedAt)}</div>
                            </div>
                          </div>
                          
                          {detailsMod.modrinth && (
                            <>
                              <div className="modDetailsDivider">
                                <strong>Modrinth Metadata</strong>
                              </div>
                              <div className="modDetailsGridTwoCol">
                                <div className="modDetailsField">
                                  <strong className="fieldLabel">Project ID</strong>
                                  <div className="codeValue">{detailsMod.modrinth.projectId}</div>
                                </div>
                                <div className="modDetailsField">
                                  <strong className="fieldLabel">Version ID</strong>
                                  <div className="codeValue">{detailsMod.modrinth.versionId}</div>
                                </div>
                                <div className="modDetailsField">
                                  <strong className="fieldLabel">Version Number</strong>
                                  <div>{detailsMod.modrinth.versionNumber}</div>
                                </div>
                                <div className="modDetailsField">
                                  <strong className="fieldLabel">Installed At</strong>
                                  <div>{formatDisplayDate(detailsMod.modrinth.installedAt)}</div>
                                </div>
                              </div>
                              <div className="modDetailsGridTwoCol">
                                <div className="modDetailsField">
                                  <strong className="fieldLabel">Supported Game Versions</strong>
                                  <div>{detailsMod.modrinth.gameVersions.join(", ")}</div>
                                </div>
                                <div className="modDetailsField">
                                  <strong className="fieldLabel">Supported Loaders</strong>
                                  <div className="capitalize">{detailsMod.modrinth.loaders.join(", ")}</div>
                                </div>
                              </div>
                              {detailsMod.modrinth.hashes && Object.keys(detailsMod.modrinth.hashes).length > 0 && (
                                <div className="modDetailsField">
                                  <strong className="fieldLabel">File Hashes</strong>
                                  <div className="modDetailsHashes">
                                    {Object.entries(detailsMod.modrinth.hashes).map(([algo, hash]) => (
                                      <div key={algo}>
                                        <span className="hashAlgo">{algo}:</span> {hash}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                              <div className="modDetailsLinkRow">
                                <a
                                  href={`https://modrinth.com/mod/${detailsMod.modrinth.projectId}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="pill modDetailsPill"
                                >
                                  <span>View on Modrinth</span>
                                  <svg className="buttonIcon modDetailsLinkIcon" viewBox="0 0 24 24">
                                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" fill="none" stroke="currentColor" />
                                  </svg>
                                </a>
                              </div>
                            </>
                          )}
                        </div>
                        <div className="buttonRow modDetailsButtonRow">
                          <button type="button" className="secondaryButton" onClick={() => setDetailsMod(null)}>Close</button>
                        </div>
                      </section>
                    </div>
                  )}
                </section>
              </section>
            )}

            {activePage === "schedule" && (
              <SchedulePage
                schedules={activeServer.schedules ?? []}
                onCreate={createSchedule}
                onToggle={(schedule) => updateSchedule(schedule, { enabled: !schedule.enabled })}
                onUpdate={updateSchedule}
                onDelete={deleteSchedule}
                disabled={scheduleBusy || isProvisioning || !canExpanded || dockerOperationalLock}
                disabledReason={scheduleDisabledReason}
              />
            )}

            {activePage === "properties" && (
              <section className="tabPage settingsPage">
                <section className="panel">
                  <h2>Server Properties</h2>
                  <ServerEditForm
                    server={activeServer}
                    versions={fabricVersions}
                    totalMemory={activeNode.totalMemory || effectiveAppState.totalMemory}
                    onSubmit={updateServer}
                    disabled={serverSettingsLocked || serverSettingsSaving}
                  />
                </section>
                <DeleteServerPanel
                  server={activeServer}
                  onSubmit={deleteServer}
                  disabled={serverSettingsLocked || serverSettingsSaving}
                />
              </section>
            )}

          </>
        )}
      </section>
    </main>
  );
}
