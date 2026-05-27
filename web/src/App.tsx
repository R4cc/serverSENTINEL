import { ChangeEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { demoListing, demoOverviewData, demoSearchResults, demoServer, demoServerId, demoStats, demoStatus, initialDemoFiles, initialDemoMods, initialDemoSchedules } from "./demo";
import type { ActivePage, AppState, AuthSession, FabricVersions, FileEntry, FileListing, InstalledMod, LocalePreference, ManagedServer, ModrinthHit, Notice, ProvisionJob, PublicUser, ReleaseChannel, ResourceSample, ResourceStats, ScheduledExecution, ServerOverviewData, ServerStatus, ThemePreference } from "./types";
import { bufferToBase64, clientId, isEditableFile, parentPath } from "./utils/files";
import { compatibilityClass, compatibilityLabel, defaultServerPort, formatBytes, isValidServerPort, maxServerPort, minServerPort, readLocalePreference, readThemePreference, resourcePollMs, roleRanks, runtimeLabel, runtimeTone } from "./utils/format";
import { AuthPanel, UserManagement } from "./components/AuthPanel";
import { AppIcon, FileTypeIcon, SidebarIcon, SidebarToggleIcon } from "./components/FileTypeIcon";
import { Notifications } from "./components/Notifications";
import { ResourcePanel } from "./components/ResourcePanel";
import { RuntimeControls } from "./components/RuntimeControls";
import { ModrinthKeyForm, ProvisionProgress } from "./components/SettingsPanels";
import { ActivityHealthPanel, OverviewSummary, RecentEventsPanel } from "./pages/OverviewPage";
import { SchedulePage } from "./pages/SchedulesPage";
import { DeleteServerPanel, ManagedServerForm, ServerEditForm } from "./pages/ServerSettingsPage";

const appVersion = "0.1.1";
const serverWorkspacePages: ActivePage[] = ["overview", "console", "files", "mods", "schedule", "properties"];

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
  return false;
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
  const [isSearchingMods, setIsSearchingMods] = useState(false);
  const [forceInstallProjectId, setForceInstallProjectId] = useState<string | null>(null);
  const [installedMods, setInstalledMods] = useState<InstalledMod[]>([]);
  const [modsView, setModsView] = useState<"manager" | "search">("manager");
  const [resourceSamples, setResourceSamples] = useState<ResourceSample[]>([]);
  const [overviewData, setOverviewData] = useState<ServerOverviewData>({ events: [], activity: {} });
  const [commandInput, setCommandInput] = useState("");
  const [commandInputFocused, setCommandInputFocused] = useState(false);
  const [consolePinnedToBottom, setConsolePinnedToBottom] = useState(true);
  const [pendingConsoleEntries, setPendingConsoleEntries] = useState(0);
  const [commandHistory, setCommandHistory] = useState<string[]>(() => {
    const raw = window.localStorage.getItem("serversentinel-command-history");
    return raw ? JSON.parse(raw) as string[] : [];
  });
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [fabricVersions, setFabricVersions] = useState<FabricVersions>({ game: [], loader: [], installer: [] });
  const [notice, setNotice] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [provisionJob, setProvisionJob] = useState<ProvisionJob | null>(null);
  const [consoleStreamVersion, setConsoleStreamVersion] = useState(0);
  const [runtimeAction, setRuntimeAction] = useState<"start" | "stop" | "restart" | null>(null);
  const [activePage, setActivePage] = useState<ActivePage>("overview");
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
  const darkMode = themePreference === "dark" || (themePreference === "system" && systemDark);
  const isProvisioning = provisionJob?.status === "running";
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
    () => effectiveAppState.servers.find((server) => server.id === activeServerId) ?? effectiveAppState.servers[0],
    [activeServerId, effectiveAppState.servers]
  );
  const activeServerIsDemo = demoMode && activeServer?.id === demoServerId;
  const currentRole = authSession?.user?.role;
  const canBasic = activeServerIsDemo || (currentRole ? roleRanks[currentRole] >= roleRanks.basic : false);
  const canExpanded = activeServerIsDemo || (currentRole ? roleRanks[currentRole] >= roleRanks.expanded : false);
  const canManager = activeServerIsDemo || (currentRole ? roleRanks[currentRole] >= roleRanks.manager : false);
  const canManageReal = currentRole ? roleRanks[currentRole] >= roleRanks.manager : false;
  const canAdmin = currentRole === "admin";
  const authOperationalLock = !demoMode && !authSession?.authenticated;
  const dockerOperationalLock = authOperationalLock || !effectiveAppState.dockerSocketMounted;
  const serverSettingsLocked = isProvisioning || dockerOperationalLock || !canManager || Boolean(status?.docker.running);
  const modsLocked = isProvisioning || dockerOperationalLock || !canManager || !status || Boolean(status.docker.running);
  const commandSuggestions = useMemo(() => {
    const value = commandInput.trimStart().toLowerCase().replace(/^\//, "");
    const matches = value
      ? minecraftCommandSuggestions.filter((suggestion) => suggestion.command.toLowerCase().startsWith(value))
      : minecraftCommandSuggestions.slice(0, 8);
    return matches.slice(0, 8);
  }, [commandInput]);



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
  useEffect(() => {
    void refreshAuth();
  }, []);

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
    refreshStatus(activeServer.id);
    loadFiles(activeServer.id, "/");
    loadInstalledMods(activeServer.id);

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/console?serverId=${encodeURIComponent(activeServer.id)}`);
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "log") {
        setLogs((current) => [...current.slice(-499), `[${message.source}] ${message.text}`]);
      }
      if (message.type === "unavailable") {
        setLogs([message.message]);
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
          setNotice((error as Error).message);
          notify("error", (error as Error).message);
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
      setAuthSession(session);
    } catch (error) {
      setAuthNotice((error as Error).message);
      setAuthSession({ authenticated: false, setupRequired: false, user: null });
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
        setDemoMode(true);
        setAuthSession({ ...session, setupRequired: false });
        setActiveServerId(demoServerId);
        setActivePage("overview");
        return;
      }
      setDemoMode(false);
      setAuthSession(session);
      formElement.reset();
    } catch (error) {
      setAuthNotice((error as Error).message);
    }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => null);
    setDemoMode(false);
    setAuthSession({ authenticated: false, setupRequired: false, user: null });
    setAppState(emptyApp);
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
    setNotice("");
    if (demoMode) {
      if (!activeServerId) setActiveServerId(demoServerId);
      return;
    }
    try {
      const next = await api<AppState>("/api/app");
      setAppState(next);
      if (!activeServerId && next.servers[0]) {
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
      setStatus(demoStatus(demoServer(demoSchedules), demoRunning));
      return;
    }
    try {
      setStatus(await api<ServerStatus>(`/api/servers/${serverId}/status`));
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function refreshConsoleLogs(serverId = activeServer?.id) {
    if (!serverId) return;
    if (demoMode && serverId === demoServerId) {
      setLogs((current) => current.length ? current : [
        "[demo] Starting minecraft server version 1.21.4",
        "[demo] Done (5.132s)! For help, type \"help\""
      ]);
      return;
    }
    try {
      const result = await api<{ text: string; source: string }>(`/api/servers/${serverId}/logs`);
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
      setProvisionJob(job);
      if (job.status === "succeeded") return job;
      if (job.status === "failed") {
        throw new Error(job.error || "Server setup failed");
      }
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    }
  }

  async function createServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    setProvisionJob({
      id: "local",
      status: "running",
      progress: 0,
      task: "Submitting server setup"
    });
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
      setProvisionJob(job);
      const completed = await waitForProvisionJob(job.id);
      const server = completed.server;
      if (!server) {
        throw new Error("Server setup completed without returning server details");
      }
      await refreshApp();
      setActiveServerId(server.id);
      setActivePage("overview");
      setActivePage("overview");
      setConsoleStreamVersion((version) => version + 1);
      await refreshStatus(server.id);
      await refreshConsoleLogs(server.id);
      notify("success", `Created ${server.displayName}`);
      window.setTimeout(() => setProvisionJob(null), 1200);
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
      setProvisionJob((current) => current ? { ...current, status: "failed", task: "Server setup failed", error: (error as Error).message } : null);
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
      setListing(demoListing(path, demoFiles, demoInstalledMods));
      return;
    }
    try {
      setListing(await api<FileListing>(`/api/servers/${serverId}/files?path=${encodeURIComponent(path)}`));
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function loadInstalledMods(serverId: string) {
    if (isProvisioning) return;
    if (demoMode && serverId === demoServerId) {
      setInstalledMods(demoInstalledMods);
      return;
    }
    try {
      const result = await api<{ mods: InstalledMod[] }>(`/api/servers/${serverId}/mods`);
      setInstalledMods(result.mods);
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
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
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
    if (activeServerIsDemo) {
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
      return;
    }
    try {
      await api(`/api/servers/${activeServer.id}/mods/upload`, {
        method: "POST",
        body: JSON.stringify({ filename: file.name, contentBase64: bufferToBase64(await file.arrayBuffer()) })
      });
      notify("success", `Uploaded ${file.name}`);
      await loadInstalledMods(activeServer.id);
      await loadFiles(activeServer.id, "/mods");
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    } finally {
      setIsSearchingMods(false);
    }
  }

  async function installMod(projectId: string, title: string, forceIncompatible = false) {
    if (modsLocked || !canManager) return;
    if (!activeServer) return;
    setNotice("");
    if (activeServerIsDemo) {
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
      setModsView("manager");
      return;
    }
    try {
      const result = await api<{ filename: string; version: string; channel: ReleaseChannel }>("/api/modrinth/install", {
        method: "POST",
        body: JSON.stringify({ serverId: activeServer.id, projectId, channel: modInstallChannel, forceIncompatible })
      });
      setForceInstallProjectId(null);
      setNotice(`Installed ${title} ${result.version} (${result.channel}) as ${result.filename}`);
      notify("success", `Installed ${title}`);
      setModsView("manager");
      await loadInstalledMods(activeServer.id);
      await loadFiles(activeServer.id, "/mods");
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
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

  async function setInstalledModEnabled(mod: InstalledMod, enabled: boolean) {
    if (modsLocked || !canManager || !activeServer) return;
    setNotice("");
    if (activeServerIsDemo) {
      const update = (current: InstalledMod[]) => current.map((candidate) => candidate.filename === mod.filename ? { ...candidate, enabled } : candidate);
      setDemoInstalledMods(update);
      setInstalledMods(update);
      notify("success", `${enabled ? "Enabled" : "Disabled"} ${mod.displayName}`);
      return;
    }
    try {
      await api(`/api/servers/${activeServer.id}/mods`, {
        method: "PATCH",
        body: JSON.stringify({ filename: mod.filename, enabled })
      });
      notify("success", `${enabled ? "Enabled" : "Disabled"} ${mod.displayName}`);
      await loadInstalledMods(activeServer.id);
      await loadFiles(activeServer.id, "/mods");
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
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
      <Notifications notices={notices} />
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
              <small>Active managed server</small>
              <select
                value={activeServerId}
                onChange={(event) => {
                  setActiveServerId(event.target.value);
                  if (event.target.value) setActivePage("overview");
                }}
                disabled={isProvisioning || effectiveAppState.servers.length === 0}
              >
                <option value="">Select managed server</option>
                {effectiveAppState.servers.map((server) => (
                  <option key={server.id} value={server.id}>{server.displayName}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="iconButton addServerButton"
              onClick={() => setActivePage("create")}
              disabled={isProvisioning || dockerOperationalLock || !canManageReal}
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
            {activePage === "servers" && <button onClick={() => setActivePage("create")} disabled={isProvisioning || dockerOperationalLock || !canManageReal}>New managed server</button>}
            {activePage === "create" && <button onClick={() => setActivePage("servers")} disabled={isProvisioning}>Cancel</button>}
            {isServerWorkspacePage(activePage) && activeServer && <button onClick={() => refreshStatus()} disabled={isProvisioning}>Refresh</button>}
          </div>
        </header>

        {provisionJob && (
          <ProvisionProgress job={provisionJob} />
        )}

        {!effectiveAppState.dockerSocketMounted && (
          <section className="systemBanner error">
            <strong>Docker integration is not connected.</strong>
            <span>Runtime management is unavailable until the Docker socket is mounted. Creating runtime containers, starting, stopping, restarting, logs, stats, and console command input require Docker integration.</span>
          </section>
        )}

        {notice && <div className="notice">{notice}</div>}

        {activePage === "servers" && (
          <section className="pageStack">
            {effectiveAppState.servers.length > 0 ? (
              <section className="serverList">
                {effectiveAppState.servers.map((server) => (
                  <button
                    key={server.id}
                    className={`serverListItem ${server.id === activeServer?.id ? "active" : ""}`}
                    disabled={isProvisioning}
                    onClick={() => {
                      setActiveServerId(server.id);
                      setActivePage("overview");
                    }}
                  >
                    <strong>{server.displayName}</strong>
                    <span>{server.minecraftVersion || "Version unknown"} · Fabric</span>
                  </button>
                ))}
              </section>
            ) : (
              <div className="emptyState">
                <h2>No Managed Servers Yet</h2>
                <p>Create a managed server instance to generate Fabric server files and launch a separate Minecraft runtime container.</p>
                <button onClick={() => setActivePage("create")} disabled={isProvisioning || dockerOperationalLock || !canManageReal}>Create Managed Server</button>
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
            <button onClick={() => setActivePage("create")} disabled={isProvisioning || dockerOperationalLock || !canManageReal}>Create Managed Server</button>
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
              <div>
                <strong>{activeServer.displayName}</strong>
                <span>{activeServer.minecraftVersion || "Version unknown"} · Fabric</span>
              </div>
              <div className="activeServerRuntime">
                <span className={`runtimeBadge ${runtimeTone(status, effectiveAppState.dockerSocketMounted)}`}>
                  {runtimeLabel(status, effectiveAppState.dockerSocketMounted)}
                </span>
                <RuntimeControls
                  status={status}
                  isProvisioning={isProvisioning || !canBasic}
                  busyAction={runtimeAction}
                  onAction={runContainerAction}
                />
              </div>
            </div>

            {activePage === "overview" && (
              <section className="tabPage overviewPage">
                <OverviewSummary
                  server={activeServer}
                  status={status}
                  dockerSocketMounted={effectiveAppState.dockerSocketMounted}
                  activity={overviewData.activity}
                  formatDate={formatDisplayDate}
                />

                <ResourcePanel
                  server={activeServer}
                  samples={resourceSamples}
                  status={status}
                  dockerSocketMounted={effectiveAppState.dockerSocketMounted}
                  formatNumber={formatDisplayNumber}
                />

                <ActivityHealthPanel activity={overviewData.activity} formatDate={formatDisplayDate} />
                <RecentEventsPanel events={overviewData.events} onOpenConsole={() => setActivePage("console")} />

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
                      <span className="muted">{status?.commandInputAvailable ? "Command input enabled" : status?.commandInputMessage}</span>
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
                          placeholder={status?.commandInputAvailable ? "Enter command" : "Console input unavailable"}
                          disabled={isProvisioning || !canExpanded || !status?.commandInputAvailable}
                          spellCheck={false}
                          autoComplete="off"
                        />
                        {commandInputFocused && commandInput.trim().length > 0 && status?.commandInputAvailable && commandSuggestions.length > 0 && (
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
                      <button disabled={isProvisioning || !canExpanded || !status?.commandInputAvailable || !commandInput.trim()}>Send</button>
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
                          className="fileOpenButton"
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
                  <div className="panelHeader">
                    <h2>Mods</h2>
                    <span className={modsLocked ? "warn" : "ok"}>
                      {!status ? "Checking server state" : status.docker.running ? "Stop server to edit mods" : "Mod changes enabled"}
                    </span>
                  </div>
                  {!effectiveAppState.modrinthApiConfigured && (
                    <section className="systemBanner accent">
                      <strong>Modrinth API key is not configured.</strong>
                      <span>Installed mod management still works. Add a key in Settings to search and install new mods.</span>
                    </section>
                  )}
                  <div className="modsToolbar">
                    <div className="segmentedControl">
                      <button className={modsView === "manager" ? "active" : ""} onClick={() => setModsView("manager")}>Installed</button>
                      <button className={modsView === "search" ? "active" : ""} onClick={() => setModsView("search")} disabled={!effectiveAppState.modrinthApiConfigured || !canManager}>Search</button>
                    </div>
                    <input ref={modUploadRef} className="hiddenInput" type="file" accept=".jar" onChange={uploadMod} />
                    <span className="muted">Fabric {activeServer.loaderVersion || "loader unknown"} - Minecraft {activeServer.minecraftVersion || "version unknown"}</span>
                  </div>

                  {modsView === "manager" && (
                    <div className="mods">
                      <div className="modActionGrid">
                        <button className="modRow addModRow" onClick={() => setModsView("search")} disabled={isProvisioning || !canManager || !effectiveAppState.modrinthApiConfigured}>
                          <span className="addIcon"><AppIcon name="plus" /></span>
                          <div>
                            <strong>Add mod</strong>
                            <p>Search Modrinth for compatible Fabric mods.</p>
                          </div>
                        </button>
                        <button className="modRow addModRow" onClick={() => modUploadRef.current?.click()} disabled={modsLocked}>
                          <span className="addIcon"><AppIcon name="fileUp" /></span>
                          <div>
                            <strong>Upload jar</strong>
                            <p>Add a local Fabric mod file to this server.</p>
                          </div>
                        </button>
                      </div>
                      {installedMods.length === 0 && (
                        <div className="emptyInline">No installed mods yet.</div>
                      )}
                      {installedMods.map((mod) => (
                        <article key={mod.filename} className={`modRow ${mod.enabled ? "" : "disabled"}`}>
                          {mod.iconUrl ? <img src={mod.iconUrl} alt="" /> : <div className="modFileIcon">JAR</div>}
                          <div>
                            <div className="modTitleLine">
                              <strong>{mod.displayName}</strong>
                              {(!mod.compatibility || !mod.compatibility.compatible || mod.compatibility.status === "unknown") && (
                                <details className={`compatibilityBadge ${compatibilityClass(mod.compatibility)}`}>
                                  <summary>{compatibilityLabel(mod.compatibility)}</summary>
                                  <p>{mod.compatibility?.reason || "Compatibility could not be verified."}</p>
                                </details>
                              )}
                            </div>
                            <p>{mod.enabled ? "Enabled" : "Disabled"} - {formatBytes(mod.size)} - Modified {formatDisplayDate(mod.modifiedAt)}</p>
                            <small>{mod.filename}</small>
                            {mod.modrinth && (
                              <small>Modrinth {mod.modrinth.versionNumber} - {mod.modrinth.loaders.join(", ") || "loader unknown"} - Minecraft {mod.modrinth.gameVersions.join(", ") || "version unknown"}</small>
                            )}
                            {mod.versionInfo && (
                              <small className={mod.versionInfo.upToDate ? "ok" : "warn"}>
                                {mod.versionInfo.upToDate
                                  ? `Up-to-date: ${mod.versionInfo.currentVersion || "unknown"}`
                                  : `${mod.versionInfo.currentVersion || "unknown"} → ${mod.versionInfo.latestVersion || "unknown"} (${mod.versionInfo.latestChannel || "unknown"})`}
                              </small>
                            )}
                          </div>
                          <div className="modActions">
                            <button onClick={() => setInstalledModEnabled(mod, !mod.enabled)} disabled={modsLocked}>
                              {mod.enabled ? "Disable" : "Enable"}
                            </button>
                            <select value={mod.preferredChannel || "release"} onChange={(event) => updateModChannel(mod, event.target.value as ReleaseChannel)} disabled={isProvisioning || !canManager}>
                              <option value="release">Release</option>
                              <option value="beta">Beta</option>
                              <option value="alpha">Alpha</option>
                            </select>
                            <button className="dangerTextButton" onClick={() => removeInstalledMod(mod)} disabled={modsLocked}>
                              Remove
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}

                  {modsView === "search" && (
                    <>
                      <form onSubmit={searchMods} className="modSearch">
                        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Modrinth mods" disabled={isProvisioning || !canManager || !effectiveAppState.modrinthApiConfigured} />
                        <select value={modInstallChannel} onChange={(event) => setModInstallChannel(event.target.value as ReleaseChannel)} disabled={isProvisioning || !canManager}>
                          <option value="release">Release</option>
                          <option value="beta">Beta</option>
                          <option value="alpha">Alpha</option>
                        </select>
                        <button disabled={isProvisioning || !canManager || isSearchingMods || !effectiveAppState.modrinthApiConfigured || !query.trim()}>{isSearchingMods ? "Searching" : "Refresh"}</button>
                      </form>
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
                        {!isSearchingMods && query.trim() && modSearchResults.length === 0 && (
                          <div className="emptyInline">
                            <strong>No mods found</strong>
                            <span>Try a different search term.</span>
                          </div>
                        )}
                        {modSearchResults.map((mod) => (
                          <article key={mod.project_id} className={`modRow ${mod.compatibility?.compatible ? "" : "incompatible"}`}>
                            {mod.icon_url ? <img src={mod.icon_url} alt="" /> : <div className="modFileIcon">MOD</div>}
                            <div>
                              <div className="modTitleLine">
                                <strong>{mod.title}</strong>
                                <span className={`compatibilityBadge ${compatibilityClass(mod.compatibility)}`}>
                                  {compatibilityLabel(mod.compatibility)}
                                </span>
                              </div>
                              <p>{mod.description}</p>
                              {mod.compatibility && !mod.compatibility.compatible && (
                                <p className="compatibilityReason">{mod.compatibility.reason}</p>
                              )}
                              <small>{formatDisplayNumber(mod.downloads)} downloads</small>
                              {forceInstallProjectId === mod.project_id && !mod.compatibility?.compatible && (
                                <div className="forceInstallWarning">
                                  <strong>Force install incompatible mod?</strong>
                                  <p>This may prevent the server from starting or may cause crashes.</p>
                                  <div className="buttonRow">
                                    <button className="dangerButton" onClick={() => installMod(mod.project_id, mod.title, true)} disabled={modsLocked || !effectiveAppState.modrinthApiConfigured}>Force Install</button>
                                    <button className="secondaryButton" onClick={() => setForceInstallProjectId(null)}>Cancel</button>
                                  </div>
                                </div>
                              )}
                            </div>
                            {mod.compatibility?.compatible ? (
                              <button onClick={() => installMod(mod.project_id, mod.title)} disabled={modsLocked || !effectiveAppState.modrinthApiConfigured}>Install</button>
                            ) : (
                              <button className="dangerTextButton" onClick={() => setForceInstallProjectId(mod.project_id)} disabled={modsLocked || !effectiveAppState.modrinthApiConfigured}>Review Risk</button>
                            )}
                          </article>
                        ))}
                      </div>
                    </>
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
                commandInputMessage={status?.commandInputAvailable ? "" : status?.commandInputMessage || "Scheduled commands need Docker command input when they run."}
              />
            )}

            {activePage === "properties" && (
              <section className="settingsPage">
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
