export type RolePreset = "viewer" | "operator" | "maintainer" | "manager" | "admin" | "custom";

export type Permission =
  | "servers.view"
  | "servers.control"
  | "servers.create"
  | "servers.delete"
  | "servers.editSettings"
  | "servers.export"
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

export type PublicUser = {
  id: string;
  username: string;
  rolePreset: RolePreset;
  permissions: Permission[];
  serverAccess?: ServerAccess;
  createdAt: string;
};

export type ReleaseChannel = "release" | "beta" | "alpha";

export type RestartRequiredModAction = "added" | "removed" | "enabled" | "disabled" | "updated";

export type RestartRequiredChange = {
  type: "mod";
  identity: string;
  displayName: string;
  filename?: string;
  action: RestartRequiredModAction;
};

export const serverRuntimeTypes = ["fabric", "paper"] as const;
export type ServerRuntimeType = typeof serverRuntimeTypes[number];

/** @deprecated Use ServerRuntimeType. Kept for rolling compatibility with older integrations. */
export type LoaderType = "fabric";
export type RuntimeContentKind = "mods" | "plugins";

export type ServerRuntimeDefinition = {
  type: ServerRuntimeType;
  displayName: string;
  description: string;
  versionLabel: string;
  serverJarFilename: string;
  contentKind: RuntimeContentKind;
  contentDirectory: string;
  modrinthLoader: string;
  compatibleModrinthLoaders: readonly string[];
  modrinthProjectType: "mod" | "plugin";
  managedProvisioning: boolean;
  managedContent: boolean;
};

export const serverRuntimeDefinitions: Readonly<Record<ServerRuntimeType, ServerRuntimeDefinition>> = {
  fabric: {
    type: "fabric",
    displayName: "Fabric",
    description: "Lightweight and modular modding framework.",
    versionLabel: "Fabric Loader version",
    serverJarFilename: "fabric-server-launch.jar",
    contentKind: "mods",
    contentDirectory: "mods",
    modrinthLoader: "fabric",
    compatibleModrinthLoaders: ["fabric"],
    modrinthProjectType: "mod",
    managedProvisioning: true,
    managedContent: true
  },
  paper: {
    type: "paper",
    displayName: "Paper",
    description: "High-performance server runtime with a plugin ecosystem.",
    versionLabel: "Paper build",
    serverJarFilename: "paper.jar",
    contentKind: "plugins",
    contentDirectory: "plugins",
    modrinthLoader: "paper",
    compatibleModrinthLoaders: ["paper", "bukkit", "spigot"],
    modrinthProjectType: "plugin",
    managedProvisioning: true,
    managedContent: true
  }
};

export function serverRuntimeDefinition(type: ServerRuntimeType): ServerRuntimeDefinition {
  return serverRuntimeDefinitions[type];
}
export type ServerJarProviderId = "mcjars" | "papermc";
export type JavaMajorVersion = 17 | 21 | 25;
export type RuntimeCompatibilityStatus = "compatible" | "unsupported" | "unknown";

export type ServerRuntimeProfile = {
  minecraftVersion: string;
  runtimeType: ServerRuntimeType;
  runtimeVersion: string;
  /** @deprecated Legacy Fabric profile field, emitted temporarily for older nodes and exports. */
  loader?: LoaderType;
  /** @deprecated Legacy Fabric profile field, emitted temporarily for older nodes and exports. */
  loaderVersion?: string;
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

export type ScheduleStep =
  | { type: "command"; command: string; delaySeconds: number }
  | { type: "action"; procedure: "restart"; delaySeconds: number };

export type ScheduledRunStepDetails = {
  stepIndex: number;
  type: "command" | "action";
  command?: string;
  procedure?: "restart";
  delaySeconds: number;
  status: "success" | "failed";
  startedAt: string;
  completedAt?: string;
  logs?: string[];
  logCaptureStatus?: "captured" | "empty" | "unavailable";
};

export type ScheduledRunDetails = {
  stepCount: number;
  completedStepCount: number;
  terminalStepIndex?: number;
  terminalStep?: string;
  steps?: ScheduledRunStepDetails[];
};

export type ScheduledRun = {
  id: string;
  scheduleId: string;
  scheduleName: string;
  status: string;
  message?: string;
  ranAt: string;
  details?: ScheduledRunDetails;
};

export type ScheduledActiveRun = {
  id: string;
  scheduleId: string;
  scheduleName: string;
  status: "running";
  startedAt: string;
  stepCount: number;
  currentStepIndex?: number;
  currentStep?: string;
  cancellable: boolean;
  waitingUntil?: string;
  waitingDelaySeconds?: number;
  message?: string;
};

export type ScheduledExecution = {
  id: string;
  name: string;
  cron: string;
  steps: ScheduleStep[];
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

export type RuntimeIntent = "stopped" | "running" | "restarting";

export type RuntimeLifecycleStatus = {
  intent: RuntimeIntent;
  state: "running" | "stopped" | "stopping" | "starting" | "recovering" | "crash-loop";
  recoveryAttempt?: number;
  recoveryLimit?: number;
  nextRetryAt?: string;
  crashLoopSince?: string;
  message?: string;
};

export type VersionSource = "detected" | "profile" | "log" | "unknown" | "demo";

export type VersionResolution = {
  version?: string;
  source: VersionSource;
  lastCheckedAt: string;
};

export type ResolvedServerVersions = {
  minecraftVersion: VersionResolution;
  runtimeVersion: VersionResolution;
  /** @deprecated Legacy Fabric response field, emitted temporarily for older web clients. */
  fabricLoaderVersion?: VersionResolution;
};

export type ServerEvent = {
  id: string;
  eventType:
    | "server_started"
    | "server_stopped"
    | "player_joined"
    | "player_left"
    | "mod_disabled"
    | "server_crashed"
    | "exception_caught"
    | "server_overloaded";
  type: "info" | "success" | "warning" | "error";
  severity: "info" | "success" | "warning" | "error";
  text: string;
  message: string;
  details?: string;
  timestamp?: string;
  signature: string;
  source: "logs/latest.log" | "docker";
  subject?: string;
};

export type ServerTimelineResourcePoint = {
  sampledAt: number;
  available: boolean;
  running: boolean;
  cpuPercent: number | null;
  cpuUtilizationPercent: number | null;
  memoryUsageBytes: number | null;
  memoryLimitBytes: number | null;
  memoryUtilizationPercent: number | null;
  playersOnline: number | null;
  networkRxBytesPerSecond: number | null;
  networkTxBytesPerSecond: number | null;
};

export type ServerTimelineEvent = ServerEvent & {
  occurredAt: number;
};

export type ServerTimelineScheduleMarker = {
  id: string;
  scheduleId: string;
  scheduleName: string;
  occurredAt: number;
  kind: "run" | "active" | "upcoming";
  status: "success" | "failed" | "skipped" | "cancelled" | "running" | "upcoming" | "unknown";
  runId?: string;
  message?: string;
};

export type ServerTimelineResponse = {
  from: number;
  to: number;
  generatedAt: string;
  latest?: ServerTimelineResourcePoint;
  samples: ServerTimelineResourcePoint[];
  events: ServerTimelineEvent[];
  schedules: ServerTimelineScheduleMarker[];
  scheduleAnnotationsAvailable: boolean;
  truncated: { schedules: boolean };
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
};

export type PlayerSnapshotErrorCode =
  | "NODE_UNAVAILABLE"
  | "QUERY_DISABLED"
  | "QUERY_ENDPOINT_UNAVAILABLE"
  | "QUERY_TIMEOUT"
  | "QUERY_RESPONSE_INCOMPLETE"
  | "QUERY_RESPONSE_INVALID";

export type PlayerSnapshot =
  | {
      state: "live";
      online: number;
      maxPlayers: number | null;
      names: string[];
      sampledAt: string;
    }
  | {
      state: "stale";
      online: number;
      maxPlayers: number | null;
      names: string[];
      sampledAt: string;
      lastAttemptAt: string;
      code: PlayerSnapshotErrorCode;
      message: string;
    }
  | {
      state: "stopped";
      online: 0;
      maxPlayers: number | null;
      names: [];
      sampledAt: string;
    }
  | {
      state: "unavailable";
      online: null;
      maxPlayers: number | null;
      names: [];
      lastAttemptAt?: string;
      code: PlayerSnapshotErrorCode;
      message: string;
    };
