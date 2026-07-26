import type {
  NodeInstallInstructions,
  PublicNode,
  PublicServer,
  PublicUser,
  PlayerSnapshot,
  ReleaseChannel,
  RuntimeLifecycleStatus,
  ServerActivity,
  ServerEvent
} from "@serversentinel/contracts";

export type {
  CreateNodeResponse,
  ManagedServerPort,
  NodeInstallInstructions,
  NodeProtocolMode,
  NodeStatus,
  NodeType,
  OperationRecord,
  Permission as PermissionKey,
  PlayerSnapshot,
  PublicNode,
  PublicServer,
  PublicUser,
  ReleaseChannel,
  ResolvedServerVersions,
  RestartPhase,
  RestartRequiredChange,
  RestartRequiredModSnapshot,
  RolePreset,
  RuntimeIntent,
  RuntimeLifecycleStatus,
  ScheduleStep,
  ScheduledActiveRun,
  ScheduledExecution,
  ScheduledRun,
  ScheduledRunStepDetails,
  ServerActivity,
  ServerEvent,
  ServerTimelineEvent,
  ServerTimelinePlayerActivity,
  ServerTimelinePlayerSession,
  ServerTimelineResourcePoint,
  ServerTimelineResponse,
  ServerTimelineScheduleMarker,
  ServerRuntimeProfile,
  VersionResolution,
  VersionSource
} from "@serversentinel/contracts";

/**
 * The panel serializes servers and nodes as PublicServer / PublicNode. These
 * aliases keep the established UI vocabulary while the shape stays owned by the
 * shared contract, so a backend field change surfaces here as a type error
 * instead of a silently missing property.
 */
export type ManagedServer = PublicServer;
export type ManagedNode = PublicNode;

export type RuntimeVersion = {
  id: string;
  runtimeVersion: string;
  stable?: boolean;
  recommended?: boolean;
  buildId?: string;
};

/** @deprecated Legacy Fabric endpoint response. */
export type RuntimeLoaderVersion = {
  id: string;
  loaderVersion: string;
  stable?: boolean;
  recommended?: boolean;
  buildId?: string;
};

/**
 * A synthetic node the UI shows before the API has described a real one: the
 * implicit local node in all-in-one mode, and the "no node selected" stub in
 * panel mode. Neither has server-assigned timestamps, so those are absent
 * rather than invented.
 */
export type PlaceholderNode = Omit<ManagedNode, "createdAt" | "updatedAt">;

/**
 * The node shape presentation code reads. Satisfied by both a real ManagedNode
 * from the API and a PlaceholderNode, so display helpers accept either; the
 * server-assigned timestamps are optional here because placeholders have none.
 * Use ManagedNode, not this, when typing an API response.
 */
export type NodeView = PlaceholderNode & Partial<Pick<ManagedNode, "createdAt" | "updatedAt">>;

/** A node paired with its servers for the workspace switcher. */
export type ContextNode = NodeView & {
  servers: ManagedServer[];
};

export type NodeInstallResponse = {
  node: ManagedNode;
  install: NodeInstallInstructions;
};

export type NodeUpdateResponse = {
  ok: boolean;
  mode: "self" | "offline" | "current";
  message: string;
  image?: string;
  command?: string;
  planPath?: string;
};

export type NodeOperation = {
  kind: "update" | "restart";
  phase: "waiting" | "timed-out";
  startedAt: number;
  startedConnectedAt?: string;
  observedOffline?: boolean;
  reconnectedAt?: number;
  targetVersion?: string;
  targetBuildId?: string;
};

export type NodeManualRecovery = {
  message: string;
  command?: string;
  image?: string;
};

export type PlayerHeadsState = {
  enabled: boolean;
  onboardingRequired: boolean;
  provider: "mc-heads.net";
  cacheEntries: number;
  cacheBytes: number;
};

export type AppState = {
  servers: ManagedServer[];
  /**
   * NodeView rather than ManagedNode because demo mode synthesizes this list
   * from a PlaceholderNode. Real nodes fetched from the API stay ManagedNode.
   */
  nodes?: NodeView[];
  appVersion?: string;
  buildId?: string;
  runtimeMode?: "all-in-one" | "panel" | "node";
  timeZone?: string;
  modrinthApiConfigured: boolean;
  playerHeads: PlayerHeadsState;
  dockerSocketMounted: boolean;
  totalMemory: number;
  currentUser?: PublicUser;
};

export type AuthSession = {
  authenticated: boolean;
  setupRequired: boolean;
  demoEnabled?: boolean;
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
  lifecycle: RuntimeLifecycleStatus;
};

export type ResourceStats = {
  available: boolean;
  running: boolean;
  cpuPercent: number;
  cpuCapacityCores?: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  playersOnline?: number;
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

export type ServerOverviewData = {
  events: ServerEvent[];
  eventsStatus?: "ok" | "unavailable";
  activity: ServerActivity;
};

export type PlayerSnapshotsResponse = {
  snapshots: Record<string, PlayerSnapshot>;
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

export type ModCompatibility = {
  status: "compatible" | "no_fabric" | "no_compatible_loader" | "no_minecraft_version" | "incompatible" | "unknown";
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
    loader: string;
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
  dependencyHealth?: {
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
  game: Array<{ version: string; stable: boolean; recommended?: boolean; type?: "release" | "snapshot" | "unknown" }>;
  loader: Array<{ version: string; stable: boolean }>;
  installer: Array<{ version: string; stable: boolean }>;
};

export type ModUpdatePlanStatus = "up_to_date" | "safe_update" | "needs_review" | "blocked" | "unknown";

export type ModUpdatePlanEntry = {
  filename: string;
  displayName: string;
  iconUrl?: string;
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

export type ScheduleNavigationTarget =
  | { kind: "schedule"; scheduleId: string }
  | { kind: "active-run"; scheduleId: string; runId: string }
  | { kind: "completed-run"; scheduleId: string; runId: string };

export type ThemePreference = "light" | "dark" | "system";

export type RegionalFormatPreference = "user" | "en-US" | "en-GB" | "de-DE" | "fr-FR" | "ja-JP";

export type DisplayTimeZonePreference = "panel" | "browser" | "utc";
