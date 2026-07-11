export type ManagedServer = {
  id: string;
  displayName: string;
  nodeId: string;
  nodeName?: string;
  directoryLabel: string;
  storageName?: string;
  dockerContainer?: string;
  dockerImage?: string;
  dockerPorts?: string;
  managedPorts?: ManagedServerPort[];
  javaArgs?: string;
  restartRequiredSince?: string;
  schedules?: ScheduledExecution[];
  hasDockerContainer: boolean;
  resolvedVersions?: ResolvedServerVersions;
  runtimeProfile: ServerRuntimeProfile;
};

export type ManagedServerPort = {
  id: string;
  name: string;
  type: string;
  protocol: "tcp" | "udp";
  internalPort: number;
  externalPort: number;
  required?: boolean;
  removable?: boolean;
  advanced?: boolean;
};

export type LoaderType = "fabric";
export type ServerJarProviderId = "mcjars";
export type RuntimeCompatibilityStatus = "compatible" | "unsupported" | "unknown";

export type ServerRuntimeProfile = {
  minecraftVersion: string;
  loader: LoaderType;
  loaderVersion: string;
  javaMajorVersion: 17 | 21 | 25;
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

export type RuntimeLoaderVersion = {
  id: string;
  loaderVersion: string;
  stable?: boolean;
  recommended?: boolean;
  buildId?: string;
};

export type ManagedNode = {
  id: string;
  name: string;
  type: "local" | "remote";
  status: "online" | "offline" | "unknown";
  isInternal: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastSeenAt?: string;
  connectedAt?: string;
  agentVersion?: string;
  buildId?: string;
  protocolVersion?: string;
  dockerStatus?: string;
  dataPathStatus?: string;
  totalMemory?: number;
  joinTokenExpiresAt?: string;
  hasPendingJoinToken?: boolean;
  compatibility?: "compatible" | "incompatible" | "unknown";
  capabilities?: string[];
};

export type ContextNode = ManagedNode & {
  servers: ManagedServer[];
};

export type NodeInstallInstructions = {
  image: string;
  panelUrl: string;
  joinToken?: string;
  tokenRequired: boolean;
  dataMount: string;
  dockerSocketMount: string;
  dockerCompose: {
    image: string;
    restart: "unless-stopped";
    environment: {
      SS_MODE: "node";
      SS_PANEL_URL: string;
      SERVERSENTINEL_DATA_DIR?: string;
      SERVERSENTINEL_DOCKER_DATA_DIR?: string;
      TZ: string;
      SS_NODE_NAME?: string;
      SS_JOIN_TOKEN?: string;
    };
    volumes: string[];
  };
  dockerRun: string;
};

export type CreateNodeResponse = {
  node: ManagedNode;
  joinToken: string;
  expiresAt: string;
  install: NodeInstallInstructions;
};

export type NodeInstallResponse = {
  node: ManagedNode;
  install: NodeInstallInstructions;
};

export type NodeUpdateResponse = {
  ok: boolean;
  mode: "self" | "offline";
  message: string;
  image?: string;
  command?: string;
  planPath?: string;
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

export type ScheduledExecution = {
  id: string;
  name: string;
  cron: string;
  commands: string[];
  commandDelaysMinutes: number[];
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
  waitingDelayMinutes?: number;
  message?: string;
};

export type AppState = {
  servers: ManagedServer[];
  nodes?: ManagedNode[];
  appVersion?: string;
  buildId?: string;
  runtimeMode?: "all-in-one" | "panel" | "node";
  timeZone?: string;
  modrinthApiConfigured: boolean;
  dockerSocketMounted: boolean;
  totalMemory: number;
  currentUser?: PublicUser;
};

export type RolePreset = "viewer" | "operator" | "maintainer" | "manager" | "admin" | "custom";

export type PermissionKey =
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

export type ServerAccess = {
  mode: "all" | "selected";
  serverIds: string[];
};

export type PublicUser = {
  id: string;
  username: string;
  rolePreset: RolePreset;
  permissions: PermissionKey[];
  serverAccess?: ServerAccess;
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
  server: Pick<ManagedServer, "id">;
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

export type ResourceStatsHistory = {
  samples: ResourceSample[];
};

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
};

export type ServerOverviewData = {
  events: ServerEvent[];
  eventsStatus?: "ok" | "unavailable";
  activity: ServerActivity;
};

export type FileEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number;
  modifiedAt: string;
  permissions?: string;
  owner?: string;
  status?: "ok" | "locked" | "binary" | "too_large" | "unknown";
};

export type FileListing = {
  path: string;
  entries: FileEntry[];
};

export type ZipArchiveListing = FileListing & {
  archivePath: string;
  readOnly: true;
  encrypted: boolean;
};

export type ZipExtractionPlan = {
  archivePath: string;
  destinationPath: string;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  outputPaths: Array<{ path: string; type: "directory" | "file" }>;
  conflicts: Array<{ path: string; kind: "file" | "type" | "symlink" }>;
  blocked: Array<{ path: string; kind: "file" | "type" | "symlink" }>;
};

export type FilePreview = {
  path: string;
  preview: "text" | "unsupported" | "binary" | "too_large";
  content?: string;
  message?: string;
  modifiedAt?: string;
};

export type FileEditLease = {
  leaseId: string;
  serverId: string;
  path: string;
  userId: string;
  displayName: string;
  acquiredAt: string;
  refreshedAt: string;
  expiresAt: string;
  fileRevision: string;
};

export type ReleaseChannel = "release" | "beta" | "alpha";

export type ModCompatibility = {
  status: "compatible" | "no_fabric" | "no_minecraft_version" | "incompatible" | "unknown";
  compatible: boolean;
  reason: string;
  matchedVersionId?: string;
  matchedVersionNumber?: string;
  matchedVersionType?: ReleaseChannel;
  matchedLoaders?: string[];
  matchedGameVersions?: string[];
  file?: {
    filename: string;
    size?: number;
  };
  serverSide?: string;
  clientSide?: string;
};

export type ModrinthHit = {
  project_id: string;
  title: string;
  author?: string;
  description: string;
  downloads: number;
  icon_url?: string;
  date_modified?: string;
  compatibility?: ModCompatibility;
  client_side?: string;
  server_side?: string;
};

export type ModrinthInstallVersionStatus =
  | "recommended"
  | "compatible"
  | "version_mismatch"
  | "wrong_loader"
  | "no_installable_jar"
  | "client_only"
  | "server_support_unknown";

export type ModrinthInstallVersion = {
  id: string;
  versionNumber: string;
  releaseChannel: ReleaseChannel;
  publishedAt?: string;
  minecraftVersions: string[];
  loaders: string[];
  file?: {
    filename: string;
    size?: number;
  };
  compatible: boolean;
  selectable: boolean;
  requiresMinecraftAcknowledgement: boolean;
  status: ModrinthInstallVersionStatus;
  statusLabel: string;
  reason: string;
  dependencies: Array<{
    projectId?: string;
    versionId?: string;
    dependencyType: "required" | "optional" | "incompatible" | "embedded" | string;
    title?: string;
    iconUrl?: string;
  }>;
};

export type ModrinthInstallVersionsResponse = {
  project: {
    id: string;
    title?: string;
    description?: string;
    iconUrl?: string;
    clientSide?: string;
    serverSide?: string;
  };
  target: {
    serverId: string;
    serverName: string;
    minecraftVersion: string;
    loader: "Fabric" | "fabric";
  };
  channel: ReleaseChannel;
  compatibleVersions: ModrinthInstallVersion[];
  otherVersions: ModrinthInstallVersion[];
};

export type InstalledMod = {
  filename: string;
  displayName: string;
  enabled: boolean;
  size: number;
  modifiedAt: string;
  iconUrl?: string;
  description?: string;
  preferredChannel?: ReleaseChannel;
  compatibility?: ModCompatibility;
  modrinth?: {
    projectId: string;
    versionId: string;
    filename: string;
    versionNumber: string;
    versionType?: ReleaseChannel;
    gameVersions: string[];
    loaders: string[];
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
  versionInfo?: {
    currentVersion?: string;
    currentChannel?: ReleaseChannel;
    latestVersion?: string;
    latestVersionId?: string;
    latestFilename?: string;
    latestChannel?: ReleaseChannel;
    upToDate?: boolean;
  } | null;
};

export type FabricVersions = {
  game: Array<{ version: string; stable: boolean; type?: "release" | "snapshot" | "unknown" }>;
  loader: Array<{ version: string; stable: boolean }>;
  installer: Array<{ version: string; stable: boolean }>;
};

export type ModUpdatePlanStatus = "up_to_date" | "safe_update" | "needs_review" | "blocked" | "unknown";

export type ModUpdatePlanEntry = {
  filename: string;
  displayName: string;
  projectId?: string;
  currentVersion?: string;
  currentFilename: string;
  targetVersion?: string;
  targetFilename?: string;
  channel: ReleaseChannel;
  status: ModUpdatePlanStatus;
  reason: string;
  compatibility?: {
    status?: string;
    compatible: boolean;
    reason?: string;
    serverSide?: string;
    clientSide?: string;
  };
  safeBatchEligible: boolean;
  acknowledgementRequired: boolean;
  enabled: boolean;
};

export type ModUpdatePlan = {
  serverId: string;
  generatedAt: string;
  counts: {
    totalInstalled: number;
    safeUpdates: number;
    reviewUpdates: number;
    blockedUpdates: number;
    upToDate: number;
    unknown: number;
  };
  updates: ModUpdatePlanEntry[];
};

export type SafeBatchUpdateResult = {
  updated: Array<{ filename: string; result: unknown }>;
  skipped: Array<{ filename: string; reason: string }>;
  failed: Array<{ filename: string; reason: string }>;
  counts: { requested: number; updated: number; skipped: number; failed: number };
};

export type OperationRecord = {
  id: string;
  type:
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
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
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

export type GeneralJob = {
  id: string;
  type: "provision" | "mod-install" | "mod-upload" | "file-extract";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  title: string;
  subject?: string;
  progress: number;
  task?: string;
  error?: string;
  errorDetails?: string;
  finalNotification?: {
    type: "success" | "error" | "info" | "warning";
    text: string;
  };
  dismissible: boolean;
};

export type ActivePage = "servers" | "settings" | "nodes" | "create" | "overview" | "console" | "files" | "mods" | "schedule" | "properties";

export type ThemePreference = "light" | "dark" | "system";

export type LocalePreference = "user" | "en-US" | "en-GB" | "de-DE" | "fr-FR" | "ja-JP";
