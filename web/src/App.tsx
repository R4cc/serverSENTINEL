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

const appVersion = "0.1.0";
const demoServerId = "demo-survival";

const emptyApp: AppState = {
  servers: [],
  modrinthApiConfigured: false,
  dockerSocketMounted: false,
  totalMemory: 0
};

const demoStartedAt = Date.now();

const initialDemoSchedules: ScheduledExecution[] = [{
  id: "demo-schedule-backup",
  name: "Nightly backup",
  cron: "0 4 * * *",
  commands: ["save-all", "say Backup complete"],
  onlyWhenNoPlayers: true,
  enabled: true,
  createdAt: new Date(demoStartedAt - 86_400_000).toISOString(),
  updatedAt: new Date(demoStartedAt - 3_600_000).toISOString(),
  lastRunAt: new Date(demoStartedAt - 18_000_000).toISOString(),
  lastStatus: "succeeded",
  lastMessage: "Demo execution completed"
}];

const initialDemoMods: InstalledMod[] = [
  {
    filename: "fabric-api-demo.jar",
    displayName: "Fabric API",
    enabled: true,
    size: 2_840_576,
    modifiedAt: new Date(demoStartedAt - 172_800_000).toISOString()
  },
  {
    filename: "lithium-demo.jar",
    displayName: "Lithium",
    enabled: true,
    size: 734_208,
    modifiedAt: new Date(demoStartedAt - 86_400_000).toISOString()
  }
];

const demoSearchResults: ModrinthHit[] = [
  {
    project_id: "demo-sodium",
    title: "Sodium",
    description: "Client and server rendering performance mod shown here as demo data.",
    downloads: 42_500_000
  },
  {
    project_id: "demo-ferritecore",
    title: "FerriteCore",
    description: "Memory optimization mod included in the simulated Modrinth search.",
    downloads: 18_250_000
  },
  {
    project_id: "demo-clumps",
    title: "Clumps",
    description: "Groups XP orbs together to reduce server work in busy worlds.",
    downloads: 31_100_000
  }
];

const initialDemoFiles: Record<string, string> = {
  "/server.properties": [
    "motd=ServerSentinel Demo",
    "max-players=20",
    "view-distance=10",
    "simulation-distance=8",
    "online-mode=true"
  ].join("\n"),
  "/config/serversentinel-demo.toml": [
    "demo = true",
    "runtime = \"simulated\"",
    "docker_required = false"
  ].join("\n"),
  "/logs/latest.log": [
    "[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.4",
    "[12:00:03] [Server thread/INFO]: Preparing spawn area: 100%",
    "[12:00:05] [Server thread/INFO]: Done (5.132s)! For help, type \"help\""
  ].join("\n")
};

function demoServer(schedules: ScheduledExecution[] = initialDemoSchedules): AttachedServer {
  return {
    id: demoServerId,
    displayName: "Demo Survival",
    directoryLabel: "/demo/survival",
    storageName: "Browser demo",
    minecraftVersion: "1.21.4",
    loaderVersion: "0.16.10",
    installerVersion: "1.0.1",
    serverJar: "fabric-server-launch.jar",
    dockerContainer: "serversentinel-demo",
    dockerImage: "simulated-runtime",
    dockerPorts: "25565:25565/tcp",
    javaArgs: "-Xms2G -Xmx4G",
    schedules,
    serverType: "fabric",
    hasDockerContainer: true
  };
}

function demoStatus(server: AttachedServer, running: boolean): ServerStatus {
  return {
    server,
    docker: {
      configured: true,
      available: true,
      controllable: true,
      state: running ? "running" : "exited",
      running,
      container: "serversentinel-demo",
      message: "Demo mode simulates runtime control without Docker."
    },
    fileLogsAvailable: true,
    controlAvailable: true,
    commandInputAvailable: running,
    commandInputMessage: running ? "" : "Start the demo server to enable simulated console input."
  };
}

function demoStats(running: boolean): ResourceSample {
  const elapsed = (Date.now() - demoStartedAt) / 1000;
  const memoryLimitBytes = 4 * 1024 * 1024 * 1024;
  const memoryUsageBytes = running ? Math.round((1.35 + Math.sin(elapsed / 12) * 0.18) * 1024 * 1024 * 1024) : 0;
  return {
    available: true,
    running,
    cpuPercent: running ? 8 + Math.max(0, Math.sin(elapsed / 7)) * 22 : 0,
    memoryUsageBytes,
    memoryLimitBytes,
    readAt: new Date().toISOString(),
    container: "serversentinel-demo",
    message: running ? "Simulated runtime stats." : "Demo server is stopped.",
    sampledAt: Date.now()
  };
}

function demoListing(path: string, files: Record<string, string>, mods: InstalledMod[]): FileListing {
  if (path === "/mods") {
    return {
      path,
      entries: mods.map((mod) => ({
        name: mod.filename,
        path: `/mods/${mod.filename}`,
        type: "file",
        size: mod.size,
        modifiedAt: mod.modifiedAt
      }))
    };
  }
  if (path === "/config") {
    return {
      path,
      entries: [{
        name: "serversentinel-demo.toml",
        path: "/config/serversentinel-demo.toml",
        type: "file",
        size: files["/config/serversentinel-demo.toml"]?.length ?? 0,
        modifiedAt: new Date(demoStartedAt - 12_000_000).toISOString()
      }]
    };
  }
  if (path === "/logs") {
    return {
      path,
      entries: [{
        name: "latest.log",
        path: "/logs/latest.log",
        type: "file",
        size: files["/logs/latest.log"]?.length ?? 0,
        modifiedAt: new Date().toISOString()
      }]
    };
  }
  return {
    path: "/",
    entries: [
      { name: "config", path: "/config", type: "directory", size: 0, modifiedAt: new Date(demoStartedAt).toISOString() },
      { name: "logs", path: "/logs", type: "directory", size: 0, modifiedAt: new Date().toISOString() },
      { name: "mods", path: "/mods", type: "directory", size: 0, modifiedAt: new Date(demoStartedAt).toISOString() },
      {
        name: "server.properties",
        path: "/server.properties",
        type: "file",
        size: files["/server.properties"]?.length ?? 0,
        modifiedAt: new Date(demoStartedAt - 7_200_000).toISOString()
      }
    ]
  };
}

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

function fileIconKind(entry: FileEntry) {
  if (entry.type === "directory") return "folder";
  if (/\.jar$/i.test(entry.name)) return "jar";
  if (/\.(log|txt|md|csv|env)$/i.test(entry.name)) return "text";
  if (/\.(properties|json5?|ya?ml|toml|cfg|conf)$/i.test(entry.name)) return "config";
  return "file";
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
  if (status.docker.container === "serversentinel-demo") return status.docker.running ? "Demo server running" : "Demo server stopped";
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

function AppIcon({ name }: { name: "chevronLeft" | "chevronRight" | "plus" | "x" | "fileUp" }) {
  return (
    <svg className="buttonIcon" viewBox="0 0 24 24" aria-hidden="true">
      {name === "chevronLeft" && <path d="m15 5-7 7 7 7" />}
      {name === "chevronRight" && <path d="m9 5 7 7-7 7" />}
      {name === "plus" && (
        <>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </>
      )}
      {name === "x" && (
        <>
          <path d="m6 6 12 12" />
          <path d="m18 6-12 12" />
        </>
      )}
      {name === "fileUp" && (
        <>
          <path d="M7 3h7l4 4v14H7z" />
          <path d="M14 3v5h4" />
          <path d="M12 17V10" />
          <path d="m9 13 3-3 3 3" />
        </>
      )}
    </svg>
  );
}

function FileTypeIcon({ entry }: { entry: FileEntry }) {
  const kind = fileIconKind(entry);
  return (
    <span className={`fileTypeIcon ${kind}`} aria-hidden="true">
      <svg viewBox="0 0 24 24">
        {kind === "folder" && (
          <>
            <path d="M3 7.5h6l2 2h10v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            <path d="M3 7.5V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1.5" />
          </>
        )}
        {kind !== "folder" && (
          <>
            <path d="M6 3h8l4 4v14H6Z" />
            <path d="M14 3v5h4" />
          </>
        )}
        {kind === "jar" && (
          <>
            <path d="M9 12h6" />
            <path d="M9 15h6" />
            <path d="M10 18h4" />
          </>
        )}
        {kind === "text" && (
          <>
            <path d="M9 12h6" />
            <path d="M9 15h5" />
            <path d="M9 18h6" />
          </>
        )}
        {kind === "config" && (
          <>
            <circle cx="12" cy="15" r="2.5" />
            <path d="M12 11v-1.5" />
            <path d="M12 20.5V19" />
            <path d="M8.1 12.7 7 11.6" />
            <path d="m17 18.4-1.1-1.1" />
            <path d="m15.9 12.7 1.1-1.1" />
            <path d="M7 18.4 8.1 17.3" />
          </>
        )}
      </svg>
      {kind === "jar" && <span>JAR</span>}
    </span>
  );
}

function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return <AppIcon name={collapsed ? "chevronRight" : "chevronLeft"} />;
}

function readThemePreference(): ThemePreference {
  const saved = window.localStorage.getItem("serversentinel-theme");
  return saved === "dark" || saved === "system" || saved === "light" ? saved : "light";
}

function readDemoMode() {
  return window.localStorage.getItem("serversentinel-demo-mode") === "true";
}

export default function App() {
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
  const [isSearchingMods, setIsSearchingMods] = useState(false);
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
  const [demoMode, setDemoMode] = useState(() => readDemoMode());
  const [demoRunning, setDemoRunning] = useState(true);
  const [demoFiles, setDemoFiles] = useState<Record<string, string>>(() => initialDemoFiles);
  const [demoInstalledMods, setDemoInstalledMods] = useState<InstalledMod[]>(() => initialDemoMods);
  const [demoSchedules, setDemoSchedules] = useState<ScheduledExecution[]>(() => initialDemoSchedules);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const consoleRef = useRef<HTMLDivElement>(null);
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
  const serverSettingsLocked = isProvisioning || Boolean(status?.docker.running);
  const modsLocked = isProvisioning || !status || Boolean(status.docker.running);
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
    window.localStorage.setItem("serversentinel-demo-mode", String(demoMode));
    if (demoMode) {
      setNotice("");
      setActiveServerId(demoServerId);
      setActivePage("server");
      setActiveTab("overview");
    } else if (activeServerId === demoServerId) {
      setActiveServerId("");
      setActivePage("servers");
      setStatus(null);
      setLogs([]);
      setListing({ path: "/", entries: [] });
      setSelectedPath("");
      setEditorText("");
      setDirty(false);
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
    if (activeTab === "settings" && serverSettingsLocked) {
      setActiveTab("overview");
    }
  }, [activeTab, serverSettingsLocked]);

  useEffect(() => {
    window.localStorage.setItem("serversentinel-command-history", JSON.stringify(commandHistory.slice(-50)));
  }, [commandHistory]);

  useEffect(() => {
    if (!activeServer || activePage !== "server" || activeTab !== "overview") return;
    if (demoMode && activeServer.id === demoServerId) {
      setResourceSamples([demoStats(demoRunning)]);
      const interval = window.setInterval(() => setResourceSamples([demoStats(demoRunning)]), resourcePollMs);
      return () => window.clearInterval(interval);
    }
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
  }, [activeServer?.id, activePage, activeTab, demoMode, demoRunning]);

  useEffect(() => {
    if (!activeServer || activeTab !== "mods" || modsView !== "search" || !effectiveAppState.modrinthApiConfigured) return;
    const trimmedQuery = query.trim();
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
          `/api/modrinth/search?query=${encodeURIComponent(trimmedQuery)}&serverId=${encodeURIComponent(activeServer.id)}`
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
  }, [activeServer?.id, activeTab, effectiveAppState.modrinthApiConfigured, modsView, query, activeServerIsDemo]);

  function notify(type: Notice["type"], text: string) {
    const id = Date.now() + Math.random();
    setNotices((current) => [...current, { id, type, text }]);
    window.setTimeout(() => {
      setNotices((current) => current.filter((candidate) => candidate.id !== id));
    }, 5000);
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
    if (activeServerIsDemo) {
      notify("success", `Updated ${String(form.get("displayName") || activeServer.displayName)} in demo mode`);
      return;
    }
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
    if (isProvisioning || !activeServer) return;
    if (!window.confirm(`Delete ${entry.name}? This cannot be undone.`)) return;
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
    if (isProvisioning) return;
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

  async function installMod(projectId: string, title: string) {
    if (modsLocked) return;
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
    if (modsLocked || !activeServer) return;
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
    if (isProvisioning || !activeServer) return;
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
    if (isProvisioning || !activeServer) return;
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
    if (isProvisioning || !activeServer) return;
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
    if (isProvisioning) return;
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
          <span className="sidebarVersion">v{appVersion}</span>
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

        {!effectiveAppState.dockerSocketMounted && (
          <section className="systemBanner warning">
            <strong>Docker integration is not connected.</strong>
            <span>Server files, editing, and configured integrations still work. Container creation, status, controls, Docker logs, and console input are limited until the Docker socket is mounted.</span>
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
              dockerSocketMounted={effectiveAppState.dockerSocketMounted}
              versions={fabricVersions}
              totalMemory={effectiveAppState.totalMemory}
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
                  <strong>Demo mode</strong>
                </div>
                <span className="settingsToggle">
                  <input type="checkbox" checked={demoMode} onChange={(event) => setDemoMode(event.target.checked)} />
                  {demoMode ? "Enabled" : "Disabled"}
                </span>
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
                <ModrinthKeyForm onSubmit={updateModrinthKey} configured={appState.modrinthApiConfigured} />
              </div>
            </section>

            <section className="panel settingsGroup">
              <div className="settingsGroupHeader">
                <span>03</span>
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
                <span className={`runtimeBadge ${runtimeTone(status, effectiveAppState.dockerSocketMounted)}`}>
                  {runtimeLabel(status, effectiveAppState.dockerSocketMounted)}
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
              <button
                className={activeTab === "settings" ? "active" : ""}
                onClick={() => setActiveTab("settings")}
                disabled={serverSettingsLocked}
                title={status?.docker.running ? "Stop the server to edit settings" : undefined}
              >
                Server Settings
              </button>
            </nav>

            {activeTab === "overview" && (
              <section className="tabPage overviewPage">
                <section className="panel controls">
                  <div className="panelHeader">
                    <h2>Server Overview</h2>
                    <span className={`runtimeBadge ${runtimeTone(status, effectiveAppState.dockerSocketMounted)}`}>
                      {runtimeLabel(status, effectiveAppState.dockerSocketMounted)}
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

                <ResourcePanel server={activeServer} samples={resourceSamples} status={status} dockerSocketMounted={effectiveAppState.dockerSocketMounted} />

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
                          <FileTypeIcon entry={entry} />
                          <span className="fileName">{entry.name}</span>
                          <small>{entry.type === "file" ? formatBytes(entry.size) : ""}</small>
                        </button>
                        <button className="iconDangerButton" onClick={() => deleteFileEntry(entry)} disabled={isProvisioning} title={`Delete ${entry.name}`} aria-label={`Delete ${entry.name}`}>
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
                  <textarea value={editorText} onChange={(event) => { setEditorText(event.target.value); setDirty(true); }} disabled={isProvisioning || !selectedPath} spellCheck={false} />
                  <div className="buttonRow">
                    {dirty && (
                      <button className="secondaryButton" onClick={cancelFileEdit} disabled={isProvisioning || !selectedPath}>Cancel</button>
                    )}
                    <button onClick={saveFile} disabled={isProvisioning || !selectedPath || !dirty}>Save</button>
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
                  {!effectiveAppState.modrinthApiConfigured && (
                    <section className="systemBanner accent">
                      <strong>Modrinth API key is not configured.</strong>
                      <span>Installed mod management still works. Add a key in Settings to search and install new mods.</span>
                    </section>
                  )}
                  <div className="modsToolbar">
                    <div className="segmentedControl">
                      <button className={modsView === "manager" ? "active" : ""} onClick={() => setModsView("manager")}>Installed</button>
                      <button className={modsView === "search" ? "active" : ""} onClick={() => setModsView("search")} disabled={!effectiveAppState.modrinthApiConfigured}>Search</button>
                    </div>
                    <input ref={modUploadRef} className="hiddenInput" type="file" accept=".jar" onChange={uploadMod} />
                    <span className="muted">Fabric {activeServer.loaderVersion || "loader unknown"} - Minecraft {activeServer.minecraftVersion || "version unknown"}</span>
                  </div>

                  {modsView === "manager" && (
                    <div className="mods">
                      <div className="modActionGrid">
                        <button className="modRow addModRow" onClick={() => setModsView("search")} disabled={isProvisioning || !effectiveAppState.modrinthApiConfigured}>
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
                        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search compatible Fabric mods" disabled={isProvisioning || !effectiveAppState.modrinthApiConfigured} />
                        <button disabled={isProvisioning || isSearchingMods || !effectiveAppState.modrinthApiConfigured || !query.trim()}>{isSearchingMods ? "Searching" : "Refresh"}</button>
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
                        {modSearchResults.map((mod) => (
                          <article key={mod.project_id} className="modRow">
                            {mod.icon_url ? <img src={mod.icon_url} alt="" /> : <div className="modFileIcon">MOD</div>}
                            <div>
                              <strong>{mod.title}</strong>
                              <p>{mod.description}</p>
                              <small>{mod.downloads.toLocaleString()} downloads</small>
                            </div>
                            <button onClick={() => installMod(mod.project_id, mod.title)} disabled={modsLocked || !effectiveAppState.modrinthApiConfigured}>Install</button>
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
                    <dd>{activeServerIsDemo ? "Demo runtime control enabled" : status?.controlAvailable ? "Docker container control enabled" : "Not configured"}</dd>
                  </dl>
                  <ServerEditForm server={activeServer} versions={fabricVersions} totalMemory={effectiveAppState.totalMemory} onSubmit={updateServer} disabled={serverSettingsLocked} />
                </section>
                <DeleteServerPanel server={activeServer} onSubmit={deleteServer} disabled={serverSettingsLocked} />
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
      </div>
      <div className="resourceStats">
        <div className="resourceMetric">
          <span>Memory</span>
          <strong>{formatMegabytes(memoryUsage)} / {formatMegabytes(configuredMemoryBytes)}</strong>
        </div>
        <div className="resourceMetric">
          <span>CPU</span>
          <strong>{cpu.toFixed(1)}%</strong>
        </div>
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
  const [editing, setEditing] = useState(!configured);

  useEffect(() => {
    setEditing(!configured);
  }, [configured]);

  function submitKey(event: FormEvent<HTMLFormElement>) {
    onSubmit(event);
    setEditing(false);
  }

  if (configured && !editing) {
    return (
      <div className="keyForm keyFormConfigured">
        <div className="secretPreview" aria-label="Stored Modrinth API key">
          <span className="settingsStatus ready">Configured</span>
          <code aria-hidden="true">**** **** **** ****</code>
        </div>
        <button type="button" className="secondaryButton" onClick={() => setEditing(true)}>Replace key</button>
      </div>
    );
  }

  return (
    <form onSubmit={submitKey} className="keyForm">
      <label>
        {configured ? "New Modrinth API key" : "Modrinth API key"}
        <input
          name="modrinthApiKey"
          type="password"
          autoComplete="off"
          placeholder="Paste API key"
          required
        />
      </label>
      <div className="keyFormActions">
        {configured && <button type="button" className="secondaryButton" onClick={() => setEditing(false)}>Cancel</button>}
        <button>{configured ? "Save replacement" : "Save key"}</button>
      </div>
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
                      <AppIcon name="x" />
                    </button>
                  )}
                </div>
              ))}
              <button type="button" className="secondaryButton" onClick={() => setCommandIds((ids) => [...ids, clientId()])}>
                <AppIcon name="plus" />
                <span>Additional Command</span>
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
  const [confirmName, setConfirmName] = useState("");
  const deleteConfirmed = confirmName === server.displayName;

  useEffect(() => {
    setConfirmName("");
  }, [server.id]);

  return (
    <section className="panel dangerPanel">
      <h2>Delete Server</h2>
      <p className="muted">This removes the server from ServerSentinel. File deletion is optional and cannot be undone.</p>
      <form onSubmit={onSubmit} className="attachForm">
        <fieldset disabled={disabled}>
        <label>
          Type server name to confirm
          <input
            name="confirmName"
            placeholder={server.displayName}
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
            required
          />
        </label>
        <label className="checkLine dangerCheck">
          <input name="deleteFiles" type="checkbox" />
          Also delete this server's files from disk
        </label>
        <button className="dangerButton" disabled={!deleteConfirmed}>Delete Server</button>
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
