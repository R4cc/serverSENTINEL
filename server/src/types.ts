export type AppSettings = {
  modrinthApiKey?: string;
};

export type RolePreset = "viewer" | "operator" | "maintainer" | "manager" | "admin" | "custom";

export type Permission =
  | "servers.view"
  | "servers.control"
  | "servers.create"
  | "servers.delete"
  | "servers.editSettings"
  | "console.view"
  | "console.command"
  | "files.view"
  | "files.edit"
  | "files.delete"
  | "files.upload"
  | "files.download"
  | "mods.view"
  | "mods.install"
  | "mods.upload"
  | "mods.enableDisable"
  | "mods.remove"
  | "mods.update"
  | "schedules.view"
  | "schedules.manage"
  | "settings.view"
  | "integrations.manage"
  | "users.view"
  | "users.manage";

export type OperationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type OperationType =
  | "server.create"
  | "server.start"
  | "server.stop"
  | "server.restart"
  | "mod.upload"
  | "mod.install"
  | "mod.update"
  | "mod.remove"
  | "mod.toggle"
  | "mod.batchUpdate"
  | "schedule.run"
  | "backup.create"
  | "backup.restore"
  | "file.extract"
  | "import.run"
  | "export.run";

export type OperationRecord = {
  id: string;
  type: OperationType;
  status: OperationStatus;
  serverId?: string;
  nodeId?: string;
  createdBy?: string;
  progress: number;
  task?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  errorMessage?: string;
  result?: unknown;
  logSummary?: string;
};

export type ServerAccess = {
  mode: "all" | "selected";
  serverIds: string[];
};

export type StoredUser = {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  rolePreset: RolePreset;
  permissions: Permission[];
  serverAccess?: ServerAccess;
  createdAt: string;
  updatedAt: string;
};

export type PublicUser = {
  id: string;
  username: string;
  rolePreset: RolePreset;
  permissions: Permission[];
  serverAccess?: ServerAccess;
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
  overrideMinecraftVersion?: boolean;
  overrideReason?: string;
  clientSide?: string;
  serverSide?: string;
  iconUrl?: string;
  forceIncompatible?: boolean;
  reviewAcknowledgedVersionId?: string;
  reviewAcknowledgedAt?: string;
};

export type InstalledModDependencyHealth = {
  status: "satisfied" | "missing" | "unknown";
  requiredCount: number;
  missing: Array<{
    projectId?: string;
    versionId?: string;
    title?: string;
    iconUrl?: string;
    disabled?: boolean;
  }>;
};

export type RestartRequiredModAction = "added" | "removed" | "enabled" | "disabled" | "updated";

export type RestartRequiredChange = {
  type: "mod";
  identity: string;
  displayName: string;
  filename?: string;
  action: RestartRequiredModAction;
};

export type RestartRequiredModSnapshot = {
  identity: string;
  displayName: string;
  filename: string;
  enabled: boolean;
  sha1: string;
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
  date_published?: string;
  game_versions: string[];
  loaders: string[];
  files: Array<{ url: string; filename: string; primary: boolean; size?: number; hashes?: Record<string, string> }>;
  dependencies?: Array<{ project_id?: string; version_id?: string; dependency_type?: string }>;
};

export type ModrinthProject = {
  project_id?: string;
  id?: string;
  project_type?: string;
  slug?: string;
  title?: string;
  description?: string;
  downloads?: number;
  icon_url?: string | null;
  date_modified?: string;
  categories?: string[];
  versions?: string[];
  client_side?: string;
  server_side?: string;
};

export type FileEditLease = {
  leaseId: string;
  serverId: string;
  path: string;
  userId: string;
  sessionId: string;
  displayName: string;
  acquiredAt: string;
  refreshedAt: string;
  expiresAt: string;
  fileRevision: string;
};

export type LoaderType = "fabric";
export type ServerJarProviderId = "mcjars";
export type JavaMajorVersion = 17 | 21 | 25;
export type RuntimeCompatibilityStatus = "compatible" | "unsupported" | "unknown";

export type ServerRuntimeProfile = {
  minecraftVersion: string;
  loader: LoaderType;
  loaderVersion: string;
  javaMajorVersion: JavaMajorVersion;
  jarProvider: ServerJarProviderId;
  jarArtifact: {
    id?: string;
    filename: string;
    downloadUrl?: string;
    sha1?: string;
    sha256?: string;
    sizeBytes?: number;
  };
  compatibilityStatus: RuntimeCompatibilityStatus;
  resolvedAt: string;
};

export type NodeType = "local" | "remote";

export type NodeStatus = "online" | "offline" | "unknown";

export type ManagedNode = {
  id: string;
  name: string;
  type: NodeType;
  status: NodeStatus;
  isInternal: boolean;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  connectedAt?: string;
  agentVersion?: string;
  buildId?: string;
  protocolVersion?: string;
  capabilities?: string[];
  dockerStatus?: string;
  dataPathStatus?: string;
  totalMemory?: number;
  compatibility?: "compatible" | "incompatible" | "unknown";
  secretHash?: string;
  joinTokenHash?: string;
  joinTokenExpiresAt?: string;
};

export type PublicNode = Omit<ManagedNode, "secretHash" | "joinTokenHash"> & {
  hasPendingJoinToken?: boolean;
};

export type ManagedServer = {
  id: string;
  nodeId: string;
  displayName: string;
  serverDir: string;
  storageName?: string;
  runtimeProfile: ServerRuntimeProfile;
  dockerContainer?: string;
  dockerImage?: string;
  dockerMountSource?: string;
  dockerWorkingDir?: string;
  dockerPorts?: string;
  managedPorts?: ManagedServerPort[];
  javaArgs?: string;
  desiredRuntimeState?: "running" | "stopped";
  restartRequiredSince?: string;
  restartRequiredChanges?: RestartRequiredChange[];
  restartRequiredModBaseline?: RestartRequiredModSnapshot[];
  schedules?: ScheduledExecution[];
  createdAt: string;
  updatedAt: string;
};

export type ScheduledExecution = {
  id: string;
  name: string;
  cron: string;
  commands: string[];
  commandDelaysSeconds: number[];
  commandDelaysMinutes?: number[];
  onlyWhenNoPlayers: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: string;
  lastMessage?: string;
  nextRunAt?: string;
  recentRuns?: ScheduledRun[];
  activeRuns?: ScheduledActiveRun[];
};

export type ManagedServerPort = {
  id: string;
  name: string;
  type: "minecraft" | "query" | "custom";
  protocol: "tcp" | "udp";
  internalPort: number;
  externalPort: number;
  required: boolean;
  removable: boolean;
  advanced: boolean;
};

export type ScheduledRun = {
  id: string;
  scheduleId: string;
  scheduleName: string;
  status: string;
  message?: string;
  ranAt: string;
};

export type ScheduledActiveRun = {
  id: string;
  scheduleId: string;
  scheduleName: string;
  status: "running";
  startedAt: string;
  actionCount: number;
  currentActionIndex?: number;
  currentAction?: string;
  waitingUntil?: string;
  waitingDelaySeconds?: number;
  waitingDelayMinutes?: number;
  message?: string;
};

export type PublicServer = Omit<ManagedServer, "serverDir" | "dockerMountSource" | "dockerWorkingDir" | "desiredRuntimeState"> & {
  directoryLabel: string;
  hasDockerContainer: boolean;
  nodeName?: string;
  resolvedVersions?: ResolvedServerVersions;
};

export type VersionSource = "detected" | "profile" | "log" | "unknown" | "demo";

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

export type ServerEvent = {
  id: string;
  eventType: "server_started" | "server_stopped" | "player_joined" | "player_left" | "mod_disabled" | "server_crashed";
  type: "info" | "success" | "warning" | "error";
  severity: "info" | "success" | "warning" | "error";
  text: string;
  message: string;
  timestamp?: string;
  signature: string;
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
  playerNames?: string[];
};
