import { ChangeEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

type AttachedServer = {
  id: string;
  displayName: string;
  directoryLabel: string;
  storageName?: string;
  minecraftVersion?: string;
  loaderVersion?: string;
  installerVersion?: string;
  serverJar?: string;
  dockerContainer?: string;
  dockerImage?: string;
  dockerPorts?: string;
  javaArgs?: string;
  schedules?: ScheduledExecution[];
  serverType: "fabric";
  hasDockerContainer: boolean;
};

type ScheduledExecution = {
  id: string;
  name: string;
  cron: string;
  commands: string[];
  onlyWhenNoPlayers: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: string;
  lastMessage?: string;
};

type AppState = {
  servers: AttachedServer[];
  modrinthApiConfigured: boolean;
  dockerSocketMounted: boolean;
  totalMemory: number;
};

type DockerStatus = {
  configured: boolean;
  available: boolean;
  controllable: boolean;
  state: string;
  running?: boolean;
  container?: string;
  message?: string;
};

type ServerStatus = {
  server: AttachedServer;
  docker: DockerStatus;
  fileLogsAvailable: boolean;
  controlAvailable: boolean;
  commandInputAvailable: boolean;
  commandInputMessage: string;
};

type ResourceStats = {
  available: boolean;
  running: boolean;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  readAt: string;
  container?: string;
  message?: string;
};

type ResourceSample = ResourceStats & {
  sampledAt: number;
};

type FileEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number;
  modifiedAt: string;
};

type FileListing = {
  path: string;
  entries: FileEntry[];
};

type ModrinthHit = {
  project_id: string;
  title: string;
  description: string;
  downloads: number;
  icon_url?: string;
};

type InstalledMod = {
  filename: string;
  displayName: string;
  enabled: boolean;
  size: number;
  modifiedAt: string;
  iconUrl?: string;
};

type FabricVersions = {
  game: Array<{ version: string; stable: boolean }>;
  loader: Array<{ version: string; stable: boolean }>;
  installer: Array<{ version: string; stable: boolean }>;
};

type Notice = {
  id: number;
  type: "success" | "error" | "info";
  text: string;
};

type ProvisionJob = {
  id: string;
  status: "running" | "succeeded" | "failed";
  progress: number;
  task: string;
  server?: AttachedServer;
  error?: string;
};

type ActivePage = "servers" | "server" | "settings" | "create";
type ThemePreference = "light" | "dark" | "system";

const emptyApp: AppState = {
  servers: [],
  modrinthApiConfigured: false,
  dockerSocketMounted: false,
  totalMemory: 0
};

const defaultServerPort = 25565;
const minServerPort = 1000;
const maxServerPort = 65000;
const resourcePollMs = 5_000;

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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = {
    ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(init?.headers as Record<string, string> | undefined)
  };
  const response = await fetch(path, {
    headers,
    ...init
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed with ${response.status}`);
  }
  return payload as T;
}

function parentPath(path: string) {
  if (path === "/") return "/";
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function isEditableFile(entry: FileEntry) {
  if (entry.type !== "file" || entry.size > 2 * 1024 * 1024) return false;
  const extension = entry.name.split(".").pop()?.toLowerCase() ?? "";
  return ["txt", "json", "json5", "properties", "toml", "yml", "yaml", "cfg", "conf", "log", "md", "csv", "env"].includes(extension)
    || !entry.name.includes(".");
}

function bufferToBase64(buffer: ArrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return window.btoa(binary);
}

function formatMegabytes(value: number) {
  if (!value) return "0 MB";
  return `${Math.round(value / 1024 / 1024).toLocaleString()} MB`;
}

function totalMemoryGb(totalMemory: number) {
  return Math.max(1, totalMemory ? Math.round(totalMemory / (1024 * 1024 * 1024)) : 16);
}

function parseMaxMemoryGb(javaArgs?: string) {
  const match = (javaArgs || "").match(/-Xmx(\d+)G/);
  return match ? parseInt(match[1], 10) : 4;
}

function memoryArgs(memoryGb: number) {
  return `-Xms${Math.max(1, Math.floor(memoryGb / 2))}G -Xmx${memoryGb}G`;
}

function defaultDockerImageForMinecraftVersion(version?: string) {
  const [major, minor, patch] = (version ?? "").split(".").map((part) => Number(part));
  if (Number.isFinite(major) && major >= 26) return "eclipse-temurin:25-jre";
  if (major === 1 && Number.isFinite(minor) && minor >= 20 && (minor > 20 || (patch ?? 0) >= 5)) return "eclipse-temurin:21-jre";
  return "eclipse-temurin:17-jre";
}

function clientId() {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function replaceMemoryArgs(javaArgs: string, memoryGb: number) {
  const xms = `-Xms${Math.max(1, Math.floor(memoryGb / 2))}G`;
  const xmx = `-Xmx${memoryGb}G`;
  const withoutXms = javaArgs.replace(/(^|\s)-Xms\S+/g, "").trim();
  const withoutMemory = withoutXms.replace(/(^|\s)-Xmx\S+/g, "").trim();
  return [xms, xmx, withoutMemory].filter(Boolean).join(" ");
}

function isValidServerPort(port: string) {
  if (!/^\d+$/.test(port)) return false;
  const value = Number(port);
  return value >= minServerPort && value <= maxServerPort;
}

function runtimeLabel(status: ServerStatus | null, dockerSocketMounted: boolean) {
  if (!status) return "Checking container";
  if (!dockerSocketMounted) return "Docker socket not mounted";
  if (!status.docker.configured) return "Container control not configured";
  if (!status.docker.available) return status.docker.message || "Container unavailable";
  if (status.docker.running) return "Container running";
  if (status.docker.state && status.docker.state !== "unknown") return `Container ${status.docker.state}`;
  return "Container status unavailable";
}

function runtimeTone(status: ServerStatus | null, dockerSocketMounted: boolean) {
  if (!status || !dockerSocketMounted || !status.docker.configured || !status.docker.available) return "neutral";
  return status.docker.running ? "running" : "stopped";
}

function SidebarIcon({ name }: { name: "servers" | "settings" }) {
  if (name === "servers") {
    return (
      <svg className="sideIcon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="5" width="16" height="4" rx="1.5" />
        <rect x="4" y="10" width="16" height="4" rx="1.5" />
        <rect x="4" y="15" width="16" height="4" rx="1.5" />
        <circle cx="7" cy="7" r="0.8" />
        <circle cx="7" cy="12" r="0.8" />
        <circle cx="7" cy="17" r="0.8" />
      </svg>
    );
  }
  return (
    <svg className="sideIcon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z" />
      <path d="m19.4 13.5.1-1.5-.1-1.5 2-1.5-2-3.5-2.5 1a8 8 0 0 0-2.6-1.5L14 2.3h-4l-.4 2.7A8 8 0 0 0 7 6.5l-2.5-1-2 3.5 2 1.5-.1 1.5.1 1.5-2 1.5 2 3.5 2.5-1a8 8 0 0 0 2.6 1.5l.4 2.7h4l.4-2.7A8 8 0 0 0 17 17.5l2.5 1 2-3.5-2.1-1.5Z" />
    </svg>
  );
}

function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg className="toggleIcon" viewBox="0 0 24 24" aria-hidden="true">
      {collapsed ? <path d="M9 5l7 7-7 7" /> : <path d="M15 5l-7 7 7 7" />}
    </svg>
  );
}

function readThemePreference(): ThemePreference {
  const saved = window.localStorage.getItem("serversentinel-theme");
  return saved === "dark" || saved === "system" || saved === "light" ? saved : "light";
}

export default function App() {
  const [appState, setAppState] = useState<AppState>(emptyApp);
  const [activeServerId, setActiveServerId] = useState("");
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [listing, setListing] = useState<FileListing>({ path: "/", entries: [] });
  const [selectedPath, setSelectedPath] = useState("");
  const [editorText, setEditorText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [modSearchResults, setModSearchResults] = useState<ModrinthHit[]>([]);
  const [installedMods, setInstalledMods] = useState<InstalledMod[]>([]);
  const [modsView, setModsView] = useState<"manager" | "search">("manager");
  const [resourceSamples, setResourceSamples] = useState<ResourceSample[]>([]);
  const [commandInput, setCommandInput] = useState("");
  const [commandInputFocused, setCommandInputFocused] = useState(false);
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
  const [activePage, setActivePage] = useState<ActivePage>("server");
  const [activeTab, setActiveTab] = useState<"overview" | "files" | "mods" | "schedule" | "settings">("overview");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readThemePreference());
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const consoleRef = useRef<HTMLDivElement>(null);
  const modUploadRef = useRef<HTMLInputElement>(null);
  const darkMode = themePreference === "dark" || (themePreference === "system" && systemDark);
  const isProvisioning = provisionJob?.status === "running";
  const modsLocked = isProvisioning || !status || Boolean(status.docker.running);

  const activeServer = useMemo(
    () => appState.servers.find((server) => server.id === activeServerId) ?? appState.servers[0],
    [activeServerId, appState.servers]
  );
  const commandSuggestions = useMemo(() => {
    const value = commandInput.trimStart().toLowerCase().replace(/^\//, "");
    const matches = value
      ? minecraftCommandSuggestions.filter((suggestion) => suggestion.command.toLowerCase().startsWith(value))
      : minecraftCommandSuggestions.slice(0, 8);
    return matches.slice(0, 8);
  }, [commandInput]);

  useEffect(() => {
    refreshApp();
    api<FabricVersions>("/api/fabric/versions").then(setFabricVersions).catch(() => {
      setFabricVersions({
        game: [{ version: "1.21.4", stable: true }, { version: "1.21.1", stable: true }, { version: "1.20.1", stable: true }],
        loader: [],
        installer: []
      });
    });
  }, []);

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
  }, [activeServer?.id, consoleStreamVersion]);

  useEffect(() => {
    if (activeTab !== "overview") return;
    window.requestAnimationFrame(() => {
      consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
    });
  }, [logs, activeTab]);

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
    window.localStorage.setItem("serversentinel-command-history", JSON.stringify(commandHistory.slice(-50)));
  }, [commandHistory]);

  useEffect(() => {
    if (!activeServer || activePage !== "server" || activeTab !== "overview") return;
    const serverId = activeServer.id;
    let cancelled = false;
    setResourceSamples([]);
    async function pollStats() {
      try {
        const stats = await api<ResourceStats>(`/api/servers/${serverId}/stats`);
        if (cancelled) return;
        setResourceSamples([{ ...stats, sampledAt: Date.now() }]);
      } catch (error) {
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
      }
    }
    void pollStats();
    const interval = window.setInterval(() => void pollStats(), resourcePollMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeServer?.id, activePage, activeTab]);

  useEffect(() => {
    if (!activeServer || activeTab !== "mods" || modsView !== "search" || !appState.modrinthApiConfigured) return;
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setModSearchResults([]);
      return;
    }
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      try {
        const result = await api<{ hits: ModrinthHit[] }>(
          `/api/modrinth/search?query=${encodeURIComponent(trimmedQuery)}&serverId=${encodeURIComponent(activeServer.id)}`
        );
        if (!cancelled) setModSearchResults(result.hits);
      } catch (error) {
        if (!cancelled) {
          setNotice((error as Error).message);
          notify("error", (error as Error).message);
        }
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [activeServer?.id, activeTab, appState.modrinthApiConfigured, modsView, query]);

  function notify(type: Notice["type"], text: string) {
    const id = Date.now() + Math.random();
    setNotices((current) => [...current, { id, type, text }]);
    window.setTimeout(() => {
      setNotices((current) => current.filter((candidate) => candidate.id !== id));
    }, 5000);
  }

  async function refreshApp() {
    setNotice("");
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
    try {
      setStatus(await api<ServerStatus>(`/api/servers/${serverId}/status`));
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function refreshConsoleLogs(serverId = activeServer?.id) {
    if (!serverId) return;
    try {
      const result = await api<{ text: string; source: string }>(`/api/servers/${serverId}/logs`);
      const lines = result.text.split(/\r?\n/).filter(Boolean).slice(-200);
      setLogs(lines.map((line) => `[${result.source}] ${line}`));
    } catch {
      setConsoleStreamVersion((version) => version + 1);
    }
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

  async function attachServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      setActivePage("server");
      setActiveTab("overview");
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
    if (isProvisioning) return;
    if (!activeServer) return;
    setNotice("");
    const form = new FormData(event.currentTarget);
    try {
      const server = await api<AttachedServer>(`/api/servers/${activeServer.id}`, {
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
    if (isProvisioning) return;
    if (!activeServer) return;
    setNotice("");
    setRuntimeAction(action);
    try {
      await api(`/api/servers/${activeServer.id}/${action}`, { method: "POST" });
      await refreshStatus(activeServer.id);
      setConsoleStreamVersion((version) => version + 1);
      await refreshConsoleLogs(activeServer.id);
      notify("success", `Sent ${action} request`);
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    } finally {
      setRuntimeAction(null);
    }
  }

  async function sendCommand(event: FormEvent) {
    event.preventDefault();
    if (isProvisioning) return;
    if (!activeServer) return;
    const command = commandInput.trim().replace(/^\//, "");
    if (!command) return;
    setNotice("");
    try {
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
    try {
      setListing(await api<FileListing>(`/api/servers/${serverId}/files?path=${encodeURIComponent(path)}`));
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function loadInstalledMods(serverId: string) {
    if (isProvisioning) return;
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
    try {
      const file = await api<{ path: string; content: string }>(
        `/api/servers/${activeServer.id}/file?path=${encodeURIComponent(path)}`
      );
      setSelectedPath(file.path);
      setEditorText(file.content);
      setDirty(false);
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function deleteFileEntry(entry: FileEntry) {
    if (isProvisioning || !activeServer) return;
    if (!window.confirm(`Delete ${entry.name}? This cannot be undone.`)) return;
    setNotice("");
    try {
      await api(`/api/servers/${activeServer.id}/file?path=${encodeURIComponent(entry.path)}`, {
        method: "DELETE"
      });
      if (selectedPath === entry.path) {
        setSelectedPath("");
        setEditorText("");
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
    if (isProvisioning) return;
    if (!activeServer) return;
    setNotice("");
    try {
      await api(`/api/servers/${activeServer.id}/file`, {
        method: "PUT",
        body: JSON.stringify({ path: selectedPath, content: editorText })
      });
      setDirty(false);
      setNotice(`Saved ${selectedPath}`);
      notify("success", `Saved ${selectedPath}`);
      await loadFiles(activeServer.id, listing.path);
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function searchMods(event: FormEvent) {
    event.preventDefault();
    if (isProvisioning) return;
    if (!activeServer) return;
    setNotice("");
    try {
      const result = await api<{ hits: ModrinthHit[] }>(
        `/api/modrinth/search?query=${encodeURIComponent(query)}&serverId=${encodeURIComponent(activeServer.id)}`
      );
      setModSearchResults(result.hits);
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function uploadMod(event: ChangeEvent<HTMLInputElement>) {
    if (modsLocked || !activeServer) return;
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.name.endsWith(".jar")) {
      notify("error", "Only .jar mod files can be uploaded");
      return;
    }
    setNotice("");
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
    }
  }

  async function installMod(projectId: string, title: string) {
    if (modsLocked) return;
    if (!activeServer) return;
    setNotice("");
    try {
      const result = await api<{ filename: string; version: string }>("/api/modrinth/install", {
        method: "POST",
        body: JSON.stringify({ serverId: activeServer.id, projectId })
      });
      setNotice(`Installed ${title} ${result.version} as ${result.filename}`);
      notify("success", `Installed ${title}`);
      setModsView("manager");
      await loadInstalledMods(activeServer.id);
      await loadFiles(activeServer.id, "/mods");
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
  }

  async function setInstalledModEnabled(mod: InstalledMod, enabled: boolean) {
    if (modsLocked || !activeServer) return;
    setNotice("");
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
    if (modsLocked || !activeServer) return;
    setNotice("");
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
    if (isProvisioning || !activeServer) return;
    setNotice("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
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
    if (isProvisioning || !activeServer) return;
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
    if (isProvisioning || !activeServer) return;
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
    if (isProvisioning) return;
    if (!activeServer) return;
    setNotice("");
    const form = new FormData(event.currentTarget);
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
      setActiveTab("overview");
      setActivePage("servers");
      await refreshApp();
    } catch (error) {
      setNotice((error as Error).message);
      notify("error", (error as Error).message);
    }
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
              <p>Fabric server control</p>
            </div>
          </div>
          <button className="iconButton" onClick={() => setSidebarCollapsed((value) => !value)} aria-label="Toggle sidebar" disabled={isProvisioning}>
            <SidebarToggleIcon collapsed={sidebarCollapsed} />
          </button>
        </div>
        <nav className="sideNav">
          <button className={activePage === "servers" || activePage === "create" ? "active" : ""} onClick={() => setActivePage("servers")} disabled={isProvisioning}>
            <SidebarIcon name="servers" />
            <span>Servers</span>
          </button>
        </nav>
        <nav className="sideNav sideNavBottom">
          <button className={activePage === "settings" ? "active" : ""} onClick={() => setActivePage("settings")} disabled={isProvisioning}>
            <SidebarIcon name="settings" />
            <span>Settings</span>
          </button>
        </nav>
      </aside>

      <section className="workspace">
        <header className="workspaceHeader">
          <div>
            <h2>
              {activePage === "servers" && "Servers"}
              {activePage === "create" && "New Server"}
              {activePage === "server" && (activeServer?.displayName ?? "No Server Selected")}
              {activePage === "settings" && "Settings"}
            </h2>
            <p>
              {activePage === "servers" && "Create, select, and review managed Fabric servers."}
              {activePage === "create" && "Configure and launch a new Fabric server container."}
              {activePage === "server" && (activeServer ? "Monitor runtime, logs, files, and mods." : "Create a server to begin.")}
              {activePage === "settings" && "App-wide preferences and integrations."}
            </p>
          </div>
          <div className="workspaceActions">
            {activePage === "servers" && <button onClick={() => setActivePage("create")} disabled={isProvisioning}>New server</button>}
            {activePage === "create" && <button onClick={() => setActivePage("servers")} disabled={isProvisioning}>Cancel</button>}
            {activePage === "server" && activeServer && <button onClick={() => refreshStatus()} disabled={isProvisioning}>Refresh</button>}
          </div>
        </header>

        {provisionJob && (
          <ProvisionProgress job={provisionJob} />
        )}

        {!appState.dockerSocketMounted && (
          <section className="systemBanner warning">
            <strong>Docker integration is not connected.</strong>
            <span>Server files, editing, and configured integrations still work. Container creation, status, controls, Docker logs, and console input are limited until the Docker socket is mounted.</span>
          </section>
        )}

        {notice && <div className="notice">{notice}</div>}

        {activePage === "servers" && (
          <section className="pageStack">
            {appState.servers.length > 0 ? (
              <section className="serverList">
                {appState.servers.map((server) => (
                  <button
                    key={server.id}
                    className={`serverListItem ${server.id === activeServer?.id ? "active" : ""}`}
                    disabled={isProvisioning}
                    onClick={() => {
                      setActiveServerId(server.id);
                      setActivePage("server");
                    }}
                  >
                    <strong>{server.displayName}</strong>
                    <span>{server.minecraftVersion || "Version unknown"} · Fabric</span>
                  </button>
                ))}
              </section>
            ) : (
              <div className="emptyState">
                <h2>No Servers Yet</h2>
                <p>Create a Fabric server to start managing files, mods, and runtime control.</p>
                <button onClick={() => setActivePage("create")} disabled={isProvisioning}>Create Server</button>
              </div>
            )}
          </section>
        )}

        {activePage === "create" && (
          <section className="panel attachPanel">
            <AttachForm
              onSubmit={attachServer}
              dockerSocketMounted={appState.dockerSocketMounted}
              versions={fabricVersions}
              totalMemory={appState.totalMemory}
              provisioning={isProvisioning}
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
                  <p>Display preferences for this browser.</p>
                </div>
              </div>
              <label className="settingsRow">
                <div>
                  <strong>Theme</strong>
                  <span>Choose a fixed theme or follow your operating system.</span>
                </div>
                <select value={themePreference} onChange={(event) => setThemePreference(event.target.value as ThemePreference)}>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                  <option value="system">System</option>
                </select>
              </label>
            </section>

            <section className="panel settingsGroup">
              <div className="settingsGroupHeader">
                <span>02</span>
                <div>
                  <h2>Integrations</h2>
                  <p>External services used by optional server tools.</p>
                </div>
              </div>
              <div className="settingsRow">
                <div>
                  <strong>Modrinth API key</strong>
                  <span>{appState.modrinthApiConfigured ? "Configured. Enter a new key to replace it." : "Required for mod search and installation."}</span>
                </div>
                <ModrinthKeyForm onSubmit={updateModrinthKey} configured={appState.modrinthApiConfigured} />
              </div>
            </section>

            <section className="panel settingsGroup">
              <div className="settingsGroupHeader">
                <span>03</span>
                <div>
                  <h2>Container</h2>
                  <p>Host-level capabilities available to ServerSentinel.</p>
                </div>
              </div>
              <div className="settingsRow readOnly">
                <div>
                  <strong>Docker socket</strong>
                  <span>Enables runtime creation, container status, controls, Docker logs, and console input.</span>
                </div>
                <span className={`settingsStatus ${appState.dockerSocketMounted ? "ready" : "limited"}`}>
                  {appState.dockerSocketMounted ? "Connected" : "Not mounted"}
                </span>
              </div>
            </section>
          </section>
        )}

        {activePage === "server" && !activeServer && (
          <section className="emptyState">
            <h2>No Server Selected</h2>
            <p>Create or select a server from the Servers page.</p>
            <button onClick={() => setActivePage("servers")}>Open Servers</button>
          </section>
        )}

        {activePage === "server" && activeServer && (
          <>
            <div className="activeServerStrip">
              <div>
                <strong>{activeServer.displayName}</strong>
                <span>{activeServer.minecraftVersion || "Version unknown"} · Fabric</span>
              </div>
              <div className="activeServerRuntime">
                <span className={`runtimeBadge ${runtimeTone(status, appState.dockerSocketMounted)}`}>
                  {runtimeLabel(status, appState.dockerSocketMounted)}
                </span>
                <RuntimeControls
                  status={status}
                  isProvisioning={isProvisioning}
                  busyAction={runtimeAction}
                  onAction={runContainerAction}
                />
              </div>
            </div>

            <nav className="tabs">
              <button className={activeTab === "overview" ? "active" : ""} onClick={() => setActiveTab("overview")} disabled={isProvisioning}>Overview</button>
              <button className={activeTab === "files" ? "active" : ""} onClick={() => setActiveTab("files")} disabled={isProvisioning}>Files</button>
              <button className={activeTab === "mods" ? "active" : ""} onClick={() => setActiveTab("mods")} disabled={isProvisioning}>Mods</button>
              <button className={activeTab === "schedule" ? "active" : ""} onClick={() => setActiveTab("schedule")} disabled={isProvisioning}>Scheduling</button>
              <button className={activeTab === "settings" ? "active" : ""} onClick={() => setActiveTab("settings")} disabled={isProvisioning}>Server Settings</button>
            </nav>

            {activeTab === "overview" && (
              <section className="tabPage overviewPage">
                <section className="panel controls">
                  <div className="panelHeader">
                    <h2>Server Overview</h2>
                    <span className={`runtimeBadge ${runtimeTone(status, appState.dockerSocketMounted)}`}>
                      {runtimeLabel(status, appState.dockerSocketMounted)}
                    </span>
                  </div>
                  <div className="serverSummary">
                    <div className="summaryTile">
                      <span>State</span>
                      <strong>{status?.docker.running ? "Running" : status?.docker.state === "unknown" ? "Unknown" : "Stopped"}</strong>
                    </div>
                    <div className="summaryTile">
                      <span>Minecraft</span>
                      <strong>{activeServer.minecraftVersion || "Unknown"}</strong>
                    </div>
                    <div className="summaryTile">
                      <span>Fabric loader</span>
                      <strong>{activeServer.loaderVersion || "Latest stable"}</strong>
                    </div>
                    <div className="summaryTile">
                      <span>Container</span>
                      <strong>{status?.docker.state && status.docker.state !== "unknown" ? status.docker.state : status?.controlAvailable ? "Ready" : "Unavailable"}</strong>
                    </div>
                  </div>
                </section>

                <ResourcePanel server={activeServer} samples={resourceSamples} status={status} dockerSocketMounted={appState.dockerSocketMounted} />

                <section className="panel consolePanel">
                  <div className="panelHeader">
                    <h2>Console</h2>
                    <span className="muted">{status?.commandInputAvailable ? "Command input enabled" : status?.commandInputMessage}</span>
                  </div>
                  <div className="terminal">
                    <div className="console" ref={consoleRef}>
                      {logs.length ? logs.map((line, index) => <pre key={index}>{line}</pre>) : <span className="terminalMuted">No log output yet.</span>}
                    </div>
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
                          disabled={isProvisioning || !status?.commandInputAvailable}
                          spellCheck={false}
                          autoComplete="off"
                        />
                        {commandInputFocused && status?.commandInputAvailable && commandSuggestions.length > 0 && (
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
                      <button disabled={isProvisioning || !status?.commandInputAvailable || !commandInput.trim()}>Send</button>
                    </form>
                  </div>
                  <p className="muted">
                    {status?.docker.configured && appState.dockerSocketMounted
                      ? "Streaming Docker container logs."
                      : "Waiting for server log output."}
                  </p>
                </section>
              </section>
            )}

            {activeTab === "files" && (
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
                          disabled={isProvisioning || (entry.type === "file" && !isEditableFile(entry))}
                        >
                          <span>{entry.type === "directory" ? "[dir]" : "[file]"} {entry.name}</span>
                          <small>{entry.type === "file" ? formatBytes(entry.size) : ""}</small>
                        </button>
                        <button className="iconDangerButton" onClick={() => deleteFileEntry(entry)} disabled={isProvisioning} title={`Delete ${entry.name}`}>X</button>
                      </article>
                    ))}
                  </div>
                </section>

                <section className="panel editorPanel">
                  <div className="panelHeader">
                    <h2>Editor</h2>
                    <code>{selectedPath || "No file selected"}</code>
                  </div>
                  <textarea value={editorText} onChange={(event) => { setEditorText(event.target.value); setDirty(true); }} disabled={isProvisioning || !selectedPath} spellCheck={false} />
                  <div className="buttonRow">
                    <button onClick={saveFile} disabled={isProvisioning || !selectedPath || !dirty}>Save</button>
                    <span className="muted">Text files up to 2 MiB are supported. Binary editing is intentionally blocked.</span>
                  </div>
                </section>
              </section>
            )}

            {activeTab === "mods" && (
              <section className="tabPage">
                <section className="panel modsPanel">
                  <div className="panelHeader">
                    <h2>Mods</h2>
                    <span className={modsLocked ? "warn" : "ok"}>
                      {!status ? "Checking server state" : status.docker.running ? "Stop server to edit mods" : "Mod changes enabled"}
                    </span>
                  </div>
                  {!appState.modrinthApiConfigured && (
                    <section className="systemBanner accent">
                      <strong>Modrinth API key is not configured.</strong>
                      <span>Installed mod management still works. Add a key in Settings to search and install new mods.</span>
                    </section>
                  )}
                  <div className="modsToolbar">
                    <div className="segmentedControl">
                      <button className={modsView === "manager" ? "active" : ""} onClick={() => setModsView("manager")}>Installed</button>
                      <button className={modsView === "search" ? "active" : ""} onClick={() => setModsView("search")} disabled={!appState.modrinthApiConfigured}>Search</button>
                    </div>
                    <input ref={modUploadRef} className="hiddenInput" type="file" accept=".jar" onChange={uploadMod} />
                    <button onClick={() => modUploadRef.current?.click()} disabled={modsLocked}>Upload</button>
                    <span className="muted">Fabric {activeServer.loaderVersion || "loader unknown"} - Minecraft {activeServer.minecraftVersion || "version unknown"}</span>
                  </div>

                  {modsView === "manager" && (
                    <div className="mods">
                      <button className="modRow addModRow" onClick={() => setModsView("search")} disabled={isProvisioning || !appState.modrinthApiConfigured}>
                        <span className="addIcon">+</span>
                        <div>
                          <strong>Add mod</strong>
                          <p>Search Modrinth for Fabric mods compatible with this server.</p>
                        </div>
                      </button>
                      {installedMods.length === 0 && (
                        <div className="emptyInline">No installed mods yet.</div>
                      )}
                      {installedMods.map((mod) => (
                        <article key={mod.filename} className={`modRow ${mod.enabled ? "" : "disabled"}`}>
                          {mod.iconUrl ? <img src={mod.iconUrl} alt="" /> : <div className="modFileIcon">JAR</div>}
                          <div>
                            <strong>{mod.displayName}</strong>
                            <p>{mod.enabled ? "Enabled" : "Disabled"} - {formatBytes(mod.size)} - Modified {new Date(mod.modifiedAt).toLocaleString()}</p>
                            <small>{mod.filename}</small>
                          </div>
                          <div className="modActions">
                            <button onClick={() => setInstalledModEnabled(mod, !mod.enabled)} disabled={modsLocked}>
                              {mod.enabled ? "Disable" : "Enable"}
                            </button>
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
                        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search compatible Fabric mods" disabled={isProvisioning || !appState.modrinthApiConfigured} />
                        <button disabled={isProvisioning || !appState.modrinthApiConfigured || !query.trim()}>Refresh</button>
                      </form>
                      <div className="mods">
                        {modSearchResults.map((mod) => (
                          <article key={mod.project_id} className="modRow">
                            {mod.icon_url ? <img src={mod.icon_url} alt="" /> : <div className="modFileIcon">MOD</div>}
                            <div>
                              <strong>{mod.title}</strong>
                              <p>{mod.description}</p>
                              <small>{mod.downloads.toLocaleString()} downloads</small>
                            </div>
                            <button onClick={() => installMod(mod.project_id, mod.title)} disabled={modsLocked || !appState.modrinthApiConfigured}>Install</button>
                          </article>
                        ))}
                      </div>
                    </>
                  )}
                </section>
              </section>
            )}

            {activeTab === "schedule" && (
              <SchedulePage
                schedules={activeServer.schedules ?? []}
                onCreate={createSchedule}
                onToggle={(schedule) => updateSchedule(schedule, { enabled: !schedule.enabled })}
                onDelete={deleteSchedule}
                disabled={isProvisioning}
                commandInputMessage={status?.commandInputAvailable ? "" : status?.commandInputMessage || "Scheduled commands need Docker command input when they run."}
              />
            )}

            {activeTab === "settings" && (
              <section className="tabPage settingsPage">
                <section className="panel settingsPanel">
                  <h2>Server Settings</h2>
                  <dl className="meta">
                    <dt>Server type</dt>
                    <dd>Fabric</dd>
                    <dt>Jar metadata</dt>
                    <dd>{activeServer.serverJar || "Not set"}</dd>
                    <dt>Storage</dt>
                    <dd>{activeServer.storageName || "Not set"}</dd>
                    <dt>Ports</dt>
                    <dd>{activeServer.dockerPorts || "25565:25565/tcp"}</dd>
                    <dt>Log file</dt>
                    <dd>{status?.fileLogsAvailable ? "Available" : "Not found"}</dd>
                    <dt>Control</dt>
                    <dd>{status?.controlAvailable ? "Docker container control enabled" : "Not configured"}</dd>
                  </dl>
                  <ServerEditForm server={activeServer} versions={fabricVersions} totalMemory={appState.totalMemory} onSubmit={updateServer} disabled={isProvisioning} />
                </section>
                <DeleteServerPanel server={activeServer} onSubmit={deleteServer} disabled={isProvisioning} />
              </section>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function Notifications({ notices }: { notices: Notice[] }) {
  return (
    <div className="toastRegion">
      {notices.map((notice) => (
        <div key={notice.id} className={`toast ${notice.type}`}>{notice.text}</div>
      ))}
    </div>
  );
}

function ControlIcon({ action }: { action: "start" | "stop" | "restart" }) {
  if (action === "start") {
    return <span className="controlGlyph play" aria-hidden="true" />;
  }
  if (action === "stop") {
    return <span className="controlGlyph stop" aria-hidden="true" />;
  }
  return <span className="controlGlyph restart" aria-hidden="true" />;
}

function RuntimeControls({
  status,
  isProvisioning,
  busyAction,
  onAction
}: {
  status: ServerStatus | null;
  isProvisioning: boolean;
  busyAction: "start" | "stop" | "restart" | null;
  onAction: (action: "start" | "stop" | "restart") => void;
}) {
  const disabled = isProvisioning || Boolean(busyAction) || !status?.controlAvailable;
  return (
    <div className="runtimeControls" aria-label="Container controls">
      {(["start", "stop", "restart"] as const).map((action) => {
        const actionDisabled = disabled
          || (action === "start" && Boolean(status?.docker.running))
          || (action === "stop" && !status?.docker.running);
        return (
          <button
            key={action}
            type="button"
            className={`runtimeControlButton ${action}`}
            onClick={() => onAction(action)}
            disabled={actionDisabled}
          >
            {busyAction === action ? <span className="buttonSpinner" aria-hidden="true" /> : <ControlIcon action={action} />}
            <span>{action}</span>
          </button>
        );
      })}
    </div>
  );
}

function ResourcePanel({
  server,
  samples,
  status,
  dockerSocketMounted
}: {
  server: AttachedServer;
  samples: ResourceSample[];
  status: ServerStatus | null;
  dockerSocketMounted: boolean;
}) {
  const latest = samples.at(-1);
  const cpu = latest?.cpuPercent ?? 0;
  const memoryUsage = latest?.memoryUsageBytes ?? 0;
  const configuredMemoryBytes = parseMaxMemoryGb(server.javaArgs) * 1024 * 1024 * 1024;
  const memoryPercent = configuredMemoryBytes ? Math.round((memoryUsage / configuredMemoryBytes) * 100) : 0;
  const sampleAge = latest ? Math.max(0, Math.round((Date.now() - latest.sampledAt) / 1000)) : null;
  const statusMessage = latest?.message
    || (!dockerSocketMounted
      ? "Docker socket is not mounted, so live container stats are unavailable."
      : status?.docker.running
        ? "Collecting Docker stats."
        : status?.docker.message || "Start the container to collect live stats.");

  return (
    <section className="panel resourcePanel">
      <div className="panelHeader">
        <h2>Resource Usage</h2>
        <span className="muted">{latest?.running ? "Live Docker stats" : "Waiting for running container"}</span>
      </div>
      <div className="resourceStats">
        <div className="resourceMetric">
          <span>Memory</span>
          <strong>{formatMegabytes(memoryUsage)} / {formatMegabytes(configuredMemoryBytes)}</strong>
          <small>{memoryPercent}% of configured allocation</small>
        </div>
        <div className="resourceMetric">
          <span>CPU</span>
          <strong>{cpu.toFixed(1)}%</strong>
          <small>{latest?.available ? "Docker container usage" : "Waiting for Docker stats"}</small>
        </div>
      </div>
      <div className="resourceMeta">
        <span>Container allocation from {server.javaArgs?.match(/-Xmx\S+/)?.[0] || `-Xmx${parseMaxMemoryGb(server.javaArgs)}G`}</span>
        <span>{sampleAge === null ? "Not sampled yet" : `Last sample ${sampleAge}s ago`}</span>
      </div>
      {!latest?.available && <p className="resourceMessage">{statusMessage}</p>}
    </section>
  );
}

function ProvisionProgress({ job }: { job: ProvisionJob }) {
  return (
    <section className={`provisionPanel ${job.status}`}>
      <div>
        <strong>{job.status === "failed" ? "Setup stopped" : job.status === "succeeded" ? "Setup complete" : "Setting up server"}</strong>
        <span>{job.error || job.task}</span>
      </div>
      <div className="progressTrack" aria-label="Server setup progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress} role="progressbar">
        <span style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} />
      </div>
      <small>{Math.round(job.progress)}%</small>
    </section>
  );
}

function ModrinthKeyForm({
  onSubmit,
  configured
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  configured: boolean;
}) {
  return (
    <form onSubmit={onSubmit} className="keyForm">
      <label>
        Modrinth API key
        <input name="modrinthApiKey" type="password" placeholder={configured ? "Configured - enter a new key to replace" : "Paste API key"} required />
      </label>
      <button>Save key</button>
    </form>
  );
}

function SchedulePage({
  schedules,
  onCreate,
  onToggle,
  onDelete,
  disabled,
  commandInputMessage
}: {
  schedules: ScheduledExecution[];
  onCreate: (event: FormEvent<HTMLFormElement>) => void;
  onToggle: (schedule: ScheduledExecution) => void;
  onDelete: (schedule: ScheduledExecution) => void;
  disabled: boolean;
  commandInputMessage: string;
}) {
  const [commandIds, setCommandIds] = useState(() => [clientId()]);

  return (
    <section className="tabPage schedulePage">
      <section className="panel scheduleCreatePanel">
        <div className="panelHeader">
          <h2>New Scheduled Execution</h2>
          <a href="https://crontab.guru/" target="_blank" rel="noreferrer">Cron Guru</a>
        </div>
        {commandInputMessage && (
          <section className="systemBanner warning compactBanner">
            <strong>Scheduling is limited.</strong>
            <span>{commandInputMessage}</span>
          </section>
        )}
        <form onSubmit={onCreate} className="attachForm scheduleForm">
          <fieldset disabled={disabled}>
            <label>
              Name
              <input name="name" placeholder="Nightly maintenance" required />
            </label>
            <label>
              Cron schedule
              <input name="cron" placeholder="0 4 * * *" required />
            </label>
            <div className="commandStack">
              <span className="fieldLabel">Commands</span>
              {commandIds.map((id, index) => (
                <div key={id} className="commandInputRow">
                  <input name="commands" placeholder={index === 0 ? "say Restarting in 5 minutes" : "save-all"} required={index === 0} />
                  {index > 0 && (
                    <button
                      type="button"
                      className="iconDangerButton"
                      onClick={() => setCommandIds((ids) => ids.filter((candidate) => candidate !== id))}
                      aria-label="Remove command"
                    >
                      X
                    </button>
                  )}
                </div>
              ))}
              <button type="button" className="secondaryButton" onClick={() => setCommandIds((ids) => [...ids, clientId()])}>
                + Additional Command
              </button>
            </div>
            <label className="checkLine">
              <input name="onlyWhenNoPlayers" type="checkbox" />
              Only run when no players are online
            </label>
            <label className="checkLine">
              <input name="enabled" type="checkbox" defaultChecked />
              Enabled
            </label>
            <button>Create scheduled execution</button>
          </fieldset>
        </form>
      </section>

      <section className="panel scheduleListPanel">
        <div className="panelHeader">
          <h2>Scheduled Executions</h2>
          <span className="muted">{schedules.length} configured</span>
        </div>
        <div className="scheduleList">
          {schedules.length ? schedules.map((schedule) => (
            <article key={schedule.id} className={`scheduleRow ${schedule.enabled ? "enabled" : "disabled"}`}>
              <div className="scheduleMain">
                <div>
                  <strong>{schedule.name}</strong>
                  <code>{schedule.cron}</code>
                </div>
                <span className={`runtimeBadge ${schedule.enabled ? "running" : "neutral"}`}>
                  {schedule.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              <ul>
                {schedule.commands.map((command, index) => <li key={`${command}-${index}`}>{command}</li>)}
              </ul>
              <div className="scheduleMeta">
                <span>{schedule.onlyWhenNoPlayers ? "Runs only with no players online" : "Runs regardless of player count"}</span>
                <span>{schedule.lastRunAt ? `Last ${schedule.lastStatus}: ${schedule.lastMessage || "No message"}` : "Never run"}</span>
              </div>
              <div className="buttonRow">
                <button type="button" onClick={() => onToggle(schedule)} disabled={disabled}>
                  {schedule.enabled ? "Disable" : "Enable"}
                </button>
                <button type="button" className="dangerButton" onClick={() => onDelete(schedule)} disabled={disabled}>
                  Delete
                </button>
              </div>
            </article>
          )) : (
            <div className="emptyState compactEmpty">
              <h2>No Schedules</h2>
              <p>Create one scheduled execution with one or more console commands.</p>
            </div>
          )}
        </div>
      </section>
    </section>
  );
}

function MemorySelector({
  totalMemory,
  initialMemoryGb = 4,
  javaArgs,
  onJavaArgsChange
}: {
  totalMemory: number;
  initialMemoryGb?: number;
  javaArgs: string;
  onJavaArgsChange: (value: string) => void;
}) {
  const totalRamGb = totalMemoryGb(totalMemory);
  const [memoryGb, setMemoryGb] = useState(() => Math.min(Math.max(1, initialMemoryGb), totalRamGb));

  useEffect(() => {
    setMemoryGb((current) => Math.min(Math.max(1, current), totalRamGb));
  }, [totalRamGb]);

  function updateMemory(value: number) {
    if (!Number.isFinite(value)) return;
    const nextMemoryGb = Math.min(Math.max(1, Math.round(value)), totalRamGb);
    setMemoryGb(nextMemoryGb);
    onJavaArgsChange(replaceMemoryArgs(javaArgs, nextMemoryGb));
  }

  return (
    <div className="memorySelector">
      <div className="memorySelectorHeader">
        <label htmlFor="memoryGb">Memory</label>
        <span className="totalRamLabel">Machine RAM: {totalRamGb} GB total</span>
      </div>
      <div className="memorySelectorControls">
        <input
          id="memoryGb"
          type="range"
          min="1"
          max={totalRamGb}
          value={memoryGb}
          onChange={(event) => updateMemory(Number(event.target.value))}
          className="memorySlider"
        />
        <div className="memoryInputWrap">
          <input
            type="number"
            min="1"
            max={totalRamGb}
            value={memoryGb}
            onChange={(event) => updateMemory(Number(event.target.value))}
            className="memoryNumberInput"
          />
          <span className="unit">GB</span>
        </div>
      </div>
      <p className="safelyAllocateTip">
        {memoryGb > totalRamGb * 0.8 ? (
          <span className="warn">Allocating over 80% of RAM may cause host instability.</span>
        ) : (
          <span className="ok">Safe allocation level for this host.</span>
        )}
      </p>
    </div>
  );
}

function ServerEditForm({
  server,
  versions,
  totalMemory,
  onSubmit,
  disabled = false
}: {
  server: AttachedServer;
  versions: FabricVersions;
  totalMemory: number;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  disabled?: boolean;
}) {
  const [javaArgs, setJavaArgs] = useState(server.javaArgs || memoryArgs(parseMaxMemoryGb(server.javaArgs)));

  return (
    <form onSubmit={onSubmit} className="attachForm">
      <fieldset disabled={disabled}>
      <label>
        Display name
        <input name="displayName" defaultValue={server.displayName} required />
      </label>
      <label>
        Minecraft version
        <select name="minecraftVersion" defaultValue={server.minecraftVersion}>
          {versions.game.length ? versions.game.map((version) => (
            <option key={version.version} value={version.version}>{version.version}</option>
          )) : <option value={server.minecraftVersion}>{server.minecraftVersion}</option>}
        </select>
      </label>
      <label>
        Fabric loader version
        <select name="loaderVersion" defaultValue={server.loaderVersion ?? ""}>
          <option value="">Latest stable</option>
          {versions.loader.map((version) => (
            <option key={version.version} value={version.version}>{version.version}</option>
          ))}
        </select>
      </label>
      <label>
        Fabric installer version
        <select name="installerVersion" defaultValue={server.installerVersion ?? ""}>
          <option value="">Latest stable</option>
          {versions.installer.map((version) => (
            <option key={version.version} value={version.version}>{version.version}</option>
          ))}
        </select>
      </label>
      <MemorySelector
        totalMemory={totalMemory}
        initialMemoryGb={parseMaxMemoryGb(javaArgs)}
        javaArgs={javaArgs}
        onJavaArgsChange={setJavaArgs}
      />
      <label>
        Java arguments
        <textarea
          className="javaArgsInput"
          name="javaArgs"
          value={javaArgs}
          onChange={(event) => setJavaArgs(event.target.value)}
          rows={4}
          spellCheck={false}
        />
      </label>
      <label>
        Docker runtime image
        <select name="dockerImage" defaultValue={server.dockerImage || "eclipse-temurin:21-jre"}>
          <option value="eclipse-temurin:21-jre">Java 21 runtime</option>
          <option value="eclipse-temurin:17-jre">Java 17 runtime</option>
          <option value="eclipse-temurin:25-jre">Java 25 runtime</option>
        </select>
      </label>
      <label>
        Server jar filename
        <input name="serverJar" defaultValue={server.serverJar || "fabric-server-launch.jar"} />
      </label>
      <label>
        Docker container name
        <input name="dockerContainer" defaultValue={server.dockerContainer || ""} />
      </label>
      <label>
        Port bindings
        <input name="dockerPorts" defaultValue={server.dockerPorts || "25565:25565/tcp"} />
      </label>
      <button>Save server settings</button>
      </fieldset>
    </form>
  );
}

function DeleteServerPanel({
  server,
  onSubmit,
  disabled = false
}: {
  server: AttachedServer;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  disabled?: boolean;
}) {
  return (
    <section className="panel dangerPanel">
      <h2>Delete Server</h2>
      <p className="muted">This removes the server from ServerSentinel. File deletion is optional and cannot be undone.</p>
      <form onSubmit={onSubmit} className="attachForm">
        <fieldset disabled={disabled}>
        <label>
          Type server name to confirm
          <input name="confirmName" placeholder={server.displayName} required />
        </label>
        <label className="checkLine dangerCheck">
          <input name="deleteFiles" type="checkbox" />
          Also delete this server's files from disk
        </label>
        <button className="dangerButton">Delete Server</button>
        </fieldset>
      </form>
    </section>
  );
}

function AttachForm({
  onSubmit,
  dockerSocketMounted,
  versions,
  totalMemory = 0,
  provisioning = false
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  dockerSocketMounted: boolean;
  versions: FabricVersions;
  totalMemory?: number;
  provisioning?: boolean;
}) {
  const runtimeImages = [
    { value: "eclipse-temurin:21-jre", label: "Java 21 runtime (recommended)" },
    { value: "eclipse-temurin:17-jre", label: "Java 17 runtime" },
    { value: "eclipse-temurin:25-jre", label: "Java 25 runtime" }
  ];
  const defaultMinecraftVersion = versions.game[0]?.version ?? "1.21.4";
  const [minecraftVersion, setMinecraftVersion] = useState(defaultMinecraftVersion);
  const [dockerImage, setDockerImage] = useState(defaultDockerImageForMinecraftVersion(defaultMinecraftVersion));
  const [serverPort, setServerPort] = useState(String(defaultServerPort));
  const [javaArgs, setJavaArgs] = useState(memoryArgs(4));
  const serverPortValid = isValidServerPort(serverPort);

  useEffect(() => {
    const nextVersion = versions.game[0]?.version;
    if (!nextVersion) return;
    setMinecraftVersion((current) => current === "1.21.4" ? nextVersion : current || nextVersion);
    setDockerImage(defaultDockerImageForMinecraftVersion(nextVersion));
  }, [versions.game]);

  return (
    <form onSubmit={onSubmit} className="attachForm">
      <fieldset disabled={provisioning}>
      <label>
        Display name
        <input name="displayName" placeholder="Survival" required />
      </label>
      <label>
        Minecraft version
        <select
          name="minecraftVersion"
          required
          value={minecraftVersion}
          onChange={(event) => {
            setMinecraftVersion(event.target.value);
            setDockerImage(defaultDockerImageForMinecraftVersion(event.target.value));
          }}
        >
          {versions.game.length ? versions.game.map((version) => (
            <option key={version.version} value={version.version}>{version.version}</option>
          )) : <option value="1.21.4">1.21.4</option>}
        </select>
      </label>
      <label>
        Server port
        <input
          name="serverPort"
          type="number"
          min={minServerPort}
          max={maxServerPort}
          value={serverPort}
          onChange={(event) => setServerPort(event.target.value)}
          aria-invalid={!serverPortValid}
          required
        />
        {!serverPortValid && (
          <span className="fieldError">Use a port from {minServerPort} to {maxServerPort}.</span>
        )}
      </label>
      <label className="checkLine">
        <input name="acceptEula" type="checkbox" required />
        I accept the Minecraft EULA for this server.
      </label>
      <details className="advanced">
        <summary>Advanced settings</summary>
        <MemorySelector
          totalMemory={totalMemory}
          initialMemoryGb={parseMaxMemoryGb(javaArgs)}
          javaArgs={javaArgs}
          onJavaArgsChange={setJavaArgs}
        />
        <label>
          Java arguments
          <textarea
            className="javaArgsInput"
            name="javaArgs"
            value={javaArgs}
            onChange={(event) => setJavaArgs(event.target.value)}
            rows={4}
            spellCheck={false}
          />
        </label>
        <label>
          Fabric loader version
          <select name="loaderVersion" defaultValue="">
            <option value="">Latest stable</option>
            {versions.loader.map((version) => (
              <option key={version.version} value={version.version}>{version.version}</option>
            ))}
          </select>
        </label>
        <label>
          Fabric installer version
          <select name="installerVersion" defaultValue="">
            <option value="">Latest stable</option>
            {versions.installer.map((version) => (
              <option key={version.version} value={version.version}>{version.version}</option>
            ))}
          </select>
        </label>
        <label>
          Server jar filename
          <input name="serverJar" placeholder="fabric-server-launch.jar" />
        </label>
        <label>
          Docker container name
          <input name="dockerContainer" placeholder="serversentinel-survival" />
        </label>
        <label>
          Docker runtime image
          <select name="dockerImage" value={dockerImage} onChange={(event) => setDockerImage(event.target.value)}>
            {runtimeImages.map((image) => (
              <option key={image.value} value={image.value}>{image.label}</option>
            ))}
          </select>
        </label>
        <label>
          Port bindings
          <input name="dockerPorts" placeholder="25565:25565/tcp" />
        </label>
      </details>
      <p className="muted">
        Docker socket is {dockerSocketMounted ? "mounted; ServerSentinel can create/start a separate runtime container." : "not mounted; server files will be created, but runtime control needs Docker."}
      </p>
      <button disabled={!serverPortValid}>{provisioning ? "Setting up..." : "Create Server"}</button>
      </fieldset>
    </form>
  );
}
