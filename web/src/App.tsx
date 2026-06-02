import { ChangeEvent, FormEvent, KeyboardEvent, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { demoListing, demoOverviewData, demoSearchResults, demoServer, demoServerId, demoStats, demoStatus, initialDemoFiles, initialDemoMods, initialDemoSchedules } from "./demo";
import type { ActivePage, AppState, AuthSession, ContextNode, CreateNodeResponse, FabricVersions, FileEntry, FileListing, FilePreview, InstalledMod, LocalePreference, ManagedNode, ManagedServer, ModrinthHit, NodeInstallResponse, Notice, PermissionKey, ProvisionJob, PublicUser, ReleaseChannel, ResourceSample, ResourceStats, ScheduledExecution, ServerActivity, ServerOverviewData, ServerStatus, ThemePreference, GeneralJob } from "./types";
import { bufferToBase64, clientId, fileDisplayType, fileStatusLabel, isEditableFile, isPreviewableFile, joinPublicPath, parentPath } from "./utils/files";
import { compatibilityClass, compatibilityLabel, fabricLoaderVersionInfo, formatBytes, minecraftVersionInfo, readLocalePreference, readThemePreference, resourcePollMs, runtimeLabel, runtimeTone, versionValue } from "./utils/format";
import { hasPermission, normalizePermissions } from "./utils/permissions";
import { applyFormErrors, trimFormValue, validateCommandList, validateCronExpression, validateDisplayName, validateDockerContainerName, validateDockerPorts, validateJarFilename, validateJavaArgs, validatePassword, validateRuntimeJarFilename, validateSafePath, validateServerPort, validateUsername } from "./utils/validation";
import { minecraftCommandSuggestions } from "./utils/commands";
import { isNodeRuntimeUsable, nodeBlockReason, nodeStatusLabel } from "./utils/nodes";
import { AuthPanel, UserManagement } from "./components/AuthPanel";
import { AppIcon, FileTypeIcon, SidebarIcon, SidebarToggleIcon } from "./components/FileTypeIcon";
import { InlineState } from "./components/InlineState";
import { Notifications } from "./components/Notifications";
import { ResourcePanel } from "./components/ResourcePanel";
import { RuntimeControls } from "./components/RuntimeControls";
import { ModrinthKeyForm } from "./components/SettingsPanels";
import { ActivityHealthPanel, OverviewSummary, RecentEventsPanel } from "./pages/OverviewPage";
import { SchedulePage } from "./pages/SchedulesPage";
import { NodesPage } from "./pages/NodesPage";
import { DeleteServerPanel, ManagedServerForm, ServerEditForm } from "./pages/ServerSettingsPage";

const appVersion = "0.2.0";
const defaultNodeDataPath = "/var/lib/serversentinel";
const serverWorkspacePages: ActivePage[] = ["overview", "console", "files", "mods", "schedule", "properties"];
type ModCompatibilityFilter = "all" | "compatible" | "incompatible";
type FileSortKey = "name" | "modifiedAt" | "type" | "size";
type FilePreviewState = {
  path: string;
  loading: boolean;
  data: FilePreview | null;
  error: string;
};

function isServerWorkspacePage(page: ActivePage) {
  return serverWorkspacePages.includes(page);
}

const emptyApp: AppState = {
  servers: [],
  nodes: [],
  runtimeMode: "all-in-one",
  modrinthApiConfigured: false,
  dockerSocketMounted: false,
  totalMemory: 0
};

const defaultContextNode: ManagedNode = {
  id: "local",
  name: "Internal Node",
  type: "local",
  status: "online",
  isInternal: true
};

const emptyPanelContextNode: ManagedNode = {
  id: "",
  name: "No node selected",
  type: "remote",
  status: "unknown",
  isInternal: false
};

function NodeGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="4" width="14" height="16" />
      <path d="M8 8h8" />
      <path d="M8 12h8" />
      <path d="M8 16h4" />
    </svg>
  );
}

function ServerGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
      <path d="m4 7 8 4 8-4" />
      <path d="M12 11v10" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 12 4 4 10-10" />
    </svg>
  );
}

function ContextSwitchModal({
  nodes,
  activeServerId,
  expandedNodes,
  modalRef,
  onClose,
  onManageNodes,
  onSelectServer,
  onToggleNode
}: {
  nodes: ContextNode[];
  activeServerId: string;
  expandedNodes: Record<string, boolean>;
  modalRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onManageNodes: () => void;
  onSelectServer: (server: ManagedServer, node: ContextNode) => void;
  onToggleNode: (nodeId: string) => void;
}) {
  return (
    <div className="modalBackdrop contextModalBackdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="modalPanel contextModalPanel" role="dialog" aria-modal="true" aria-labelledby="context-modal-title" tabIndex={-1} ref={modalRef}>
        <header className="contextModalHeader">
          <div>
            <h2 id="context-modal-title">SWITCH CONTEXT</h2>
            <p>Select a node and server to manage.</p>
          </div>
          <button type="button" className="iconButton contextCloseButton" onClick={onClose} aria-label="Close switch context modal">
            <span aria-hidden="true">X</span>
          </button>
        </header>

        <div className="contextNodeList">
          {nodes.map((node) => {
            const expanded = Boolean(expandedNodes[node.id]);
            return (
              <section key={node.id} className={`contextNodeGroup ${expanded ? "expanded" : ""}`}>
                <button type="button" className="contextNodeButton" onClick={() => onToggleNode(node.id)} aria-expanded={expanded}>
                  <span className="contextNodeIcon"><NodeGlyph /></span>
                  <span className="contextNodeText">
                    <span className="contextNodeName">
                      <span className={`nodeStatusDot ${node.status}`} title={nodeStatusLabel(node.status)} aria-label={nodeStatusLabel(node.status)} />
                      {node.name}
                    </span>
                    <span className="contextNodeMeta">{node.servers.length} {node.servers.length === 1 ? "server" : "servers"}</span>
                  </span>
                  {(node.isInternal || node.type === "local") && <span className="nodePill">LOCAL</span>}
                  <span className="nodeExpandIndicator" aria-hidden="true">{expanded ? "-" : "+"}</span>
                </button>

                {expanded && (
                  <div className="contextServerSection">
                    <div className="contextServerSectionLabel">SERVERS ON {node.name}</div>
                    <div className="contextServerList">
                      {node.servers.length === 0 && <div className="contextEmptyServers">No servers assigned</div>}
                      {node.servers.map((server) => {
                        const selected = server.id === activeServerId;
                        return (
                          <button
                            key={server.id}
                            type="button"
                            className={`contextServerButton ${selected ? "selected" : ""}`}
                            onClick={() => onSelectServer(server, node)}
                            aria-selected={selected}
                            title={`Manage ${server.displayName}`}
                          >
                            <span className="contextServerIcon"><ServerGlyph /></span>
                            <span className="contextServerName">{server.displayName}</span>
                            {selected && <span className="contextCheck"><CheckGlyph /></span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>

        <footer className="contextModalFooter">
          <button type="button" className="secondaryButton manageNodesButton" onClick={onManageNodes}>
            <SidebarIcon name="settings" />
            <span>MANAGE NODES</span>
          </button>
          <button type="button" className="secondaryButton" onClick={onClose}>CANCEL</button>
        </footer>
      </section>
    </div>
  );
}

function readDemoMode() {
  return window.localStorage.getItem("serversentinel-demo-mode") === "true";
}

function readCommandHistory() {
  try {
    const raw = window.localStorage.getItem("serversentinel-command-history");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string").slice(-50) : [];
  } catch {
    return [];
  }
}

function errorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : "";
  if (!message) return fallback;
  if (/timeout|timed out/i.test(message)) {
    return "The request timed out. The server may still be busy.";
  }
  if (/docker|socket/i.test(message)) {
    return message.includes("not mounted")
      ? "Docker socket is not mounted. Runtime controls are unavailable."
      : message;
  }
  return message;
}

function firstValidationMessage(errors: Array<{ message: string }>) {
  return errors[0]?.message ?? "";
}

function setValidationNotice(form: HTMLFormElement, errors: Array<{ field: string; message: string }>, setMessage: (message: string) => void) {
  if (!errors.length) return false;
  applyFormErrors(form, errors);
  setMessage(firstValidationMessage(errors));
  return true;
}

function fileNameValidation(name: string) {
  const value = name.trim();
  if (!value) return "A file or folder name is required.";
  if (value === "." || value === ".." || value.length > 160) return "Use a normal file or folder name.";
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(value)) return "The name contains characters that are not safe for server files.";
  return "";
}

function defaultDuplicateName(name: string) {
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    return `${name.slice(0, dot)} copy${name.slice(dot)}`;
  }
  return `${name} copy`;
}

function serverConfigValidation(form: FormData, existingNames: string[], currentName?: string) {
  const displayName = trimFormValue(form, "displayName");
  const errors: Array<{ field: string; message: string }> = [];
  const displayError = validateDisplayName(displayName);
  if (displayError) errors.push({ field: "displayName", message: displayError });
  if (displayName && displayName.toLowerCase() !== currentName?.toLowerCase() && existingNames.some((name) => name.toLowerCase() === displayName.toLowerCase())) {
    errors.push({ field: "displayName", message: "A managed server with this display name already exists." });
  }
  const port = trimFormValue(form, "serverPort");
  if (port) {
    const portError = validateServerPort(port);
    if (portError) errors.push({ field: "serverPort", message: portError });
  }
  const jarError = validateRuntimeJarFilename(trimFormValue(form, "serverJar"));
  if (jarError) errors.push({ field: "serverJar", message: jarError });
  const containerError = validateDockerContainerName(trimFormValue(form, "dockerContainer"));
  if (containerError) errors.push({ field: "dockerContainer", message: containerError });
  const portsError = validateDockerPorts(trimFormValue(form, "dockerPorts"));
  if (portsError) errors.push({ field: "dockerPorts", message: portsError });
  const javaArgsError = validateJavaArgs(trimFormValue(form, "javaArgs"));
  if (javaArgsError) errors.push({ field: "javaArgs", message: javaArgsError });
  return errors;
}

function hasPotentialEvent(text: string): boolean {
  const lowercase = text.toLowerCase();
  return (
    lowercase.includes("joined the game") ||
    lowercase.includes("left the game") ||
    lowercase.includes("lost connection:") ||
    lowercase.includes("disconnecting ") ||
    lowercase.includes("starting minecraft server") ||
    lowercase.includes("stopping server") ||
    lowercase.includes("stopping the server") ||
    lowercase.includes("all chunks are saved") ||
    /done \([^)]+\)! for help, type "help"/i.test(lowercase) ||
    /\b(disabled|disabling)\b.*\b(mod|\.jar)/i.test(lowercase) ||
    /\b(mod|\.jar).*?\b(disabled|disabling)\b/i.test(lowercase) ||
    /encountered an unexpected exception|this crash report has been saved to:|minecraft crash report|a crash report has been generated|the game crashed|server crashed/i.test(lowercase)
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
  const [modSearchResults, setModSearchResults] = useState<ModrinthHit[]>([]);
  const [modInstallChannel, setModInstallChannel] = useState<ReleaseChannel>("release");
  const [modCompatibilityFilter, setModCompatibilityFilter] = useState<ModCompatibilityFilter>("all");
  const [isSearchingMods, setIsSearchingMods] = useState(false);
  const [modSearchError, setModSearchError] = useState("");
  const [forceInstallProjectId, setForceInstallProjectId] = useState<string | null>(null);
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
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [serverSettingsSaving, setServerSettingsSaving] = useState(false);
  const [consoleStreamVersion, setConsoleStreamVersion] = useState(0);
  const [runtimeAction, setRuntimeAction] = useState<"start" | "stop" | "restart" | null>(null);
  const [activePage, setActivePage] = useState<ActivePage>("overview");
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [contextModalOpen, setContextModalOpen] = useState(false);
  const [expandedContextNodes, setExpandedContextNodes] = useState<Record<string, boolean>>({});
  const [nodeBusyId, setNodeBusyId] = useState("");
  const [nodeDetails, setNodeDetails] = useState<ManagedNode | null>(null);
  const [nodeInstallResult, setNodeInstallResult] = useState<NodeInstallResponse | CreateNodeResponse | null>(null);
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [addNodeResult, setAddNodeResult] = useState<CreateNodeResponse | null>(null);
  const [nodeInstallMethod, setNodeInstallMethod] = useState<"compose" | "run">("compose");
  const [preferredCreateNodeId, setPreferredCreateNodeId] = useState("");
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readThemePreference());
  const [demoMode, setDemoMode] = useState(() => readDemoMode());
  const [dateLocalePreference, setDateLocalePreference] = useState<LocalePreference>(() => readLocalePreference("serversentinel-date-locale"));
  const [numberLocalePreference, setNumberLocalePreference] = useState<LocalePreference>(() => readLocalePreference("serversentinel-number-locale"));
  const [demoRunning, setDemoRunning] = useState(true);
  const [demoFiles, setDemoFiles] = useState<Record<string, string>>(() => initialDemoFiles);
  const [demoInstalledMods, setDemoInstalledMods] = useState<InstalledMod[]>(() => initialDemoMods);
  const [demoSchedules, setDemoSchedules] = useState<ScheduledExecution[]>(() => initialDemoSchedules);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const consoleRef = useRef<HTMLDivElement>(null);
  const previousLogCountRef = useRef(0);
  const modUploadRef = useRef<HTMLInputElement>(null);
  const fileUploadRef = useRef<HTMLInputElement>(null);
  const activeServerIdRef = useRef("");
  const contextModalRef = useRef<HTMLElement>(null);
  const panelFirstRunPromptedRef = useRef(false);
  const modToggleStateQueueRef = useRef<Record<string, {
    targetEnabled: boolean;
    inFlightEnabled: boolean | null;
  }>>({});

  const overviewRefreshTimeoutRef = useRef<number | null>(null);

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
  const isAnyModJobRunning = activeJobs.some((job) => (job.type === "mod-install" || job.type === "mod-upload") && job.status === "running");
  const effectiveAppState = useMemo<AppState>(() => {
    if (!demoMode) return appState;
    return {
      ...appState,
      servers: [demoServer(demoSchedules), ...appState.servers.filter((server) => server.id !== demoServerId)],
      nodes: appState.nodes?.length ? appState.nodes : [defaultContextNode],
      runtimeMode: appState.runtimeMode ?? "all-in-one",
      modrinthApiConfigured: true,
      dockerSocketMounted: true,
      totalMemory: appState.totalMemory || 16 * 1024 * 1024 * 1024
    };
  }, [appState, demoMode, demoSchedules]);
  const panelOnlyMode = effectiveAppState.runtimeMode === "panel";

  const contextNodes = useMemo<ContextNode[]>(() => {
    const sourceNodes = effectiveAppState.nodes?.length ? effectiveAppState.nodes : (panelOnlyMode ? [] : [defaultContextNode]);
    const nodes: ContextNode[] = sourceNodes.filter((node) => !(panelOnlyMode && (node.isInternal || node.type === "local"))).map((node) => ({
      ...node,
      dockerStatus: (node.isInternal || node.type === "local") ? (effectiveAppState.dockerSocketMounted ? "available" : "unavailable") : node.dockerStatus,
      dataPathStatus: (node.isInternal || node.type === "local") ? "ready" : node.dataPathStatus,
      compatibility: (node.isInternal || node.type === "local") ? "compatible" : node.compatibility,
      servers: [] as ManagedServer[]
    }));
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    for (const server of effectiveAppState.servers) {
      const nodeId = server.nodeId || "local";
      if (panelOnlyMode && nodeId === "local") continue;
      const node = nodesById.get(nodeId);
      if (node) {
        node.servers.push(server);
        continue;
      }
      const fallbackNode: ContextNode = {
        id: nodeId,
        name: server.nodeName || nodeId,
        type: "remote",
        status: "unknown",
        isInternal: false,
        servers: [server]
      };
      nodes.push(fallbackNode);
      nodesById.set(nodeId, fallbackNode);
    }
    return nodes;
  }, [effectiveAppState.nodes, effectiveAppState.servers, effectiveAppState.dockerSocketMounted, panelOnlyMode]);

  const activeServer = useMemo(
    () => {
      if (demoMode) {
        return effectiveAppState.servers.find((server) => server.id === demoServerId);
      }
      return effectiveAppState.servers.find((server) => server.id === activeServerId) ?? effectiveAppState.servers[0];
    },
    [activeServerId, demoMode, effectiveAppState.servers]
  );
  const activeServerIsDemo = demoMode && activeServer?.id === demoServerId;
  const activeNode = useMemo(() => {
    const serverNodeId = activeServer?.nodeId || "local";
    return contextNodes.find((node) => node.id === serverNodeId) ?? contextNodes[0] ?? { ...(panelOnlyMode ? emptyPanelContextNode : defaultContextNode), servers: [] };
  }, [activeServer?.nodeId, contextNodes, panelOnlyMode]);
  const usableContextNodes = useMemo(() => contextNodes.filter(isNodeRuntimeUsable), [contextNodes]);
  const activeMinecraftVersion = activeServer ? versionValue(minecraftVersionInfo(activeServer)) : "Unknown";
  const activeFabricLoaderVersion = activeServer ? versionValue(fabricLoaderVersionInfo(activeServer)) : "Unknown";
  const activeModContext = `Fabric ${activeFabricLoaderVersion === "Unknown" ? "unknown" : activeFabricLoaderVersion} · Minecraft ${activeMinecraftVersion === "Unknown" ? "unknown" : activeMinecraftVersion}`;
  const activeModVersionsUnknown = activeFabricLoaderVersion === "Unknown" || activeMinecraftVersion === "Unknown";
  const activeStatus = status?.server.id === activeServer?.id ? status : null;
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
  const activeNodeRuntimeBlocked = Boolean(activeServer && !activeServerIsDemo && !isNodeRuntimeUsable(activeNode));
  const activeNodeBlockReason = nodeBlockReason(activeNode);
  const activeNodeBlockMessage = activeNodeRuntimeBlocked
    ? `${activeNodeBlockReason || "Node unavailable"}. This server belongs to ${activeNode.name}. Runtime actions and file access are unavailable until the node reconnects or the runtime issue is fixed.`
    : "";
  const activeServerUsesInternalNode = activeNode.isInternal || activeNode.type === "local";
  const activeServerDockerSocketMounted = !activeServerUsesInternalNode || effectiveAppState.dockerSocketMounted;
  const dockerOperationalLock = authOperationalLock || activeNodeRuntimeBlocked || (activeServerUsesInternalNode && !effectiveAppState.dockerSocketMounted);
  const serverCreationBlocked = authOperationalLock || usableContextNodes.length === 0;
  const serverSettingsLocked = isProvisioning || dockerOperationalLock || !canManager || Boolean(activeStatus?.docker.running);
  const modsLocked = isProvisioning || dockerOperationalLock || !canManager || !activeStatus || Boolean(activeStatus.docker.running) || isAnyModJobRunning;
  const modToggleLocked = isProvisioning || dockerOperationalLock || !canManager || !activeStatus || Boolean(activeStatus.docker.running) || isAnyModJobRunning;
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

  const filteredModSearchResults = useMemo(() => {
    if (modCompatibilityFilter === "compatible") {
      return modSearchResults.filter((mod) => Boolean(mod.compatibility?.compatible));
    }
    if (modCompatibilityFilter === "incompatible") {
      return modSearchResults.filter((mod) => !mod.compatibility?.compatible);
    }
    return modSearchResults;
  }, [modCompatibilityFilter, modSearchResults]);
  const forceInstallMod = useMemo(
    () => modSearchResults.find((mod) => mod.project_id === forceInstallProjectId) ?? null,
    [forceInstallProjectId, modSearchResults]
  );



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

  function formatDisplayMegabytes(value: number) {
    if (!value) return "0 MB";
    return `${formatDisplayNumber(Math.round(value / 1024 / 1024))} MB`;
  }

  function modCompatibilityNote(mod: ModrinthHit) {
    return mod.compatibility?.reason || "Compatibility could not be verified.";
  }

  function formatOptionalModDate(value?: string) {
    return value ? `Updated ${formatDisplayDate(value)}` : "";
  }
  useEffect(() => {
    void refreshAuth();
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
    setNodeInstallMethod("compose");
  }, [appStateLoaded, demoMode, effectiveAppState.servers.length, panelOnlyMode, usableContextNodes.length]);

  useEffect(() => {
    if (!contextModalOpen) return;
    contextModalRef.current?.focus();
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeContextModal();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [contextModalOpen]);

  function openContextModal() {
    const nodeId = activeNode.id || "local";
    setExpandedContextNodes((current) => ({ ...current, [nodeId]: true }));
    setContextModalOpen(true);
  }

  function closeContextModal() {
    setContextModalOpen(false);
  }

  function selectContextServer(server: ManagedServer, node: ContextNode) {
    if (demoMode && server.id !== demoServerId) {
      notify("info", "Demo mode is enabled. Exit demo mode to access this server.");
      return;
    }
    setActiveServerId(server.id);
    activeServerIdRef.current = server.id;
    setActivePage("overview");
    closeContextModal();
  }

  function manageNodesPlaceholder() {
    setActivePage("nodes");
    closeContextModal();
  }

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
    async function loadNodeServerActivity() {
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
    window.localStorage.setItem("serversentinel-demo-mode", String(demoMode));
    if (demoMode) {
      setNotice("");
      setActiveServerId(demoServerId);
      setActivePage("overview");
    } else if (activeServerId === demoServerId) {
      setActiveServerId("");
      setStatus(null);
      setLogs([]);
      setListing({ path: "/", entries: [] });
      setSelectedPath("");
      setEditorText("");
      setDirty(false);
      void refreshApp();
    }
  }, [demoMode]);

  useEffect(() => {
    if (!activeServer) return;
    setActiveServerId(activeServer.id);
    setLogs([]);
    setSelectedPath("");
    setEditorText("");
    setDirty(false);
    setResourceSamples([]);
    setModSearchResults([]);
    setModsView("manager");
    if (demoMode && activeServer.id === demoServerId) {
      setStatus(demoStatus(activeServer, demoRunning));
      setLogs([
        "[demo] Starting minecraft server version 1.21.4",
        "[demo] Loading Fabric Loader 0.16.10",
        "[demo] Preparing spawn area: 100%",
        "[demo] Done (5.132s)! For help, type \"help\""
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

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/console?serverId=${encodeURIComponent(activeServer.id)}`);
    socket.onmessage = (event) => {
      let message: { type?: string; source?: string; text?: string; message?: string };
      try {
        message = JSON.parse(event.data);
      } catch {
        setLogs(["Console stream sent an unreadable message."]);
        return;
      }
      if (message.type === "log") {
        setLogs((current) => [...current.slice(-499), `[${message.source ?? "console"}] ${message.text ?? ""}`]);
        if (message.text && hasPotentialEvent(message.text) && activeServerIdRef.current) {
          triggerOverviewRefreshRef.current(activeServerIdRef.current);
        }
      }
      if (message.type === "unavailable") {
        setLogs([message.message ?? "Console stream is unavailable."]);
      }
      if (message.type === "empty") {
        setLogs([]);
      }
    };
    socket.onerror = () => setLogs(["Console stream is unavailable."]);
    return () => socket.close();
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
      setModCompatibilityFilter("all");
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
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const update = () => setSystemDark(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("serversentinel-theme", themePreference);
  }, [themePreference]);

  useEffect(() => {
    window.localStorage.setItem("serversentinel-date-locale", dateLocalePreference);
  }, [dateLocalePreference]);

  useEffect(() => {
    window.localStorage.setItem("serversentinel-number-locale", numberLocalePreference);
  }, [numberLocalePreference]);

  useEffect(() => {
    window.localStorage.setItem("serversentinel-command-history", JSON.stringify(commandHistory.slice(-50)));
  }, [commandHistory]);

  useEffect(() => {
    if (!addNodeOpen || !addNodeResult || demoMode) return;
    const interval = window.setInterval(() => {
      void refreshApp();
    }, 2500);
    return () => window.clearInterval(interval);
  }, [addNodeOpen, addNodeResult?.node.id, demoMode]);

  useEffect(() => {
    if (!activeServer || activeNodeRuntimeBlocked || (activePage !== "overview" && activePage !== "console")) return;
    if (demoMode && activeServer.id === demoServerId) {
      setResourceSamples([demoStats(demoRunning)]);
      const interval = window.setInterval(() => setResourceSamples((samples) => [...samples, demoStats(demoRunning)].slice(-48)), resourcePollMs);
      return () => window.clearInterval(interval);
    }
    const serverId = activeServer.id;
    let cancelled = false;
    setResourceSamples([]);
    async function pollStats() {
      try {
        const stats = await api<ResourceStats>(`/api/servers/${serverId}/stats`);
        if (cancelled) return;
        setResourceSamples((samples) => [...samples, { ...stats, sampledAt: Date.now() }].slice(-48));
      } catch (error) {
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
      void refreshStatus(serverId);
    }, resourcePollMs);
    return () => window.clearInterval(interval);
  }, [activeServer?.id, demoMode, activeNodeRuntimeBlocked]);

  useEffect(() => {
    if (!activeServer || activeNodeRuntimeBlocked || activePage !== "overview") return;
    if (demoMode && activeServer.id === demoServerId) {
      setOverviewData(demoOverviewData(demoRunning));
      return;
    }
    const serverId = activeServer.id;
    let cancelled = false;
    setOverviewLoading(!overviewData.events.length && Object.keys(overviewData.activity).length === 0);
    setOverviewError("");
    async function loadOverviewData() {
      try {
        const data = await api<ServerOverviewData>(`/api/servers/${serverId}/events`);
        if (!cancelled) {
          setOverviewData(data);
          setServerActivities((current) => ({ ...current, [serverId]: data.activity }));
          setOverviewError("");
        }
      } catch (error) {
        if (!cancelled) {
          setOverviewError(errorMessage(error, "Could not load overview activity. Previously loaded data is preserved."));
        }
      } finally {
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
    if (!activeServer || activeNodeRuntimeBlocked || activePage !== "mods" || modsView !== "search" || !effectiveAppState.modrinthApiConfigured) return;
    const trimmedQuery = query.trim();
    setForceInstallProjectId(null);
    setModSearchError("");
    if (!trimmedQuery) {
      setModSearchResults([]);
      setIsSearchingMods(false);
      return;
    }
    if (activeServerIsDemo) {
      setIsSearchingMods(true);
      const timeout = window.setTimeout(() => {
        setModSearchResults(demoSearchResults.filter((mod) => (
          mod.title.toLowerCase().includes(trimmedQuery.toLowerCase())
          || mod.description.toLowerCase().includes(trimmedQuery.toLowerCase())
        )));
        setIsSearchingMods(false);
      }, 250);
      return () => {
        setIsSearchingMods(false);
        window.clearTimeout(timeout);
      };
    }
    let cancelled = false;
    setIsSearchingMods(true);
    const timeout = window.setTimeout(async () => {
      try {
        const result = await api<{ hits: ModrinthHit[] }>(
          `/api/modrinth/search?query=${encodeURIComponent(trimmedQuery)}&serverId=${encodeURIComponent(activeServer.id)}&channel=${encodeURIComponent(modInstallChannel)}&compatibility=${encodeURIComponent(modCompatibilityFilter)}`
        );
        if (!cancelled) setModSearchResults(result.hits);
      } catch (error) {
        if (!cancelled) {
          const message = errorMessage(error, "Could not search Modrinth. Check the API key and network availability.");
          setModSearchError(message);
          setNotice(message);
          notify("error", message);
        }
      } finally {
        if (!cancelled) setIsSearchingMods(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      setIsSearchingMods(false);
      window.clearTimeout(timeout);
    };
  }, [activeServer?.id, activeNodeRuntimeBlocked, activePage, effectiveAppState.modrinthApiConfigured, modsView, query, activeServerIsDemo, modInstallChannel, modCompatibilityFilter]);

  function notify(type: Notice["type"], text: string) {
    const id = Date.now() + Math.random();
    setNotices((current) => [...current, { id, type, text }]);
    window.setTimeout(() => {
      setNotices((current) => current.filter((candidate) => candidate.id !== id));
    }, 5000);
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
    const displayName = trimFormValue(form, "displayName");
    const password = String(form.get("password") || "");
    const permissions = parsePermissionsField(form);
    const errors = [
      validateUsername(username) ? { field: "username", message: validateUsername(username)! } : null,
      displayName.length > 64 ? { field: "displayName", message: "Display name must be 64 characters or fewer." } : null,
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
          displayName,
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
    const displayName = trimFormValue(form, "displayName");
    const password = String(form.get("password") || "");
    const permissions = parsePermissionsField(form);
    const errors = [
      validateUsername(username) ? { field: "username", message: validateUsername(username)! } : null,
      displayName.length > 64 ? { field: "displayName", message: "Display name must be 64 characters or fewer." } : null,
      validatePassword(password, false) ? { field: "password", message: validatePassword(password, false)! } : null,
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
          displayName,
          password,
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

  async function refreshApp() {
    if (!demoMode && (!authSession || !authSession.authenticated)) {
      return;
    }
    setAppRefreshing(true);
    setNotice("");
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
      const message = errorMessage(error, "Could not load the application state. Check the server connection and retry.");
      setAppLoadError(message);
      setNotice(message);
      notify("error", message);
    } finally {
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
    try {
      const nextStatus = await api<ServerStatus>(`/api/servers/${serverId}/status`);
      if (activeServerIdRef.current === serverId) {
        setStatus(nextStatus);
        setStatusError("");
      }
    } catch (error) {
      if (activeServerIdRef.current === serverId) {
        setStatusError(errorMessage(error, "Could not refresh server status. Existing status is preserved."));
      }
    }
  }

  async function refreshConsoleLogs(serverId = activeServer?.id) {
    if (!serverId) return;
    if (demoMode && serverId === demoServerId) {
      if (activeServerIdRef.current === serverId) {
        setLogs((current) => current.length ? current : [
          "[demo] Starting minecraft server version 1.21.4",
          "[demo] Done (5.132s)! For help, type \"help\""
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
      setLogs(lines.map((line) => `[${result.source}] ${line}`));
    } catch (error) {
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
    const blob = new Blob([`${logs.join("\n")}\n`], { type: "text/plain;charset=utf-8" });
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
        dismissible: job.status !== "running"
      } : j));
      if (job.status === "succeeded") return job;
      if (job.status === "failed") {
        throw new Error(job.error || "Server setup failed");
      }
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    }
  }

  async function createServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (demoMode) {
      notify("error", "Demo mode is enabled. Exit demo mode before creating managed servers.");
      return;
    }
    if (serverCreationBlocked || !canCreateServers) return;
    setNotice("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const errors = serverConfigValidation(form, appState.servers.map((server) => server.displayName));
    if (setValidationNotice(formElement, errors, (message) => {
      setNotice(message);
      notify("error", message);
    })) {
      return;
    }
    setProvisioningError("");
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
      setNotice(message);
      setProvisioningError(message);
      notify("error", message);
      setActiveJobs((current) => current.map((j) => j.id === "local" || (j.type === "provision" && j.status === "running") ? {
        ...j,
        status: "failed",
        task: "Server setup failed",
        error: message,
        dismissible: true
      } : j));
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
          serverPort: form.get("serverPort")
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
      notify("success", "Copied to clipboard");
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
      setNodeInstallMethod("compose");
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
      setNodeInstallMethod("compose");
      setNodeInstallResult(result);
      notify("success", `Rotated join token for ${node.name}`);
      await refreshApp();
    } catch (error) {
      notify("error", errorMessage(error, "Could not rotate the join token."));
    } finally {
      setNodeBusyId("");
    }
  }

  async function removeNode(node: ContextNode) {
    if (node.isInternal || !canManageUsers) return;
    if (node.servers.length > 0) {
      notify("error", "Move or delete assigned servers before removing this node.");
      return;
    }
    if (!window.confirm(`Remove node "${node.name}"?\n\nThis cannot be undone.`)) return;
    setNodeBusyId(node.id);
    try {
      await api(`/api/nodes/${node.id}`, { method: "DELETE" });
      notify("success", `Removed ${node.name}`);
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
      setNodeInstallMethod("compose");
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
    try {
      if (activeServerIsDemo) {
        const nextRunning = action !== "stop";
        setDemoRunning(nextRunning);
        setStatus(demoStatus(activeServer, nextRunning));
        setResourceSamples([demoStats(nextRunning)]);
        setLogs((current) => [
          ...current.slice(-496),
          `[demo] ${action === "restart" ? "Restarting" : action === "start" ? "Starting" : "Stopping"} simulated server`,
          `[demo] Server is now ${nextRunning ? "running" : "stopped"}`
        ]);
        notify("success", `Demo server ${nextRunning ? "running" : "stopped"}`);
        return;
      }
      await api(`/api/servers/${activeServer.id}/${action}`, { method: "POST" });
      await refreshStatus(activeServer.id);
      setConsoleStreamVersion((version) => version + 1);
      await refreshConsoleLogs(activeServer.id);
      notify("success", `Sent ${action} request`);
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
        setLogs((current) => [...current.slice(-497), `[command] > ${command}`, `[demo] ${response}`]);
        setCommandHistory((current) => [...current.filter((entry) => entry !== command), command].slice(-50));
        setHistoryIndex(null);
        setCommandInput("");
        notify("success", `Sent command: ${command}`);
        return;
      }
      await api(`/api/servers/${activeServer.id}/command`, {
        method: "POST",
        body: JSON.stringify({ command })
      });
      setLogs((current) => [...current.slice(-499), `[command] > ${command}`]);
      setCommandHistory((current) => [...current.filter((entry) => entry !== command), command].slice(-50));
      setHistoryIndex(null);
      setCommandInput("");
      notify("success", `Sent command: ${command}`);
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
    if (isProvisioning) return;
    const previousPath = listing.path;
    setFilesLoading(true);
    setFilesError("");
    setNotice("");
    if (demoMode && serverId === demoServerId) {
      if (activeServerIdRef.current === serverId) {
        const nextListing = demoListing(path, demoFiles, demoInstalledMods);
        setListing(nextListing);
        setSelectedFilePaths([]);
        if (historyMode === "push" && nextListing.path !== previousPath) {
          setFileBackStack((current) => [...current, previousPath].slice(-50));
          setFileForwardStack([]);
        }
      }
      setFilesLoading(false);
      return;
    }
    try {
      const nextListing = await api<FileListing>(`/api/servers/${serverId}/files?path=${encodeURIComponent(path)}`);
      if (activeServerIdRef.current === serverId) {
        setListing(nextListing);
        setSelectedFilePaths([]);
        setFilesError("");
        if (historyMode === "push" && nextListing.path !== previousPath) {
          setFileBackStack((current) => [...current, previousPath].slice(-50));
          setFileForwardStack([]);
        }
      }
    } catch (error) {
      const message = errorMessage(error, "Could not load server files. Check that the server path is available.");
      setFilesError(message);
      setNotice(message);
      notify("error", message);
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
    setFileBackStack((current) => current.slice(0, -1));
    setFileForwardStack((current) => [listing.path, ...current].slice(0, 50));
    await loadFiles(activeServer.id, target, "back");
  }

  async function navigateForwardFiles() {
    if (!activeServer || fileForwardStack.length === 0) return;
    const target = fileForwardStack[0];
    setFileForwardStack((current) => current.slice(1));
    setFileBackStack((current) => [...current, listing.path].slice(-50));
    await loadFiles(activeServer.id, target, "forward");
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
      const message = errorMessage(error, "Could not load installed mods. Check the server mods folder and retry.");
      setModsError(message);
      setNotice(message);
      notify("error", message);
    } finally {
      if (activeServerIdRef.current === serverId) setModsLoading(false);
    }
  }

  function confirmDiscardFileChanges() {
    return !dirty || window.confirm("Discard unsaved changes to the current file?");
  }

  async function loadFilePreview(entry: FileEntry) {
    if (!activeServer) return;
    setFilePreview({ path: entry.path, loading: true, data: null, error: "" });
    if (activeServerIsDemo) {
      const content = demoFiles[entry.path] ?? "";
      if (!isPreviewableFile(entry)) {
        setFilePreview({ path: entry.path, loading: false, data: { path: entry.path, preview: "unsupported", message: "Preview unavailable" }, error: "" });
      } else if (new Blob([content]).size > 96 * 1024) {
        setFilePreview({ path: entry.path, loading: false, data: { path: entry.path, preview: "too_large", message: "File too large to preview" }, error: "" });
      } else {
        setFilePreview({ path: entry.path, loading: false, data: { path: entry.path, preview: "text", content }, error: "" });
      }
      return;
    }
    try {
      const preview = await api<FilePreview>(`/api/servers/${activeServer.id}/file/preview?path=${encodeURIComponent(entry.path)}`);
      setFilePreview({ path: entry.path, loading: false, data: preview, error: "" });
    } catch (error) {
      setFilePreview({ path: entry.path, loading: false, data: null, error: errorMessage(error, "Could not load a preview for this file.") });
    }
  }

  async function openFile(path: string) {
    if (isProvisioning) return;
    if (!activeServer) return;
    if (selectedPath && selectedPath !== path && !confirmDiscardFileChanges()) return;
    const pathError = validateSafePath(path);
    if (pathError) {
      setFileReadError(pathError);
      setNotice(pathError);
      return;
    }
    setFileReadError("");
    setNotice("");
    if (activeServerIsDemo) {
      const content = demoFiles[path] ?? `Demo binary or generated file: ${path}`;
      setSelectedPath(path);
      setEditorText(content);
      setSavedEditorText(content);
      setDirty(false);
      setSelectedFilePaths([path]);
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
      setNotice(message);
    }
  }

  async function deleteFileEntry(entry: FileEntry) {
    if (isProvisioning || dockerOperationalLock || !canManager || !activeServer) return;
    const pathError = validateSafePath(entry.path);
    if (pathError) {
      setNotice(pathError);
      notify("error", pathError);
      return;
    }
    const confirmation = entry.type === "directory"
      ? `Delete empty directory "${entry.name}"?\n\nOnly this directory will be removed. Non-empty directories are blocked in the browser file manager.`
      : `Delete file "${entry.name}"?\n\nThis will permanently delete ${entry.path}.`;
    if (!window.confirm(confirmation)) return;
    setNotice("");
    if (activeServerIsDemo) {
      let nextFiles = demoFiles;
      if (entry.path.startsWith("/mods/")) {
        setDemoInstalledMods((current) => current.filter((mod) => `/mods/${mod.filename}` !== entry.path));
      } else {
        nextFiles = { ...demoFiles };
        for (const path of Object.keys(nextFiles)) {
          if (path === entry.path || path.startsWith(`${entry.path}/`)) delete nextFiles[path];
        }
        setDemoFiles(nextFiles);
      }
      if (selectedPath === entry.path) {
        setSelectedPath("");
        setEditorText("");
        setSavedEditorText("");
        setDirty(false);
      }
      setSelectedFilePaths((current) => current.filter((path) => path !== entry.path));
      notify("success", `Deleted ${entry.name}`);
      setListing(demoListing(listing.path, nextFiles, demoInstalledMods.filter((mod) => `/mods/${mod.filename}` !== entry.path)));
      return;
    }
    try {
      await api(`/api/servers/${activeServer.id}/file?path=${encodeURIComponent(entry.path)}`, {
        method: "DELETE"
      });
      if (selectedPath === entry.path) {
        setSelectedPath("");
        setEditorText("");
        setSavedEditorText("");
        setDirty(false);
      }
      setSelectedFilePaths((current) => current.filter((path) => path !== entry.path));
      notify("success", `Deleted ${entry.name}`);
      await loadFiles(activeServer.id, listing.path);
      await loadInstalledMods(activeServer.id);
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function deleteSelectedFiles() {
    if (selectedEntries.length === 0) return;
    for (const entry of selectedEntries) {
      await deleteFileEntry(entry);
    }
    setSelectedFilePaths([]);
  }

  async function createFolder() {
    if (!activeServer || fileOperationBusy) return;
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
    const entry = selectedEntries[0];
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
      if (selectedPath === entry.path) setSelectedPath(targetPath);
      notify("success", `Renamed to ${name.trim()}`);
    } catch (error) {
      notify("error", errorMessage(error, "Could not rename the selected item."));
    } finally {
      setFileOperationBusy("");
    }
  }

  async function duplicateSelectedFile() {
    if (!activeServer || selectedEntries.length !== 1 || fileOperationBusy) return;
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
    if (fileSaving) return;
    setFileSaving(true);
    setNotice("");
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
    } catch (error) {
      const message = errorMessage(error, "Could not save the file. Review the path and try again.");
      setNotice(message);
      notify("error", message);
    } finally {
      setFileSaving(false);
    }
  }

  function cancelFileEdit() {
    if (!selectedPath || !dirty) return;
    setEditorText(savedEditorText);
    setDirty(false);
  }

  async function searchMods(event: FormEvent) {
    event.preventDefault();
    if (isProvisioning) return;
    if (!activeServer) return;
    setNotice("");
    setModSearchError("");
    setForceInstallProjectId(null);
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
    setIsSearchingMods(true);
    if (activeServerIsDemo) {
      window.setTimeout(() => {
        const value = searchQuery.toLowerCase();
        setModSearchResults(demoSearchResults.filter((mod) => !value || mod.title.toLowerCase().includes(value) || mod.description.toLowerCase().includes(value)));
        setIsSearchingMods(false);
      }, 250);
      return;
    }
    try {
      const result = await api<{ hits: ModrinthHit[] }>(
        `/api/modrinth/search?query=${encodeURIComponent(searchQuery)}&serverId=${encodeURIComponent(activeServer.id)}&channel=${encodeURIComponent(modInstallChannel)}&compatibility=${encodeURIComponent(modCompatibilityFilter)}`
      );
      setModSearchResults(result.hits);
    } catch (error) {
      const message = errorMessage(error, "Could not search Modrinth. Check the API key and network availability.");
      setModSearchError(message);
      setNotice(message);
      notify("error", message);
    } finally {
      setIsSearchingMods(false);
    }
  }

  async function uploadMod(event: ChangeEvent<HTMLInputElement>) {
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

  async function installMod(projectId: string, title: string, forceIncompatible = false) {
    if (modsLocked || !canManager) return;
    if (!activeServer) return;
    setNotice("");
    const jobId = `install-${projectId}-${Date.now()}`;
    const initialJob: GeneralJob = {
      id: jobId,
      type: "mod-install",
      status: "running",
      title: forceIncompatible ? "Force installing mod" : "Installing mod",
      subject: title,
      progress: 10,
      task: forceIncompatible ? "Installing despite compatibility warning" : "Checking compatibility",
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

        const filename = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || projectId}-demo.jar`;
        const mod: InstalledMod = {
          filename,
          displayName: title,
          enabled: true,
          size: 1_048_576 + Math.round(Math.random() * 2_000_000),
          modifiedAt: new Date().toISOString()
        };
        setDemoInstalledMods((current) => [mod, ...current.filter((candidate) => candidate.filename !== filename)]);
        setInstalledMods((current) => [mod, ...current.filter((candidate) => candidate.filename !== filename)]);
        setNotice(`Installed ${title} as ${filename}`);
        notify("success", `Installed ${title}`);
        setForceInstallProjectId(null);
        setModsView("manager");

        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, status: "succeeded", progress: 100, task: `Installed ${title}`, dismissible: true } : j));
        window.setTimeout(() => {
          setActiveJobs((current) => current.filter((j) => j.id !== jobId));
        }, 4000);
      } catch (err) {
        const msg = (err as Error).message;
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, status: "failed", task: "Install failed", error: msg, dismissible: true } : j));
      }
      return;
    }

    try {
      setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 40, task: "Resolving version and downloading jar" } : j));

      const result = await api<{ filename: string; version: string; channel: ReleaseChannel }>("/api/modrinth/install", {
        method: "POST",
        body: JSON.stringify({ serverId: activeServer.id, projectId, channel: modInstallChannel, forceIncompatible })
      });
      setForceInstallProjectId(null);
      setNotice(`Installed ${title} ${result.version} (${result.channel}) as ${result.filename}`);
      notify("success", `Installed ${title}`);
      setModsView("manager");

      setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, progress: 90, task: "Refreshing installed mods" } : j));
      try {
        await loadInstalledMods(activeServer.id);
        await loadFiles(activeServer.id, "/mods");
        setActiveJobs((current) => current.map((j) => j.id === jobId ? { ...j, status: "succeeded", progress: 100, task: `Installed ${title}`, dismissible: true } : j));
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
    }
  }

  async function updateMod(mod: InstalledMod) {
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
    }
  }

  async function updateModChannel(mod: InstalledMod, channel: ReleaseChannel) {
    if (!canManager || !activeServer || !mod.filename) return;
    if (activeServerIsDemo) {
      setInstalledMods((current) => current.map((candidate) => candidate.filename === mod.filename ? { ...candidate, preferredChannel: channel } : candidate));
      setDemoInstalledMods((current) => current.map((candidate) => candidate.filename === mod.filename ? { ...candidate, preferredChannel: channel } : candidate));
      return;
    }
    await api(`/api/servers/${activeServer.id}/mods/channel`, { method: "PUT", body: JSON.stringify({ filename: mod.filename, channel }) });
    await loadInstalledMods(activeServer.id);
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
    if (modsLocked || !canManager || !activeServer) return;
    setNotice("");
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
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function createSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isProvisioning || scheduleBusy || !canExpanded || !activeServer) return;
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
      return;
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
      return;
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
    } catch (error) {
      const message = errorMessage(error, "Could not create the schedule. Check the cron expression and commands.");
      setNotice(message);
      notify("error", message);
    } finally {
      setScheduleBusy(false);
    }
  }

  async function updateSchedule(schedule: ScheduledExecution, patch: Partial<ScheduledExecution>) {
    if (isProvisioning || scheduleBusy || !canExpanded || !activeServer) return;
    setScheduleBusy(true);
    if (activeServerIsDemo) {
      setDemoSchedules((current) => current.map((candidate) => (
        candidate.id === schedule.id
          ? { ...candidate, ...patch, updatedAt: new Date().toISOString() }
          : candidate
      )));
      notify("success", patch.enabled ? "Schedule enabled" : "Schedule disabled");
      setScheduleBusy(false);
      return;
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
      notify("success", next.enabled ? "Schedule enabled" : "Schedule disabled");
      await refreshApp();
    } catch (error) {
      const message = errorMessage(error, "Could not update the schedule. Try again after refreshing.");
      setNotice(message);
      notify("error", message);
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

  if (!authSession) {
    return (
      <AuthPanel
        setupRequired={false}
        notice={authNotice || "Checking session..."}
        onSubmit={submitAuth}
        busy
      />
    );
  }

  if (!authSession.authenticated && !demoMode) {
    return (
      <AuthPanel
        setupRequired={authSession.setupRequired}
        notice={authNotice}
        onSubmit={submitAuth}
        busy={authSubmitting}
      />
    );
  }

  return (
    <main className={`appShell ${sidebarCollapsed ? "sidebarCollapsed" : ""} ${darkMode ? "themeDark" : "themeLight"}`}>
      <Notifications notices={notices} activeJobs={activeJobs} onDismissJob={(jobId) => setActiveJobs(current => current.filter(j => j.id !== jobId))} />
      {contextModalOpen && (
        <ContextSwitchModal
          nodes={contextNodes}
          activeServerId={activeServer?.id ?? ""}
          expandedNodes={expandedContextNodes}
          modalRef={contextModalRef}
          onClose={closeContextModal}
          onManageNodes={manageNodesPlaceholder}
          onSelectServer={selectContextServer}
          onToggleNode={(nodeId) => setExpandedContextNodes((current) => ({ ...current, [nodeId]: !current[nodeId] }))}
        />
      )}
      <aside className="sidebar">
        <div className="brandBlock">
          <div className="brandLockup">
            <img className="brandLogo" src="/logo.png" alt="" />
            <div>
              <h1>ServerSentinel</h1>
              <p>Managed server web panel</p>
            </div>
          </div>
          <button className="iconButton" onClick={() => setSidebarCollapsed((value) => !value)} aria-label="Toggle sidebar" disabled={isProvisioning}>
            <SidebarToggleIcon collapsed={sidebarCollapsed} />
          </button>
        </div>
        <nav className="sideNav">
          <button className={activePage === "nodes" ? "active" : ""} onClick={() => setActivePage("nodes")} disabled={isProvisioning}>
            <SidebarIcon name="nodes" />
            <span className="navLabel">Nodes</span>
          </button>
          <div className="sidebarDivider" />
          <div className="selectedServerReadout" aria-label="Selected server" title={activeServer?.displayName ?? "No server selected"}>
            {activeServer?.displayName ?? "No server selected"}
          </div>
          <button className={activePage === "overview" ? "active" : ""} onClick={() => setActivePage("overview")} disabled={isProvisioning || !activeServer}>
            <SidebarIcon name="overview" />
            <span className="navLabel">Overview</span>
          </button>
          <button className={activePage === "console" ? "active" : ""} onClick={() => setActivePage("console")} disabled={isProvisioning || !activeServer}>
            <SidebarIcon name="console" />
            <span className="navLabel">Console</span>
          </button>
          <button className={activePage === "files" ? "active" : ""} onClick={() => setActivePage("files")} disabled={isProvisioning || !activeServer}>
            <SidebarIcon name="files" />
            <span className="navLabel">Files</span>
          </button>
          <button className={activePage === "mods" ? "active" : ""} onClick={() => setActivePage("mods")} disabled={isProvisioning || !activeServer}>
            <SidebarIcon name="mods" />
            <span className="navLabel">Mods</span>
          </button>
          <button className={activePage === "schedule" ? "active" : ""} onClick={() => setActivePage("schedule")} disabled={isProvisioning || !activeServer}>
            <SidebarIcon name="schedule" />
            <span className="navLabel">Schedules</span>
          </button>
          <button className={activePage === "properties" ? "active" : ""} onClick={() => setActivePage("properties")} disabled={isProvisioning || !activeServer}>
            <SidebarIcon name="properties" />
            <span className="navLabel">Properties</span>
          </button>
        </nav>
        <nav className="sideNav sideNavBottom">
          <button className={activePage === "settings" ? "active" : ""} onClick={() => setActivePage("settings")} disabled={isProvisioning}>
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
            <button type="button" className="accountLogoutButton" onClick={logout} disabled={isProvisioning} aria-label={demoMode ? "Exit demo" : "Log out"}>
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
            <h2>
              {activePage === "servers" && "Servers"}
              {activePage === "create" && "New Managed Server"}
              {isServerWorkspacePage(activePage) && (activeServer?.displayName ?? (effectiveAppState.servers.length === 0 ? "Welcome" : "No Managed Server Selected"))}
              {activePage === "settings" && "Settings"}
              {activePage === "nodes" && "Nodes"}
            </h2>
          </div>
          <div className="workspaceActions">
            {activePage === "servers" && <button onClick={() => openCreateServerForNode()} disabled={demoMode || isProvisioning || serverCreationBlocked || !canCreateServers}>New managed server</button>}
            {activePage === "create" && <button onClick={() => setActivePage("servers")} disabled={isProvisioning}>Cancel</button>}
            {isServerWorkspacePage(activePage) && activeServer && <button onClick={() => activeNodeRuntimeBlocked ? refreshApp() : refreshStatus()} disabled={isProvisioning}>Refresh</button>}
          </div>
        </header>

        {appStateLoaded && !panelOnlyMode && !effectiveAppState.dockerSocketMounted && (activeNode.isInternal || usableContextNodes.length === 0) && (
          <section className="systemBanner error">
            <strong>Docker integration is not connected.</strong>
            <span>Internal-node runtime management is unavailable until the Docker socket is mounted. Remote nodes can still be used when they are connected and compatible.</span>
          </section>
        )}

        {provisioningError && activePage === "overview" && (
          <section className="systemBanner error" role="alert">
            <strong>Server setup failed.</strong>
            <span>{provisioningError}</span>
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
            message={appLoadError}
            actionLabel="Retry"
            onAction={() => void refreshApp()}
            busy={appRefreshing}
          />
        )}

        {activePage === "servers" && (
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
                <h2>No Managed Servers Yet</h2>
                {panelOnlyMode && usableContextNodes.length === 0 ? (
                  <>
                    <p>Add a node before creating servers. Nodes run the Minecraft containers while this panel manages them.</p>
                    <button
                      onClick={() => {
                        setActivePage("nodes");
                        setAddNodeResult(null);
                        setNodeInstallMethod("compose");
                        if (canManageUsers) setAddNodeOpen(true);
                      }}
                      disabled={demoMode || isProvisioning || Boolean(nodeBusyId) || !canManageUsers}
                    >
                      Add Node
                    </button>
                  </>
                ) : (
                  <>
                    <p>Create a managed server instance to generate Fabric server files and launch a separate Minecraft runtime container.</p>
                    <button onClick={() => openCreateServerForNode()} disabled={demoMode || isProvisioning || serverCreationBlocked || !canCreateServers}>Create Managed Server</button>
                  </>
                )}
              </div>
            )}
          </section>
        )}

        {activePage === "create" && (
          <section className="panel createServerPanel">
            <ManagedServerForm
              onSubmit={createServer}
              dockerSocketMounted={panelOnlyMode ? true : effectiveAppState.dockerSocketMounted}
              nodes={contextNodes}
              preferredNodeId={preferredCreateNodeId}
              versions={fabricVersions}
              totalMemory={effectiveAppState.totalMemory}
              provisioning={isProvisioning || !canCreateServers}
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
                  <strong>version</strong>
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
                  <InlineState tone="loading" title="Loading users" message="Loading user accounts and permissions." />
                )}
                {usersError && (
                  <InlineState
                    tone="error"
                    title="Could not load users"
                    message={usersError}
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
              setNodeInstallMethod("compose");
              setAddNodeOpen(true);
            }}
            onCloseAddNode={() => {
              setAddNodeOpen(false);
              setAddNodeResult(null);
            }}
            onCreateNode={createNode}
            onRefresh={() => void refreshNodes()}
            onViewDetails={viewNodeDetails}
            onShowInstall={showNodeInstall}
            onRotateToken={rotateNodeToken}
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

        {isServerWorkspacePage(activePage) && !activeServer && effectiveAppState.servers.length === 0 && (
          <section className="emptyState">
            <h2>Welcome to ServerSentinel</h2>
            {panelOnlyMode && usableContextNodes.length === 0 ? (
              <>
                <p>Add a node before creating servers. Nodes run the Minecraft containers while this panel manages them.</p>
                <button
                  onClick={() => {
                    setActivePage("nodes");
                    setAddNodeResult(null);
                    setNodeInstallMethod("compose");
                    if (canManageUsers) setAddNodeOpen(true);
                  }}
                  disabled={demoMode || isProvisioning || Boolean(nodeBusyId) || !canManageUsers}
                >
                  Add Node
                </button>
              </>
            ) : (
              <>
                <p>You do not have any managed server instances yet. Create one to generate server files and launch its separate Minecraft runtime container.</p>
                <button onClick={() => openCreateServerForNode()} disabled={demoMode || isProvisioning || serverCreationBlocked || !canCreateServers}>Create Managed Server</button>
              </>
            )}
          </section>
        )}

        {isServerWorkspacePage(activePage) && !activeServer && effectiveAppState.servers.length > 0 && (
          <section className="emptyState">
            <h2>No Server Selected</h2>
            <p>Create or select a server from the Servers page.</p>
            <button onClick={() => setActivePage("servers")}>Open Servers</button>
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
                  busyAction={runtimeAction}
                  onAction={runContainerAction}
                />
                <button
                  type="button"
                  className={`quickActionButton consoleLink ${activePage === "console" ? "active" : ""}`}
                  onClick={() => setActivePage("console")}
                  title="Open Console"
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
                      >
                        Refresh Status
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          downloadConsoleLogs();
                          setOverflowOpen(false);
                        }}
                        disabled={logs.length === 0}
                      >
                        Download Log
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {statusError && (
              <InlineState
                tone="warning"
                title="Status refresh failed"
                message={statusError}
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
                    message="Loading activity, health, and recent events."
                  />
                )}
                {overviewError && (
                  <InlineState
                    tone="warning"
                    title="Overview refresh failed"
                    message={overviewError}
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
                <RecentEventsPanel events={overviewData.events} eventsStatus={overviewData.eventsStatus} formatDate={formatDisplayDate} onOpenConsole={() => setActivePage("console")} />

              </section>
            )}

            {activePage === "console" && (
              <section className="tabPage">
                <section className="panel consolePanel">
                  <div className="panelHeader">
                    <h2>Console</h2>
                    <div className="consoleHeaderActions">
                      <button type="button" onClick={downloadConsoleLogs} disabled={logs.length === 0}>
                        Download log
                      </button>
                      <span className="muted">
                        {activeStatus?.commandInputAvailable
                          ? "Command input enabled"
                          : activeStatus?.commandInputMessage === "Start the runtime container before sending console commands" ||
                            activeStatus?.commandInputMessage === "Start the demo server to enable simulated console input."
                          ? ""
                          : activeStatus?.commandInputMessage}
                      </span>
                    </div>
                  </div>
                  {consoleLoading && (
                    <InlineState tone="loading" title="Loading logs" message="Loading recent console output." />
                  )}
                  {consoleError && (
                    <InlineState
                      tone="warning"
                      title="Could not load logs"
                      message={consoleError}
                      actionLabel="Retry"
                      onAction={() => void refreshConsoleLogs(activeServer.id)}
                      busy={consoleLoading}
                    />
                  )}
                  <div className="terminal">
                    <div className="console" ref={consoleRef} onScroll={handleConsoleScroll}>
                      {logs.length ? logs.map((line, index) => <pre key={index}>{line}</pre>) : <span className="terminalMuted">No log output yet.</span>}
                    </div>
                    {pendingConsoleEntries > 0 && (
                      <button type="button" className="consoleNotice" onClick={jumpToLatestLogs}>
                        {pendingConsoleEntries} new {pendingConsoleEntries === 1 ? "entry" : "entries"} • Jump to latest
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
                              : activeStatus?.commandInputMessage === "Start the demo server to enable simulated console input."
                              ? "Start the demo server to enable simulated console input."
                              : "Console input unavailable"
                          }
                          disabled={isProvisioning || dockerOperationalLock || !canExpanded || !activeStatus?.commandInputAvailable}
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
                      <button disabled={commandSending || isProvisioning || dockerOperationalLock || !canExpanded || !activeStatus?.commandInputAvailable || !commandInput.trim()}>
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
                        <button type="button" className="iconOnlyButton" onClick={() => void navigateFiles(parentPath(listing.path))} disabled={isProvisioning || listing.path === "/"} title={listing.path === "/" ? "Already at server root" : "Up one level"} aria-label="Up one level">
                          <AppIcon name="arrowUp" />
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
                        <button type="button" className="secondaryButton compactButton" onClick={() => fileUploadRef.current?.click()} disabled={isProvisioning || dockerOperationalLock || !canManager || Boolean(fileOperationBusy)} title={!canManager ? "Manager permission is required" : "Upload a file to this folder"}>
                          <AppIcon name="fileUp" />
                          Upload
                        </button>
                        <button type="button" className="secondaryButton compactButton" onClick={createFolder} disabled={isProvisioning || dockerOperationalLock || !canManager || Boolean(fileOperationBusy)} title={!canManager ? "Manager permission is required" : "Create a folder here"}>
                          <AppIcon name="folderPlus" />
                          New Folder
                        </button>
                        <button type="button" className="secondaryButton compactButton" onClick={downloadSelectedFile} disabled={selectedEntries.length !== 1 || selectedEntries[0]?.type !== "file" || Boolean(fileOperationBusy)} title={selectedEntries.length === 1 ? "Download selected file" : "Select one file to download"}>
                          <AppIcon name="download" />
                          Download
                        </button>
                        <button type="button" className="secondaryButton compactButton" onClick={() => loadFiles(activeServer.id, listing.path)} disabled={isProvisioning || filesLoading} title="Reload this folder">
                          <AppIcon name="refresh" />
                          {filesLoading ? "Refreshing" : "Refresh"}
                        </button>
                      </div>
                    </div>

                    {selectedEntries.length > 0 && (
                      <div className="selectionActionBar">
                        <span>{selectedEntries.length} selected</span>
                        <small>{selectedTotalSize > 0 ? formatBytes(selectedTotalSize) : "No file size"}</small>
                        <div>
                          <button type="button" className="secondaryButton compactButton" onClick={() => selectedEntry && openFile(selectedEntry.path)} disabled={!selectedEntry || selectedEntry.type !== "file" || !isEditableFile(selectedEntry) || !canManager} title={selectedEntry?.type === "file" && !isEditableFile(selectedEntry) ? "Only small text files can be edited" : "Edit selected file"}>
                            <AppIcon name="edit" />
                            Edit
                          </button>
                          <button type="button" className="secondaryButton compactButton" onClick={duplicateSelectedFile} disabled={!selectedEntry || selectedEntry.type !== "file" || Boolean(fileOperationBusy)} title={selectedEntry?.type === "directory" ? "Directory duplication is not supported" : "Duplicate selected file"}>
                            <AppIcon name="copy" />
                            Duplicate
                          </button>
                          <button type="button" className="secondaryButton compactButton" onClick={renameSelectedFile} disabled={!selectedEntry || Boolean(fileOperationBusy)} title="Rename selected item">
                            <AppIcon name="rename" />
                            Rename
                          </button>
                          <button type="button" className="dangerButton compactButton" onClick={deleteSelectedFiles} disabled={!canManager || Boolean(fileOperationBusy)} title={!canManager ? "Manager permission is required" : "Delete selected item"}>
                            <AppIcon name="trash" />
                            Delete
                          </button>
                        </div>
                        <button type="button" className="linkButton" onClick={() => setSelectedFilePaths(sortedFileEntries.map((entry) => entry.path))}>Select all</button>
                        <button type="button" className="iconOnlyButton" onClick={() => setSelectedFilePaths([])} title="Clear selection" aria-label="Clear selection">
                          <AppIcon name="x" />
                        </button>
                      </div>
                    )}

                    {filesLoading && listing.entries.length === 0 && (
                      <InlineState tone="loading" title="Loading files" message="Loading the current server directory." />
                    )}
                    {filesError && (
                      <InlineState
                        tone="error"
                        title="Could not load server files"
                        message={filesError}
                        actionLabel="Retry"
                        onAction={() => void loadFiles(activeServer.id, listing.path)}
                        busy={filesLoading}
                      />
                    )}

                    <div className="fileTable" role="table" aria-label="Server files">
                      <div className="fileTableHead" role="row">
                        <span aria-hidden="true" />
                        {([
                          ["name", "Name"],
                          ["modifiedAt", "Date Modified"],
                          ["type", "Type"],
                          ["size", "Size"]
                        ] as Array<[FileSortKey, string]>).map(([key, label]) => (
                          <button key={key} type="button" onClick={() => setFileSort((current) => current.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" })}>
                            {label}
                            {fileSort.key === key ? (fileSort.direction === "asc" ? " ↑" : " ↓") : ""}
                          </button>
                        ))}
                      </div>
                      {!filesLoading && !filesError && sortedFileEntries.length === 0 && (
                        <InlineState tone="empty" title="Directory is empty" message="No files or folders were found at this path." />
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

                  {selectedPath && (
                    <section className="panel editorPanel">
                      <div className="panelHeader">
                        <h2>{dirty ? "Editor *" : "Editor"}</h2>
                        <code>{selectedPath}</code>
                      </div>
                      <textarea value={editorText} onChange={(event) => { setEditorText(event.target.value); setDirty(true); }} disabled={isProvisioning || dockerOperationalLock || !canManager || !selectedPath} spellCheck={false} />
                      {fileReadError && (
                        <InlineState
                          tone="error"
                          title="Could not open file"
                          message={fileReadError}
                          actionLabel={selectedPath ? "Retry" : undefined}
                          onAction={selectedPath ? () => void openFile(selectedPath) : undefined}
                        />
                      )}
                      <div className="buttonRow">
                        {dirty && (
                          <button className="secondaryButton" onClick={cancelFileEdit} disabled={isProvisioning || dockerOperationalLock || !selectedPath}>Cancel</button>
                        )}
                        <button onClick={saveFile} disabled={fileSaving || isProvisioning || dockerOperationalLock || !canManager || !selectedPath || !dirty}>{fileSaving ? "Saving" : "Save"}</button>
                      </div>
                    </section>
                  )}
                </section>

                <aside className="panel fileDetailsPanel">
                  {!selectedEntry && selectedEntries.length === 0 && (
                    <div className="fileDetailsEmpty">
                      <h2>No file selected</h2>
                      <p>Select a file to view details and preview.</p>
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
                        {filePreview.loading && <InlineState tone="loading" title="Loading preview" message="Reading a small preview of the selected file." />}
                        {filePreview.error && <InlineState tone="error" title="Preview failed" message={filePreview.error} />}
                        {!filePreview.loading && !filePreview.error && filePreview.data?.preview === "text" && (
                          <pre>
                            {(filePreview.data.content ?? "").split(/\r?\n/).slice(0, 80).map((line, index) => (
                              <span key={`${index}-${line.slice(0, 8)}`}><b>{index + 1}</b>{line || " "}</span>
                            ))}
                          </pre>
                        )}
                        {!filePreview.loading && !filePreview.error && filePreview.data?.preview !== "text" && (
                          <div className="previewUnavailable">{filePreview.data?.message ?? "Preview unavailable"}</div>
                        )}
                      </section>
                    </div>
                  )}
                </aside>
              </section>
            )}

            {activePage === "mods" && (
              <section className="tabPage">
                <section className="panel modsPanel">
                  <div className="panelHeader modsPanelHeader">
                    <div>
                      <h2>{modsView === "search" ? "Search Modrinth Mods" : "Installed Mods"}</h2>
                    </div>
                    <div className="modsContext modsContextRow">
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
                      <span className={modsLocked ? "warn" : "ok"}>
                        {!activeStatus ? "Checking server state" : activeStatus.docker.running ? "Stop server to edit mods" : "Mod changes enabled"}
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
                          onClick={() => setModsView("search")}
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
                          onClick={() => modUploadRef.current?.click()}
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
                        <InlineState tone="loading" title="Loading installed mods" message="Reading the server mods folder and compatibility metadata." />
                      )}
                      {modsError && (
                        <InlineState
                          tone="error"
                          title="Could not load installed mods"
                          message={modsError}
                          actionLabel="Retry"
                          onAction={() => void loadInstalledMods(activeServer.id)}
                          busy={modsLoading}
                        />
                      )}

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

                        {filteredInstalledMods.length === 0 ? (
                          <div className="emptyInline noBorder">No matching installed mods.</div>
                        ) : (
                          filteredInstalledMods.map((mod) => {
                            const isComp = mod.compatibility?.compatible;
                            const compStatus = mod.compatibility?.status;
                            return (
                              <article key={mod.filename} className={`modsTableRow ${mod.enabled ? "" : "disabled"}`}>
                                <div className="modsTableCell mod-col">
                                  <div className="modInfoCol">
                                    {mod.iconUrl ? (
                                      <img src={mod.iconUrl} alt={mod.displayName} />
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
                                        <span className="updateMeta">Latest: {mod.versionInfo.latestVersion}</span>
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

                      <div className="modsFooterBanner">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="square" strokeLinejoin="miter">
                          <circle cx="12" cy="12" r="10" />
                          <path d="M12 16v-4M12 8h.01" />
                        </svg>
                        <span>Stop the server before adding, removing, or uploading mods. You can enable or disable mods while the server is running.</span>
                      </div>
                    </div>
                  )}

                  {modsView === "search" && (
                    <>
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
                        <select value={modInstallChannel} onChange={(event) => setModInstallChannel(event.target.value as ReleaseChannel)} disabled={isProvisioning || !canManager || !effectiveAppState.modrinthApiConfigured || activeModVersionsUnknown}>
                          <option value="release">Release</option>
                          <option value="beta">Beta</option>
                          <option value="alpha">Alpha</option>
                        </select>
                        <div className="compatibilityFilter" aria-label="Compatibility filter">
                          <strong>Compatibility</strong>
                          {(["all", "compatible", "incompatible"] as ModCompatibilityFilter[]).map((filter) => (
                            <button
                              key={filter}
                              type="button"
                              className={modCompatibilityFilter === filter ? "active" : ""}
                              onClick={() => setModCompatibilityFilter(filter)}
                            >
                              {filter === "all" ? "All" : filter === "compatible" ? "Compatible" : "Incompatible"}
                            </button>
                          ))}
                        </div>
                        <button className="modSearchButton" disabled={isProvisioning || !canManager || isSearchingMods || !effectiveAppState.modrinthApiConfigured || activeModVersionsUnknown || !query.trim()}>{isSearchingMods ? "Searching" : "Search"}</button>
                      </form>
                      <div className="modResultsHeader">
                        <strong>Search results</strong>
                        <span>{isSearchingMods ? "Searching..." : query.trim() ? `${formatDisplayNumber(filteredModSearchResults.length)} shown` : "No query entered"}</span>
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
                            <span>Add a key in Settings before searching for new mods.</span>
                          </div>
                        )}
                        {!isSearchingMods && effectiveAppState.modrinthApiConfigured && activeModVersionsUnknown && (
                          <div className="emptyInline">
                            <strong>Server version unknown</strong>
                            <span>{activeModContext}. ServerSentinel needs both versions to check compatible Modrinth files.</span>
                          </div>
                        )}
                        {!isSearchingMods && effectiveAppState.modrinthApiConfigured && !activeModVersionsUnknown && !query.trim() && (
                          <div className="emptyInline">
                            <strong>Search Modrinth mods</strong>
                            <span>Enter a mod name to load Fabric results for this server.</span>
                          </div>
                        )}
                        {!isSearchingMods && modSearchError && (
                          <InlineState
                            tone="error"
                            title="Search request failed"
                            message={modSearchError}
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
                            <span>Try a different search term.</span>
                          </div>
                        )}
                        {!isSearchingMods && !modSearchError && query.trim() && modSearchResults.length > 0 && filteredModSearchResults.length === 0 && (
                          <div className="emptyInline">
                            <strong>All results filtered out</strong>
                            <span>Switch the compatibility filter to see the loaded results.</span>
                          </div>
                        )}
                        {filteredModSearchResults.map((mod) => (
                          <article key={mod.project_id} className="modRow modSearchResult">
                            {mod.icon_url ? <img src={mod.icon_url} alt="" /> : <div className="modFileIcon">MOD</div>}
                            <div className="modResultMain">
                              <div className="modTitleLine">
                                <strong>{mod.title}</strong>
                              </div>
                              <p>{mod.description}</p>
                              <small>
                                {formatDisplayNumber(mod.downloads)} downloads
                                {formatOptionalModDate(mod.date_modified) && ` · ${formatOptionalModDate(mod.date_modified)}`}
                              </small>
                            </div>
                            <div className="modCompatibilityColumn">
                              <span className={`compatibilityBadge ${compatibilityClass(mod.compatibility)}`}>
                                {compatibilityLabel(mod.compatibility)}
                              </span>
                              <p className={mod.compatibility?.compatible ? "compatibilityReason ok" : "compatibilityReason"}>{modCompatibilityNote(mod)}</p>
                            </div>
                            <div className="modResultAction">
                              {mod.compatibility?.compatible ? (
                                <button onClick={() => installMod(mod.project_id, mod.title)} disabled={modsLocked || !effectiveAppState.modrinthApiConfigured}>Install</button>
                              ) : (
                                <button className="secondaryButton" onClick={() => setForceInstallProjectId(mod.project_id)} disabled={modsLocked || !effectiveAppState.modrinthApiConfigured}>Review</button>
                              )}
                            </div>
                          </article>
                        ))}
                      </div>
                    </>
                  )}
                  {forceInstallMod && (
                    <div className="modalBackdrop" role="presentation">
                      <section className="modalPanel forceInstallModal" role="dialog" aria-modal="true" aria-labelledby="force-install-title">
                        <div className="panelHeader">
                          <h2 id="force-install-title">
                            {forceInstallMod.compatibility?.serverSide === "unsupported" ? "Review client-only mod" : forceInstallMod.compatibility?.serverSide === "unknown" ? "Review unknown side support" : "Review incompatible mod"}
                          </h2>
                          <button type="button" className="iconButton" onClick={() => setForceInstallProjectId(null)} aria-label="Close force install review">
                            <AppIcon name="x" />
                          </button>
                        </div>
                        <div className="forceInstallWarning">
                          <strong>{forceInstallMod.title}</strong>
                          <p>{modCompatibilityNote(forceInstallMod)}</p>
                          <p>
                            {forceInstallMod.compatibility?.serverSide === "unsupported"
                              ? "Client-only mods are designed for the Minecraft client and may crash the server or do nothing if installed. Only force install if you are sure this mod is safe for the server."
                              : forceInstallMod.compatibility?.serverSide === "unknown"
                                ? "Server-side support for this mod could not be verified. It may crash the server or prevent startup. Only force install if you have verified it supports Minecraft servers."
                                : "This mod may crash the server or prevent startup. Only force install it if you have reviewed the project and understand the risk."}
                          </p>
                        </div>
                        <div className="buttonRow">
                          <button type="button" className="secondaryButton" onClick={() => setForceInstallProjectId(null)}>Cancel</button>
                          <button type="button" className="dangerButton" onClick={() => installMod(forceInstallMod.project_id, forceInstallMod.title, true)} disabled={modsLocked || !effectiveAppState.modrinthApiConfigured}>Force install</button>
                        </div>
                      </section>
                    </div>
                  )}

                  {detailsMod && (
                    <div className="modalBackdrop" role="presentation" onClick={() => setDetailsMod(null)}>
                      <section className="modalPanel modDetailsPanel" role="dialog" aria-modal="true" aria-labelledby="details-title" onClick={(e) => e.stopPropagation()}>
                        <div className="panelHeader">
                          <h2 id="details-title">Mod Details</h2>
                          <button type="button" className="iconButton" onClick={() => setDetailsMod(null)} aria-label="Close details">
                            <AppIcon name="x" />
                          </button>
                        </div>
                        <div className="modDetailsHeaderRow">
                          {detailsMod.iconUrl ? (
                            <img src={detailsMod.iconUrl} alt={detailsMod.displayName} className="modDetailsIcon" />
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
                onDelete={deleteSchedule}
                disabled={scheduleBusy || isProvisioning || !canExpanded}
                commandInputMessage={activeStatus?.commandInputAvailable ? "" : activeStatus?.commandInputMessage || "Scheduled commands need Docker command input when they run."}
              />
            )}

            {activePage === "properties" && (
              <section className="tabPage settingsPage">
                <section className="panel">
                  <h2>Server Properties</h2>
                  <ServerEditForm
                    server={activeServer}
                    versions={fabricVersions}
                    totalMemory={effectiveAppState.totalMemory}
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
