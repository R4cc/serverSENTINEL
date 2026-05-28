import { ChangeEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { demoListing, demoOverviewData, demoSearchResults, demoServer, demoServerId, demoStats, demoStatus, initialDemoFiles, initialDemoMods, initialDemoSchedules } from "./demo";
import type { ActivePage, AppState, AuthSession, FabricVersions, FileEntry, FileListing, InstalledMod, LocalePreference, ManagedServer, ModrinthHit, Notice, ProvisionJob, PublicUser, ReleaseChannel, ResourceSample, ResourceStats, ScheduledExecution, ServerOverviewData, ServerStatus, ThemePreference, GeneralJob } from "./types";
import { bufferToBase64, clientId, isEditableFile, parentPath } from "./utils/files";
import { compatibilityClass, compatibilityLabel, defaultServerPort, fabricLoaderVersionInfo, formatBytes, isValidServerPort, maxServerPort, minecraftVersionInfo, minServerPort, readLocalePreference, readThemePreference, resourcePollMs, roleRanks, runtimeLabel, runtimeTone, versionValue } from "./utils/format";
import { AuthPanel, UserManagement } from "./components/AuthPanel";
import { AppIcon, FileTypeIcon, SidebarIcon, SidebarToggleIcon } from "./components/FileTypeIcon";
import { Notifications } from "./components/Notifications";
import { ResourcePanel } from "./components/ResourcePanel";
import { RuntimeControls } from "./components/RuntimeControls";
import { ModrinthKeyForm } from "./components/SettingsPanels";
import { ActivityHealthPanel, OverviewSummary, RecentEventsPanel } from "./pages/OverviewPage";
import { SchedulePage } from "./pages/SchedulesPage";
import { DeleteServerPanel, ManagedServerForm, ServerEditForm } from "./pages/ServerSettingsPage";

const appVersion = "0.1.1";
const serverWorkspacePages: ActivePage[] = ["overview", "console", "files", "mods", "schedule", "properties"];
type ModCompatibilityFilter = "all" | "compatible" | "incompatible";

function isServerWorkspacePage(page: ActivePage) {
  return serverWorkspacePages.includes(page);
}

const emptyApp: AppState = {
  servers: [],
  modrinthApiConfigured: false,
  dockerSocketMounted: false,
  totalMemory: 0
};

const minecraftCommandSuggestions = [
  { command: "help", description: "Show available server commands" },
  { command: "list", description: "List online players" },
  { command: "say ", description: "Broadcast a message" },
  { command: "tellraw @a ", description: "Send JSON chat text" },
  { command: "stop", description: "Gracefully stop the server" },
  { command: "save-all", description: "Save world data" },
  { command: "save-off", description: "Disable automatic saving" },
  { command: "save-on", description: "Enable automatic saving" },
  { command: "whitelist on", description: "Enable the whitelist" },
  { command: "whitelist off", description: "Disable the whitelist" },
  { command: "whitelist list", description: "List whitelisted players" },
  { command: "whitelist add ", description: "Add a player to whitelist" },
  { command: "whitelist remove ", description: "Remove a player from whitelist" },
  { command: "whitelist reload", description: "Reload whitelist file" },
  { command: "op ", description: "Grant operator status" },
  { command: "deop ", description: "Remove operator status" },
  { command: "kick ", description: "Kick a player" },
  { command: "ban ", description: "Ban a player" },
  { command: "pardon ", description: "Unban a player" },
  { command: "ban-ip ", description: "Ban an IP address" },
  { command: "pardon-ip ", description: "Unban an IP address" },
  { command: "banlist", description: "Show ban list" },
  { command: "seed", description: "Show world seed" },
  { command: "reload", description: "Reload datapacks" },
  { command: "defaultgamemode ", description: "Set default game mode" },
  { command: "gamemode survival ", description: "Set player game mode" },
  { command: "gamerule ", description: "Change a game rule" },
  { command: "difficulty ", description: "Set difficulty" },
  { command: "time set day", description: "Set time to day" },
  { command: "time set night", description: "Set time to night" },
  { command: "weather clear", description: "Clear weather" },
  { command: "weather rain", description: "Start rain" },
  { command: "tp ", description: "Teleport entities" },
  { command: "give ", description: "Give items" },
  { command: "clear ", description: "Clear inventory items" },
  { command: "effect give ", description: "Apply an effect" },
  { command: "enchant ", description: "Enchant held item" },
  { command: "xp add ", description: "Add experience" },
  { command: "summon ", description: "Summon an entity" },
  { command: "setblock ", description: "Set a block" },
  { command: "fill ", description: "Fill an area" },
  { command: "locate structure ", description: "Locate a structure" },
  { command: "locate biome ", description: "Locate a biome" },
  { command: "scoreboard ", description: "Manage scoreboards" },
  { command: "team ", description: "Manage teams" },
  { command: "tag ", description: "Manage entity tags" },
  { command: "datapack list", description: "List datapacks" },
  { command: "function ", description: "Run a function" }
];

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

export default function App() {
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [authNotice, setAuthNotice] = useState("");
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [userModal, setUserModal] = useState<"create" | PublicUser | null>(null);
  const [appState, setAppState] = useState<AppState>(emptyApp);
  const [activeServerId, setActiveServerId] = useState("");
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [listing, setListing] = useState<FileListing>({ path: "/", entries: [] });
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
  const [resourceSamples, setResourceSamples] = useState<ResourceSample[]>([]);
  const [overviewData, setOverviewData] = useState<ServerOverviewData>({ events: [], activity: {} });
  const [commandInput, setCommandInput] = useState("");
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
  const [consoleStreamVersion, setConsoleStreamVersion] = useState(0);
  const [runtimeAction, setRuntimeAction] = useState<"start" | "stop" | "restart" | null>(null);
  const [activePage, setActivePage] = useState<ActivePage>("overview");
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
  const activeServerIdRef = useRef("");
  const modToggleStateQueueRef = useRef<Record<string, {
    targetEnabled: boolean;
    inFlightEnabled: boolean | null;
  }>>({});
  const darkMode = themePreference === "dark" || (themePreference === "system" && systemDark);
  const isProvisioning = activeJobs.some((job) => job.type === "provision" && job.status === "running");
  const isAnyModJobRunning = activeJobs.some((job) => (job.type === "mod-install" || job.type === "mod-upload") && job.status === "running");
  const effectiveAppState = useMemo<AppState>(() => {
    if (!demoMode) return appState;
    return {
      ...appState,
      servers: [demoServer(demoSchedules), ...appState.servers.filter((server) => server.id !== demoServerId)],
      modrinthApiConfigured: true,
      dockerSocketMounted: true,
      totalMemory: appState.totalMemory || 16 * 1024 * 1024 * 1024
    };
  }, [appState, demoMode, demoSchedules]);

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
  const activeMinecraftVersion = activeServer ? versionValue(minecraftVersionInfo(activeServer)) : "Unknown";
  const activeFabricLoaderVersion = activeServer ? versionValue(fabricLoaderVersionInfo(activeServer)) : "Unknown";
  const activeModContext = `Fabric ${activeFabricLoaderVersion === "Unknown" ? "unknown" : activeFabricLoaderVersion} · Minecraft ${activeMinecraftVersion === "Unknown" ? "unknown" : activeMinecraftVersion}`;
  const activeModVersionsUnknown = activeFabricLoaderVersion === "Unknown" || activeMinecraftVersion === "Unknown";
  const activeStatus = status?.server.id === activeServer?.id ? status : null;
  const currentRole = authSession?.user?.role;
  const canBasic = activeServerIsDemo || (currentRole ? roleRanks[currentRole] >= roleRanks.basic : false);
  const canExpanded = activeServerIsDemo || (currentRole ? roleRanks[currentRole] >= roleRanks.expanded : false);
  const canManager = activeServerIsDemo || (currentRole ? roleRanks[currentRole] >= roleRanks.manager : false);
  const canManageReal = !demoMode && (currentRole ? roleRanks[currentRole] >= roleRanks.manager : false);
  const canAdmin = currentRole === "admin";
  const authOperationalLock = !demoMode && !authSession?.authenticated;
  const dockerOperationalLock = authOperationalLock || !effectiveAppState.dockerSocketMounted;
  const serverSettingsLocked = isProvisioning || dockerOperationalLock || !canManager || Boolean(activeStatus?.docker.running);
  const modsLocked = isProvisioning || dockerOperationalLock || !canManager || !activeStatus || Boolean(activeStatus.docker.running) || isAnyModJobRunning;
  const modToggleLocked = isProvisioning || dockerOperationalLock || !canManager || !activeStatus || isAnyModJobRunning;
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
    if (mod.compatibility?.compatible) return "Compatible with this server";
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
    if (authSession.user?.role === "admin") {
      void loadUsers();
    }
  }, [authSession?.authenticated, authSession?.user?.role, demoMode]);

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
  }, [activeServer?.id, consoleStreamVersion, demoMode]);

  useEffect(() => {
    if (activePage !== "overview" && activePage !== "console") return;
    if (!consolePinnedToBottom) return;
    window.requestAnimationFrame(() => {
      consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
      setPendingConsoleEntries(0);
    });
  }, [logs, activePage]);

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
    if (!activeServer || (activePage !== "overview" && activePage !== "console")) return;
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
  }, [activeServer?.id, activePage, demoMode, demoRunning]);

  useEffect(() => {
    if (!activeServer || activePage !== "overview") return;
    if (demoMode && activeServer.id === demoServerId) {
      setOverviewData(demoOverviewData(demoRunning));
      return;
    }
    const serverId = activeServer.id;
    let cancelled = false;
    setOverviewData({ events: [], activity: {} });
    async function loadOverviewData() {
      try {
        const data = await api<ServerOverviewData>(`/api/servers/${serverId}/events`);
        if (!cancelled) setOverviewData(data);
      } catch {
        if (!cancelled) setOverviewData({ events: [], activity: {} });
      }
    }
    void loadOverviewData();
    const interval = window.setInterval(() => void loadOverviewData(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeServer?.id, activePage, demoMode, demoRunning]);

  useEffect(() => {
    if (!activeServer || activePage !== "mods" || modsView !== "search" || !effectiveAppState.modrinthApiConfigured) return;
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
          `/api/modrinth/search?query=${encodeURIComponent(trimmedQuery)}&serverId=${encodeURIComponent(activeServer.id)}&channel=${encodeURIComponent(modInstallChannel)}`
        );
        if (!cancelled) setModSearchResults(result.hits);
      } catch (error) {
        if (!cancelled) {
          const message = (error as Error).message;
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
  }, [activeServer?.id, activePage, effectiveAppState.modrinthApiConfigured, modsView, query, activeServerIsDemo, modInstallChannel]);

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
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const username = String(form.get("username") || "");
    const password = String(form.get("password") || "");
    const confirmPassword = String(form.get("confirmPassword") || "");
    const setupRequired = authSession?.setupRequired ?? false;
    const demoLogin = username === "demo" && password === "demo";
    setAuthNotice("");
    if (setupRequired && !demoLogin) {
      if (password.length < 8) {
        setAuthNotice("Password must be at least 8 characters");
        return;
      }
      if (password !== confirmPassword) {
        setAuthNotice("Passwords do not match");
        return;
      }
    }
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

  async function loadUsers() {
    if (!canAdmin) return;
    try {
      const result = await api<{ users: PublicUser[] }>("/api/users");
      setUsers(result.users);
    } catch (error) {
      notify("error", (error as Error).message);
    }
  }

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAdmin) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await api<PublicUser>("/api/users", {
        method: "POST",
        body: JSON.stringify({
          username: form.get("username"),
          password: form.get("password"),
          role: form.get("role")
        })
      });
      formElement.reset();
      setUserModal(null);
      notify("success", "User account created");
      await loadUsers();
    } catch (error) {
      notify("error", (error as Error).message);
    }
  }

  async function updateUser(event: FormEvent<HTMLFormElement>, user: PublicUser) {
    event.preventDefault();
    if (!canAdmin) return;
    const form = new FormData(event.currentTarget);
    try {
      await api<PublicUser>(`/api/users/${user.id}`, {
        method: "PUT",
        body: JSON.stringify({
          username: form.get("username"),
          password: form.get("password"),
          role: form.get("role")
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
    }
  }

  async function deleteUser(user: PublicUser) {
    if (!canAdmin) return;
    if (!window.confirm(`Delete user ${user.username}?`)) return;
    try {
      await api(`/api/users/${user.id}`, { method: "DELETE" });
      notify("success", `Deleted ${user.username}`);
      await loadUsers();
      if (authSession?.user?.id === user.id) {
        await logout();
      }
    } catch (error) {
      notify("error", (error as Error).message);
    }
  }

  async function refreshApp() {
    if (!demoMode && (!authSession || !authSession.authenticated)) {
      return;
    }
    setNotice("");
    try {
      const next = await api<AppState>("/api/app");
      setAppState(next);
      setAppStateLoaded(true);
      if (demoMode) {
        setActiveServerId(demoServerId);
      } else if (!activeServerId && next.servers[0]) {
        setActiveServerId(next.servers[0].id);
      }
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
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
      }
    } catch (error) {
      setNotice((error as Error).message);
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
    try {
      const result = await api<{ text: string; source: string }>(`/api/servers/${serverId}/logs`);
      if (activeServerIdRef.current !== serverId) return;
      const lines = result.text.split(/\r?\n/).filter(Boolean).slice(-200);
      setLogs(lines.map((line) => `[${result.source}] ${line}`));
    } catch {
      setConsoleStreamVersion((version) => version + 1);
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
    if (dockerOperationalLock || !canManageReal) return;
    setNotice("");
    const form = new FormData(event.currentTarget);
    const serverPort = String(form.get("serverPort") ?? "");
    if (!isValidServerPort(serverPort)) {
      const message = `Server port must be between ${minServerPort} and ${maxServerPort}.`;
      setNotice(message);
      notify("error", message);
      return;
    }
    setProvisioningError("");
    const displayName = String(form.get("displayName") || "");
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
    if (isProvisioning || !canManager) return;
    if (!activeServer) return;
    setNotice("");
    const form = new FormData(event.currentTarget);
    if (activeServerIsDemo) {
      notify("success", `Updated ${String(form.get("displayName") || activeServer.displayName)} in demo mode`);
      return;
    }
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
    }
  }

  async function updateModrinthKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageReal) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await api("/api/settings/modrinth", {
        method: "PUT",
        body: JSON.stringify({ modrinthApiKey: form.get("modrinthApiKey") })
      });
      formElement.reset();
      notify("success", "Modrinth API key saved");
      await refreshApp();
    } catch (error) {
      notify("error", (error as Error).message);
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
    if (isProvisioning || !canExpanded) return;
    if (!activeServer) return;
    const command = commandInput.trim().replace(/^\//, "");
    if (!command) return;
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
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
      await refreshStatus(activeServer.id);
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

  async function loadFiles(serverId: string, path: string) {
    if (isProvisioning) return;
    setNotice("");
    if (demoMode && serverId === demoServerId) {
      if (activeServerIdRef.current === serverId) {
        setListing(demoListing(path, demoFiles, demoInstalledMods));
      }
      return;
    }
    try {
      const nextListing = await api<FileListing>(`/api/servers/${serverId}/files?path=${encodeURIComponent(path)}`);
      if (activeServerIdRef.current === serverId) {
        setListing(nextListing);
      }
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function loadInstalledMods(serverId: string) {
    if (isProvisioning) return;
    if (demoMode && serverId === demoServerId) {
      if (activeServerIdRef.current === serverId) {
        setInstalledMods(demoInstalledMods);
      }
      return;
    }
    try {
      const result = await api<{ mods: InstalledMod[] }>(`/api/servers/${serverId}/mods`);
      if (activeServerIdRef.current === serverId) {
        setInstalledMods(result.mods);
      }
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function openFile(path: string) {
    if (isProvisioning) return;
    if (!activeServer) return;
    setNotice("");
    if (activeServerIsDemo) {
      const content = demoFiles[path] ?? `Demo binary or generated file: ${path}`;
      setSelectedPath(path);
      setEditorText(content);
      setSavedEditorText(content);
      setDirty(false);
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
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function deleteFileEntry(entry: FileEntry) {
    if (isProvisioning || dockerOperationalLock || !canManager || !activeServer) return;
    const confirmation = entry.type === "directory"
      ? `Delete empty directory "${entry.name}"?\n\nOnly this directory will be removed. Non-empty directories are blocked in the browser file manager.`
      : `Delete file "${entry.name}"?\n\nThis will permanently delete ${entry.path}.`;
    if (!window.confirm(confirmation)) return;
    setNotice("");
    if (activeServerIsDemo) {
      if (entry.path.startsWith("/mods/")) {
        setDemoInstalledMods((current) => current.filter((mod) => `/mods/${mod.filename}` !== entry.path));
      } else {
        setDemoFiles((current) => {
          const next = { ...current };
          delete next[entry.path];
          return next;
        });
      }
      if (selectedPath === entry.path) {
        setSelectedPath("");
        setEditorText("");
        setSavedEditorText("");
        setDirty(false);
      }
      notify("success", `Deleted ${entry.name}`);
      setListing(demoListing(listing.path, demoFiles, demoInstalledMods.filter((mod) => `/mods/${mod.filename}` !== entry.path)));
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
      notify("success", `Deleted ${entry.name}`);
      await loadFiles(activeServer.id, listing.path);
      await loadInstalledMods(activeServer.id);
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function saveFile() {
    if (isProvisioning || dockerOperationalLock || !canManager) return;
    if (!activeServer) return;
    setNotice("");
    if (activeServerIsDemo) {
      setDemoFiles((current) => ({ ...current, [selectedPath]: editorText }));
      setSavedEditorText(editorText);
      setDirty(false);
      setNotice(`Saved ${selectedPath}`);
      notify("success", `Saved ${selectedPath}`);
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
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
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
    setIsSearchingMods(true);
    if (activeServerIsDemo) {
      window.setTimeout(() => {
        const value = query.trim().toLowerCase();
        setModSearchResults(demoSearchResults.filter((mod) => !value || mod.title.toLowerCase().includes(value) || mod.description.toLowerCase().includes(value)));
        setIsSearchingMods(false);
      }, 250);
      return;
    }
    try {
      const result = await api<{ hits: ModrinthHit[] }>(
        `/api/modrinth/search?query=${encodeURIComponent(query)}&serverId=${encodeURIComponent(activeServer.id)}&channel=${encodeURIComponent(modInstallChannel)}`
      );
      setModSearchResults(result.hits);
    } catch (error) {
      const message = (error as Error).message;
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
    if (!file.name.endsWith(".jar")) {
      notify("error", "Only .jar mod files can be uploaded");
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
    if (isProvisioning || !canExpanded || !activeServer) return;
    setNotice("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    if (activeServerIsDemo) {
      const schedule: ScheduledExecution = {
        id: clientId(),
        name: String(form.get("name") || "Demo schedule"),
        cron: String(form.get("cron") || "* * * * *"),
        commands: form.getAll("commands").map(String).filter(Boolean),
        onlyWhenNoPlayers: form.get("onlyWhenNoPlayers") === "on",
        enabled: form.get("enabled") === "on",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastMessage: "Not run in demo session"
      };
      setDemoSchedules((current) => [schedule, ...current]);
      formElement.reset();
      notify("success", "Demo scheduled execution created");
      return;
    }
    try {
      await api<ScheduledExecution>(`/api/servers/${activeServer.id}/schedules`, {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          cron: form.get("cron"),
          commands: form.getAll("commands"),
          onlyWhenNoPlayers: form.get("onlyWhenNoPlayers") === "on",
          enabled: form.get("enabled") === "on"
        })
      });
      formElement.reset();
      notify("success", "Scheduled execution created");
      await refreshApp();
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function updateSchedule(schedule: ScheduledExecution, patch: Partial<ScheduledExecution>) {
    if (isProvisioning || !canExpanded || !activeServer) return;
    if (activeServerIsDemo) {
      setDemoSchedules((current) => current.map((candidate) => (
        candidate.id === schedule.id
          ? { ...candidate, ...patch, updatedAt: new Date().toISOString() }
          : candidate
      )));
      notify("success", patch.enabled ? "Schedule enabled" : "Schedule disabled");
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
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function deleteSchedule(schedule: ScheduledExecution) {
    if (isProvisioning || dockerOperationalLock || !canExpanded || !activeServer) return;
    if (activeServerIsDemo) {
      setDemoSchedules((current) => current.filter((candidate) => candidate.id !== schedule.id));
      notify("success", `Deleted ${schedule.name}`);
      return;
    }
    try {
      await api(`/api/servers/${activeServer.id}/schedules/${schedule.id}`, { method: "DELETE" });
      notify("success", `Deleted ${schedule.name}`);
      await refreshApp();
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function deleteServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isProvisioning || dockerOperationalLock || !canManager) return;
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
      />
    );
  }

  return (
    <main className={`appShell ${sidebarCollapsed ? "sidebarCollapsed" : ""} ${darkMode ? "themeDark" : "themeLight"}`}>
      <Notifications notices={notices} activeJobs={activeJobs} onDismissJob={(jobId) => setActiveJobs(current => current.filter(j => j.id !== jobId))} />
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
          <div className="serverPickerRow">
            <label className="serverPicker">
              <small>{effectiveAppState.servers.length === 0 ? "No servers created" : "Active managed server"}</small>
              <select
                value={activeServerId}
                onChange={(event) => {
                  if (demoMode && event.target.value !== demoServerId) {
                    notify("info", "Demo mode is enabled. Exit demo mode to access this server.");
                    setActiveServerId(demoServerId);
                    return;
                  }
                  setActiveServerId(event.target.value);
                  if (event.target.value) setActivePage("overview");
                }}
                disabled={isProvisioning || effectiveAppState.servers.length === 0}
              >
                {effectiveAppState.servers.map((server) => (
                  <option key={server.id} value={server.id} disabled={demoMode && server.id !== demoServerId}>
                    {server.displayName}{demoMode && server.id !== demoServerId ? " (demo mode enabled)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="iconButton addServerButton"
              onClick={() => setActivePage("create")}
              disabled={demoMode || isProvisioning || dockerOperationalLock || !canManageReal}
              aria-label="Add server"
              title="Add server"
            >
              <AppIcon name="plus" />
            </button>
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
            </h2>
          </div>
          <div className="workspaceActions">
            {activePage === "servers" && <button onClick={() => setActivePage("create")} disabled={demoMode || isProvisioning || dockerOperationalLock || !canManageReal}>New managed server</button>}
            {activePage === "create" && <button onClick={() => setActivePage("servers")} disabled={isProvisioning}>Cancel</button>}
            {isServerWorkspacePage(activePage) && activeServer && <button onClick={() => refreshStatus()} disabled={isProvisioning}>Refresh</button>}
          </div>
        </header>

        {appStateLoaded && !effectiveAppState.dockerSocketMounted && (
          <section className="systemBanner error">
            <strong>Docker integration is not connected.</strong>
            <span>Runtime management is unavailable until the Docker socket is mounted. Creating runtime containers, starting, stopping, restarting, logs, stats, and console command input require Docker integration.</span>
          </section>
        )}

        {provisioningError && activePage === "overview" && (
          <section className="systemBanner error" role="alert">
            <strong>Server setup failed.</strong>
            <span>{provisioningError}</span>
          </section>
        )}

        {notice && <div className="notice">{notice}</div>}

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
                <p>Create a managed server instance to generate Fabric server files and launch a separate Minecraft runtime container.</p>
                <button onClick={() => setActivePage("create")} disabled={demoMode || isProvisioning || dockerOperationalLock || !canManageReal}>Create Managed Server</button>
              </div>
            )}
          </section>
        )}

        {activePage === "create" && (
          <section className="panel createServerPanel">
            <ManagedServerForm
              onSubmit={createServer}
              dockerSocketMounted={effectiveAppState.dockerSocketMounted}
              versions={fabricVersions}
              totalMemory={effectiveAppState.totalMemory}
              provisioning={isProvisioning || !canManageReal}
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
                <ModrinthKeyForm onSubmit={updateModrinthKey} configured={appState.modrinthApiConfigured} disabled={!canManageReal} />
              </div>
            </section>

            {canAdmin && (
              <section className="panel settingsGroup">
                <div className="settingsGroupHeader usersGroupHeader">
                  <span>03</span>
                  <div>
                    <h2>Users</h2>
                  </div>
                  <button type="button" onClick={() => setUserModal("create")}>New user</button>
                </div>
                <UserManagement
                  users={users}
                  currentUserId={authSession.user?.id}
                  editingUser={userModal}
                  onOpenEdit={(user) => setUserModal(user)}
                  onCloseModal={() => setUserModal(null)}
                  onCreate={createUser}
                  onUpdate={updateUser}
                  onDelete={deleteUser}
                />
              </section>
            )}

            <section className="panel settingsGroup">
              <div className="settingsGroupHeader">
                <span>{canAdmin ? "04" : "03"}</span>
                <div>
                  <h2>Container</h2>
                </div>
              </div>
              <div className="settingsRow readOnly">
                <div>
                  <strong>Docker socket</strong>
                </div>
                <span className={`settingsStatus ${effectiveAppState.dockerSocketMounted ? "ready" : "limited"}`}>
                  {demoMode ? "Demo override" : effectiveAppState.dockerSocketMounted ? "Connected" : "Not mounted"}
                </span>
              </div>
            </section>
          </section>
        )}

        {isServerWorkspacePage(activePage) && !activeServer && effectiveAppState.servers.length === 0 && (
          <section className="emptyState">
            <h2>Welcome to ServerSentinel</h2>
            <p>You do not have any managed server instances yet. Create one to generate server files and launch its separate Minecraft runtime container.</p>
            <button onClick={() => setActivePage("create")} disabled={demoMode || isProvisioning || dockerOperationalLock || !canManageReal}>Create Managed Server</button>
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
                    <span className={`runtimeBadge ${runtimeTone(activeStatus, effectiveAppState.dockerSocketMounted)}`}>
                      {runtimeLabel(activeStatus, effectiveAppState.dockerSocketMounted)}
                    </span>
                  </div>
                  <small className="serverStripMeta">
                    Fabric {activeMinecraftVersion === "Unknown" ? "version unknown" : activeMinecraftVersion}
                  </small>
                </div>
              </div>
              <div className="serverStripRight">
                <RuntimeControls
                  status={activeStatus}
                  controlAvailableFallback={effectiveAppState.dockerSocketMounted && activeServer.hasDockerContainer}
                  isProvisioning={isProvisioning || !canBasic}
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

            {activePage === "overview" && (
              <section className="tabPage overviewPage">
                <OverviewSummary
                  server={activeServer}
                  status={activeStatus}
                  dockerSocketMounted={effectiveAppState.dockerSocketMounted}
                  activity={overviewData.activity}
                  formatDate={formatDisplayDate}
                />

                <ResourcePanel
                  server={activeServer}
                  samples={resourceSamples}
                  status={activeStatus}
                  dockerSocketMounted={effectiveAppState.dockerSocketMounted}
                  formatNumber={formatDisplayNumber}
                />

                <ActivityHealthPanel activity={overviewData.activity} formatDate={formatDisplayDate} />
                <RecentEventsPanel events={overviewData.events} formatDate={formatDisplayDate} onOpenConsole={() => setActivePage("console")} />

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
                          disabled={isProvisioning || !canExpanded || !activeStatus?.commandInputAvailable}
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
                      <button disabled={isProvisioning || !canExpanded || !activeStatus?.commandInputAvailable || !commandInput.trim()}>Send</button>
                    </form>
                  </div>
                </section>
              </section>
            )}

            {activePage === "files" && (
              <section className="tabPage filesPage">
                <section className="panel filesPanel">
                  <div className="panelHeader">
                    <h2>Files</h2>
                    <code>{listing.path}</code>
                  </div>
                  <div className="fileActions">
                    <button onClick={() => loadFiles(activeServer.id, parentPath(listing.path))} disabled={isProvisioning || listing.path === "/"}>Up</button>
                    <button onClick={() => loadFiles(activeServer.id, listing.path)} disabled={isProvisioning}>Refresh</button>
                  </div>
                  <div className="fileList">
                    {listing.entries.map((entry) => (
                      <article key={entry.path} className="fileRow">
                        <button
                          className={`fileOpenButton ${entry.path === selectedPath ? "active" : ""}`}
                          onClick={() => entry.type === "directory" ? loadFiles(activeServer.id, entry.path) : openFile(entry.path)}
                          disabled={isProvisioning || dockerOperationalLock || (entry.type === "file" && !isEditableFile(entry))}
                        >
                          <FileTypeIcon entry={entry} />
                          <span className="fileName">{entry.name}</span>
                          <small>{entry.type === "file" ? formatBytes(entry.size) : ""}</small>
                        </button>
                        <button className="iconDangerButton" onClick={() => deleteFileEntry(entry)} disabled={isProvisioning || dockerOperationalLock || !canManager} title={`Delete ${entry.name}`} aria-label={`Delete ${entry.name}`}>
                          <AppIcon name="x" />
                        </button>
                      </article>
                    ))}
                  </div>
                </section>

                <section className="panel editorPanel">
                  <div className="panelHeader">
                    <h2>Editor</h2>
                    <code>{selectedPath || "No file selected"}</code>
                  </div>
                  <textarea value={editorText} onChange={(event) => { setEditorText(event.target.value); setDirty(true); }} disabled={isProvisioning || dockerOperationalLock || !canManager || !selectedPath} spellCheck={false} />
                  <div className="buttonRow">
                    {dirty && (
                      <button className="secondaryButton" onClick={cancelFileEdit} disabled={isProvisioning || dockerOperationalLock || !selectedPath}>Cancel</button>
                    )}
                    <button onClick={saveFile} disabled={isProvisioning || dockerOperationalLock || !canManager || !selectedPath || !dirty}>Save</button>
                  </div>
                </section>
              </section>
            )}

            {activePage === "mods" && (
              <section className="tabPage">
                <section className="panel modsPanel">
                  <div className="panelHeader modsPanelHeader">
                    <div>
                      <h2>{modsView === "search" ? "Search Modrinth Mods" : "Installed Mods"}</h2>
                    </div>
                    <div className="modsContext" style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                      {modsView === "search" && (
                        <button
                          type="button"
                          className="secondaryButton"
                          style={{ minHeight: "32px", padding: "0 var(--space-3)", fontSize: "11px" }}
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
                  <input ref={modUploadRef} className="hiddenInput" type="file" accept=".jar" onChange={uploadMod} style={{ display: "none" }} />

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
                        <div className="modsSearchInputCompact" style={{ maxWidth: "480px" }}>
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

                      <div className="modsTable">
                        <div className="modsTableHeader">
                          <div className="modsTableCell">Mod</div>
                          <div className="modsTableCell">Compatibility</div>
                          <div className="modsTableCell">Installed Version</div>
                          <div className="modsTableCell">Update Status</div>
                          <div className="modsTableCell">Source</div>
                          <div className="modsTableCell">Status</div>
                          <div className="modsTableCell" style={{ justifySelf: "end" }}>Actions</div>
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
                                    <span className={`compatStatus ${isComp ? "compatible" : compStatus === "unknown" ? "unknown" : "incompatible"}`}>
                                      {isComp ? (
                                        <>
                                          <svg className="buttonIcon" style={{ strokeWidth: 3, width: 14, height: 14, marginRight: "4px" }} viewBox="0 0 24 24">
                                            <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" />
                                          </svg>
                                          <span>Compatible</span>
                                        </>
                                      ) : compStatus === "unknown" ? (
                                        <span>Unknown</span>
                                      ) : (
                                        <>
                                          <svg className="buttonIcon" style={{ strokeWidth: 3, width: 14, height: 14, marginRight: "4px" }} viewBox="0 0 24 24">
                                            <path d="M18 6 6 18M6 6l12 12" fill="none" stroke="currentColor" />
                                          </svg>
                                          <span>Incompatible</span>
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
                                    <span style={{ fontWeight: 800 }}>{mod.versionInfo?.currentVersion || mod.modrinth?.versionNumber || "Unknown"}</span>
                                    {mod.modrinth?.loaders && mod.modrinth.loaders.length > 0 && (
                                      <span className="compatMeta" style={{ textTransform: "capitalize" }}>
                                        {mod.modrinth.loaders.join(", ")}
                                      </span>
                                    )}
                                  </div>
                                </div>

                                <div className="modsTableCell" data-label="Update">
                                  <div className="updateCol">
                                    {mod.versionInfo?.upToDate === true ? (
                                      <span className="updateStatus up-to-date">
                                        <svg className="buttonIcon" style={{ strokeWidth: 3, width: 14, height: 14, marginRight: "4px" }} viewBox="0 0 24 24">
                                          <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" />
                                        </svg>
                                        <span>Up to date</span>
                                      </span>
                                    ) : mod.versionInfo?.upToDate === false ? (
                                      <>
                                        <span className="updateStatus update-available">
                                          <svg className="buttonIcon" style={{ strokeWidth: 3, width: 14, height: 14, marginRight: "4px" }} viewBox="0 0 24 24">
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
                                    <span style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", color: mod.enabled ? "var(--sentinel-success)" : "var(--text-soft)" }}>
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
                          <div className="emptyInline">
                            <strong>Search request failed</strong>
                            <span>{modSearchError}</span>
                          </div>
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
                          <h2 id="force-install-title">Review incompatible mod</h2>
                          <button type="button" className="iconButton" onClick={() => setForceInstallProjectId(null)} aria-label="Close force install review">
                            <AppIcon name="x" />
                          </button>
                        </div>
                        <div className="forceInstallWarning">
                          <strong>{forceInstallMod.title}</strong>
                          <p>{modCompatibilityNote(forceInstallMod)}</p>
                          <p>This mod may crash the server or prevent startup. Only force install it if you have reviewed the project and understand the risk.</p>
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
                disabled={isProvisioning || !canExpanded}
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
                    disabled={isProvisioning || dockerOperationalLock || !canManager}
                  />
                </section>
                <DeleteServerPanel
                  server={activeServer}
                  onSubmit={deleteServer}
                  disabled={isProvisioning || dockerOperationalLock || !canManager}
                />
              </section>
            )}

          </>
        )}
      </section>
    </main>
  );
}
