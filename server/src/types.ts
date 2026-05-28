export type AppSettings = {
  modrinthApiKey?: string;
};

export type UserRole = "admin" | "basic" | "expanded" | "manager";

export type Permission = "basic" | "expanded" | "manager" | "admin";

export type StoredUser = {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
};

export type PublicUser = {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
};

export type Session = {
  id: string;
  userId: string;
  createdAt: string;
};

export type ReleaseChannel = "release" | "beta" | "alpha";

export type ModPreference = {
  channel: ReleaseChannel;
  modrinth?: InstalledModMetadata;
};

export type InstalledModMetadata = {
  projectId: string;
  versionId: string;
  filename: string;
  versionNumber: string;
  versionType?: ReleaseChannel;
  gameVersions: string[];
  loaders: string[];
  hashes?: Record<string, string>;
  installedAt: string;
  installedWithForceIncompatible: boolean;
  incompatibilityReason?: string;
  clientSide?: string;
  serverSide?: string;
  forceIncompatible?: boolean;
};

export type ModCompatibilityStatus = "compatible" | "no_fabric" | "no_minecraft_version" | "incompatible" | "unknown";

export type ModCompatibility = {
  status: ModCompatibilityStatus;
  compatible: boolean;
  reason: string;
  matchedVersionId?: string;
  matchedVersionNumber?: string;
  matchedVersionType?: ReleaseChannel;
  matchedLoaders?: string[];
  matchedGameVersions?: string[];
  file?: {
    filename: string;
    url: string;
    size?: number;
    hashes?: Record<string, string>;
  };
  serverSide?: string;
  clientSide?: string;
};

export type ModrinthVersion = {
  id: string;
  project_id?: string;
  version_number: string;
  version_type: string;
  game_versions: string[];
  loaders: string[];
  files: Array<{ url: string; filename: string; primary: boolean; size?: number; hashes?: Record<string, string> }>;
};

export type ModrinthProject = {
  project_id?: string;
  id?: string;
  title?: string;
  description?: string;
  downloads?: number;
  icon_url?: string | null;
  date_modified?: string;
  client_side?: string;
  server_side?: string;
};

export type ManagedServer = {
  id: string;
  displayName: string;
  serverDir: string;
  storageName?: string;
  minecraftVersion?: string;
  loaderVersion?: string;
  installerVersion?: string;
  serverJar?: string;
  dockerContainer?: string;
  dockerImage?: string;
  dockerMountSource?: string;
  dockerWorkingDir?: string;
  dockerPorts?: string;
  javaArgs?: string;
  schedules?: ScheduledExecution[];
  serverType: "fabric";
  createdAt: string;
  updatedAt: string;
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

export type PublicServer = Omit<ManagedServer, "serverDir" | "dockerMountSource" | "dockerWorkingDir"> & {
  directoryLabel: string;
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

export type DockerState = "running" | "exited" | "created" | "paused" | "restarting" | "removing" | "dead" | "unknown";

export type DockerExecCreate = {
  Id: string;
};

export type DockerExecInspect = {
  ExitCode?: number | null;
};

export type DockerContainerInspect = {
  State?: {
    Status?: DockerState;
    Running?: boolean;
    StartedAt?: string;
    FinishedAt?: string;
  };
  HostConfig?: {
    Binds?: string[];
  };
  Mounts?: Array<{
    Type?: string;
    Source?: string;
    Destination?: string;
  }>;
};

export type DockerStats = {
  read: string;
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
  };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
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

export type CreateServerInput = {
  displayName?: string;
  minecraftVersion?: string;
  loaderVersion?: string;
  installerVersion?: string;
  serverJar?: string;
  dockerContainer?: string;
  dockerImage?: string;
  dockerPorts?: string;
  javaArgs?: string;
  acceptEula?: boolean;
  serverPort?: string;
};

export type ProvisionJob = {
  id: string;
  status: "running" | "succeeded" | "failed";
  progress: number;
  task: string;
  server?: PublicServer;
  error?: string;
};

export type Client = {
  readyState: number;
  send(data: string): void;
  close(): void;
};
