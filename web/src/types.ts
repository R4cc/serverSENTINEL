export type ManagedServer = {
  id: string;
  displayName: string;
  nodeId: string;
  nodeName?: string;
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
  limitContainerMemory?: boolean;
  schedules?: ScheduledExecution[];
  serverType: "fabric";
  hasDockerContainer: boolean;
  resolvedVersions?: ResolvedServerVersions;
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
  protocolVersion?: string;
  dockerStatus?: string;
  dataPathStatus?: string;
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
    environment: {
      SS_MODE: "node";
      SS_PANEL_URL: string;
      SS_NODE_DATA_DIR?: string;
      SS_NODE_DOCKER_DATA_DIR?: string;
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
  mode: "self" | "manual" | "offline";
  message: string;
  image?: string;
  command?: string;
  planPath?: string;
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
  nodes?: ManagedNode[];
  runtimeMode?: "all-in-one" | "panel" | "node";
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

export type FilePreview = {
  path: string;
  preview: "text" | "unsupported" | "binary" | "too_large";
  content?: string;
  message?: string;
  modifiedAt?: string;
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
    url: string;
    size?: number;
    hashes?: Record<string, string>;
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
    hashes?: Record<string, string>;
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
    loader: "Fabric";
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
    hashes?: Record<string, string>;
    installedAt: string;
    installedWithForceIncompatible: boolean;
    incompatibilityReason?: string;
    overrideMinecraftVersion?: boolean;
    overrideReason?: string;
    clientSide?: string;
    serverSide?: string;
    forceIncompatible?: boolean;
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
  type: "success" | "error" | "info" | "warning";
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

export type GeneralJob = {
  id: string;
  type: "provision" | "mod-install" | "mod-upload";
  status: "running" | "succeeded" | "failed";
  title: string;
  subject?: string;
  progress: number;
  task: string;
  error?: string;
  dismissible: boolean;
};

export type ActivePage = "servers" | "settings" | "nodes" | "create" | "overview" | "console" | "files" | "mods" | "schedule" | "properties";

export type ThemePreference = "light" | "dark" | "system";

export type LocalePreference = "user" | "en-US" | "en-GB" | "de-DE" | "fr-FR" | "ja-JP";
