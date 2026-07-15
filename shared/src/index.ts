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

export type ScheduleStep =
  | { type: "command"; command: string; delaySeconds: number }
  | { type: "action"; procedure: "restart"; delaySeconds: number };

export type ScheduledRunDetails = {
  stepCount: number;
  completedStepCount: number;
  terminalStepIndex?: number;
  terminalStep?: string;
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
  waitingDelayMinutes?: number;
  message?: string;
};

export type ScheduledExecution = {
  id: string;
  name: string;
  cron: string;
  steps: ScheduleStep[];
  commands?: string[];
  commandDelaysSeconds?: number[];
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
  fabricLoaderVersion: VersionResolution;
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
  playerNames?: string[];
};
