export type ManagedServer = {
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
  resolvedVersions?: ResolvedServerVersions;
};

export type VersionSource = "detected" | "stored" | "log" | "unknown" | "demo";

export type VersionResolution = {
  version?: string;
  source: VersionSource;
  lastCheckedAt: string;
};

export type ResolvedServerVersions = {
  minecraftVersion: VersionResolution;
  fabricLoaderVersion: VersionResolution;
};

export type ScheduledExecution = {
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

export type AppState = {
  servers: ManagedServer[];
  modrinthApiConfigured: boolean;
  dockerSocketMounted: boolean;
  totalMemory: number;
  currentUser?: PublicUser;
};

export type UserRole = "admin" | "basic" | "expanded" | "manager";

export type PublicUser = {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
};

export type AuthSession = {
  authenticated: boolean;
  setupRequired: boolean;
  demo?: boolean;
  user: PublicUser | null;
};

export type DockerStatus = {
  configured: boolean;
  available: boolean;
  controllable: boolean;
  state: string;
  running?: boolean;
  container?: string;
  message?: string;
};

export type ServerStatus = {
  server: ManagedServer;
  docker: DockerStatus;
  fileLogsAvailable: boolean;
  controlAvailable: boolean;
  commandInputAvailable: boolean;
  commandInputMessage: string;
};

export type ResourceStats = {
  available: boolean;
  running: boolean;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  networkRxBytes?: number;
  networkTxBytes?: number;
  readAt: string;
  container?: string;
  message?: string;
};

export type ResourceSample = ResourceStats & {
  sampledAt: number;
};

export type ServerEvent = {
  id: string;
  type: "info" | "success" | "warning" | "error";
  text: string;
  timestamp?: string;
  source: "logs/latest.log" | "docker";
};

export type ServerActivity = {
  lastStartedAt?: string;
  lastStoppedAt?: string;
  lastRestartAt?: string;
  currentWorld?: string;
  serverPort?: string;
  eulaAccepted?: boolean;
  javaRuntime?: string;
  autosaveStatus?: string;
  playersOnline?: number | null;
  maxPlayers?: number | null;
};

export type ServerOverviewData = {
  events: ServerEvent[];
  activity: ServerActivity;
};

export type FileEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number;
  modifiedAt: string;
};

export type FileListing = {
  path: string;
  entries: FileEntry[];
};

export type ReleaseChannel = "release" | "beta" | "alpha";

export type ModCompatibility = {
  status: "compatible" | "no_fabric" | "no_minecraft_version" | "incompatible" | "unknown";
  compatible: boolean;
  reason: string;
};

export type ModrinthHit = {
  project_id: string;
  title: string;
  description: string;
  downloads: number;
  icon_url?: string;
  compatibility?: ModCompatibility;
};

export type InstalledMod = {
  filename: string;
  displayName: string;
  enabled: boolean;
  size: number;
  modifiedAt: string;
  iconUrl?: string;
  preferredChannel?: ReleaseChannel;
  compatibility?: ModCompatibility;
  modrinth?: {
    projectId: string;
    versionId: string;
    filename: string;
    versionNumber: string;
    gameVersions: string[];
    loaders: string[];
    installedAt: string;
    installedWithForceIncompatible: boolean;
  };
  versionInfo?: {
    currentVersion?: string;
    currentChannel?: ReleaseChannel;
    latestVersion?: string;
    latestChannel?: ReleaseChannel;
    upToDate?: boolean;
  } | null;
};

export type FabricVersions = {
  game: Array<{ version: string; stable: boolean }>;
  loader: Array<{ version: string; stable: boolean }>;
  installer: Array<{ version: string; stable: boolean }>;
};

export type Notice = {
  id: number;
  type: "success" | "error" | "info";
  text: string;
};

export type ProvisionJob = {
  id: string;
  status: "running" | "succeeded" | "failed";
  progress: number;
  task: string;
  server?: ManagedServer;
  error?: string;
};

export type ActivePage = "servers" | "settings" | "create" | "overview" | "console" | "files" | "mods" | "schedule" | "properties";

export type ThemePreference = "light" | "dark" | "system";

export type LocalePreference = "user" | "en-US" | "en-GB" | "de-DE" | "fr-FR" | "ja-JP";
