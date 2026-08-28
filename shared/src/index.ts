export * from "./cron.js";
export * from "./modules.js";
export * from "./playerInsights.js";

export function compareVersionStrings(left?: string, right?: string) {
  if (!left || !right) return null;
  const parse = (value: string) => {
    const match = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return left === right ? 0 : null;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

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
  | "players.view"
  | "players.manage"
  | "settings.view"
  | "integrations.manage"
  | "users.view"
  | "users.manage";

/**
 * The authorization contract. Panel and web both derive their permission logic
 * from these tables, so a permission added here reaches every consumer at once.
 * `ALL_PERMISSIONS` also fixes the canonical sort order used when normalizing.
 */
export const ALL_PERMISSIONS = [
  "servers.view",
  "servers.control",
  "servers.create",
  "servers.delete",
  "servers.editSettings",
  "servers.export",
  "console.view",
  "console.command",
  "files.view",
  "files.edit",
  "files.delete",
  "files.upload",
  "files.download",
  "mods.view",
  "mods.install",
  "mods.upload",
  "mods.enableDisable",
  "mods.remove",
  "mods.update",
  "schedules.view",
  "schedules.manage",
  "players.view",
  "players.manage",
  "settings.view",
  "integrations.manage",
  "users.view",
  "users.manage"
] as const satisfies readonly Permission[];

const VIEWER_PERMISSIONS = [
  "servers.view",
  "console.view",
  "files.view",
  "mods.view",
  "schedules.view",
  "players.view",
  "settings.view"
] as const satisfies readonly Permission[];

const OPERATOR_PERMISSIONS = [
  ...VIEWER_PERMISSIONS,
  "servers.control",
  "console.command"
] as const satisfies readonly Permission[];

const MAINTAINER_PERMISSIONS = [
  ...OPERATOR_PERMISSIONS,
  "mods.install",
  "mods.upload",
  "mods.enableDisable",
  "mods.remove",
  "mods.update",
  "files.edit",
  "files.upload",
  "files.download",
  "schedules.manage"
] as const satisfies readonly Permission[];

const MANAGER_PERMISSIONS = [
  ...MAINTAINER_PERMISSIONS,
  "servers.create",
  "servers.delete",
  "servers.editSettings",
  "servers.export",
  "files.delete",
  "players.manage"
] as const satisfies readonly Permission[];

export const ROLE_PRESETS: Readonly<Record<Exclude<RolePreset, "custom">, readonly Permission[]>> = {
  viewer: VIEWER_PERMISSIONS,
  operator: OPERATOR_PERMISSIONS,
  maintainer: MAINTAINER_PERMISSIONS,
  manager: MANAGER_PERMISSIONS,
  admin: ALL_PERMISSIONS
};

/** Permissions that are implied by, and must be granted alongside, each key. */
export const PERMISSION_DEPENDENCIES: Readonly<Record<Permission, readonly Permission[]>> = {
  "servers.view": [],
  "servers.control": ["servers.view"],
  "servers.create": ["servers.view"],
  "servers.delete": ["servers.view"],
  "servers.editSettings": ["servers.view"],
  "servers.export": ["servers.view"],
  "console.view": [],
  "console.command": ["console.view"],
  "files.view": [],
  "files.edit": ["files.view"],
  "files.delete": ["files.view"],
  "files.upload": ["files.view"],
  "files.download": ["files.view"],
  "mods.view": [],
  "mods.install": ["mods.view"],
  "mods.upload": ["mods.view"],
  "mods.enableDisable": ["mods.view"],
  "mods.remove": ["mods.view"],
  "mods.update": ["mods.view"],
  "schedules.view": [],
  "schedules.manage": ["schedules.view"],
  "players.view": [],
  "players.manage": ["players.view"],
  "settings.view": [],
  "integrations.manage": ["settings.view"],
  "users.view": [],
  "users.manage": ["users.view"]
};

const permissionOrder = new Map<Permission, number>(ALL_PERMISSIONS.map((permission, index) => [permission, index]));

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && permissionOrder.has(value as Permission);
}

/**
 * The dependency closure of a grant, in `ALL_PERMISSIONS` order. Panel and browser both compare
 * normalized lists element by element, so the ordering is part of the contract, not a nicety.
 */
export function expandPermissions(permissions: readonly Permission[]): Permission[] {
  const expanded = new Set<Permission>();
  const visit = (permission: Permission) => {
    if (expanded.has(permission)) return;
    expanded.add(permission);
    for (const dependency of PERMISSION_DEPENDENCIES[permission]) visit(dependency);
  };
  for (const permission of permissions) visit(permission);
  return [...expanded].sort((left, right) => permissionOrder.get(left)! - permissionOrder.get(right)!);
}

/** `ROLE_PRESETS` is constant, so expand each preset once instead of on every comparison. */
const expandedRolePresets = (["admin", "manager", "maintainer", "operator", "viewer"] as const)
  .map((preset) => [preset, expandPermissions(ROLE_PRESETS[preset])] as const);

/** The preset a grant is exactly equivalent to, or "custom" when it matches none of them. */
export function inferRolePreset(permissions: readonly Permission[]): RolePreset {
  const expanded = expandPermissions(permissions);
  for (const [preset, presetPermissions] of expandedRolePresets) {
    if (expanded.length === presetPermissions.length
      && expanded.every((permission, index) => permission === presetPermissions[index])) {
      return preset;
    }
  }
  return "custom";
}

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

export type PublicUser = {
  id: string;
  username: string;
  rolePreset: RolePreset;
  permissions: Permission[];
  createdAt: string;
};

export type ReleaseChannel = "release" | "beta" | "alpha";

export type RuntimeVersion = {
  id: string;
  runtimeVersion: string;
  stable?: boolean;
  recommended?: boolean;
  buildId?: string;
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

export type ModCompatibilityStatus = "compatible" | "no_fabric" | "no_compatible_loader" | "no_minecraft_version" | "incompatible" | "unknown";

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
    url?: string;
    size?: number;
    hashes?: Record<string, string>;
  };
  serverSide?: string;
  clientSide?: string;
};

export type ModrinthInstallVersionStatus =
  | "recommended"
  | "compatible"
  | "version_mismatch"
  | "wrong_loader"
  | "no_installable_jar"
  | "client_only"
  | "server_support_unknown";

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

export function modUpdatePlanCounts(updates: readonly Pick<ModUpdatePlanEntry, "status">[]): ModUpdatePlan["counts"] {
  return {
    totalInstalled: updates.length,
    safeUpdates: updates.filter((entry) => entry.status === "safe_update").length,
    reviewUpdates: updates.filter((entry) => entry.status === "needs_review").length,
    blockedUpdates: updates.filter((entry) => entry.status === "blocked").length,
    upToDate: updates.filter((entry) => entry.status === "up_to_date").length,
    unknown: updates.filter((entry) => entry.status === "unknown").length
  };
}

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

/**
 * The Java runtime a Minecraft release needs, or null when the string is not a release this panel
 * manages — unparsable, or older than 1.18. Both sides read this: the panel to resolve and reject
 * versions, the browser to preview the image a new server will get. Two copies used to disagree on
 * pre-release identifiers such as `1.21-pre1`.
 */
export function javaMajorVersionForMinecraft(minecraftVersion: string): JavaMajorVersion | null {
  const trimmed = minecraftVersion.trim();
  const modern = trimmed.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:[-\w.]*)?$/);
  if (modern && Number(modern[1]) >= 26) return 25;
  const match = trimmed.match(/^1\.(\d+)(?:\.(\d+))?(?:[-\w.]*)?$/);
  if (!match) return null;
  const minor = Number(match[1]);
  const patch = Number(match[2] ?? "0");
  if (!Number.isInteger(minor) || !Number.isInteger(patch)) return null;
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  return minor >= 18 ? 17 : null;
}

/** The image a server runs on when nobody has pinned one. */
export function defaultDockerImageForMinecraftVersion(minecraftVersion?: string) {
  return `eclipse-temurin:${javaMajorVersionForMinecraft(minecraftVersion ?? "") ?? 21}-jre`;
}

export type ServerRuntimeProfile = {
  minecraftVersion: string;
  runtimeType: ServerRuntimeType;
  runtimeVersion: string;
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

/**
 * The lifecycle actions a schedule step can perform. Additive by design: a panel that does not know
 * a procedure refuses the schedule rather than misreading it, and stored steps are JSON, so adding
 * one needs no migration.
 */
export type ScheduleProcedure = "restart" | "stop" | "start";

export type ScheduleStep =
  | { type: "command"; command: string; delaySeconds: number }
  | { type: "action"; procedure: ScheduleProcedure; delaySeconds: number };

export type ScheduledRunStepDetails = {
  stepIndex: number;
  type: "command" | "action";
  command?: string;
  procedure?: ScheduleProcedure;
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
  waitForPlayersToLeave: boolean;
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

export type NodeType = "local" | "remote";

export type NodeStatus = "online" | "offline" | "unknown";

/**
 * The panel-to-node wire protocol version. The panel refuses commands from a node
 * reporting anything else, and the web treats a mismatch as "node update required",
 * so both sides have to read the same constant or a version bump silently marks
 * every healthy node as unusable in the UI.
 */
export const NODE_PROTOCOL_VERSION = "3.1";

export type RestartPhase = "stopping" | "starting";

export type RestartRequiredModSnapshot = {
  identity: string;
  displayName: string;
  filename: string;
  enabled: boolean;
  sha1: string;
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

/**
 * Node fields common to the panel's stored record and the API projection. The
 * panel adds its credential hashes on top (see ManagedNode in the server
 * package); PublicNode below is what clients actually receive.
 */
export type ManagedNodeCore = {
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
  features?: string[];
  dockerStatus?: string;
  dataPathStatus?: string;
  totalMemory?: number;
  joinTokenExpiresAt?: string;
};

/** Where a node self-update stopped. `reconnect` is recorded by the panel, the rest by the node. */
export type NodeUpdateFailureStage = "pull" | "create" | "start" | "verify" | "session" | "cleanup" | "reconnect";

/**
 * The outcome of the last node update that did not finish. The node reports its own failures on the
 * next handshake; the panel records one itself when a node never reconnects with the updated agent.
 */
export type NodeUpdateFailure = {
  at: string;
  stage: NodeUpdateFailureStage;
  message: string;
  image?: string;
  /** Whether the node container that was running before the attempt is running again under its own name. */
  recovered?: boolean;
  containerName?: string;
};

/** A managed node exactly as the panel API serializes it. */
export type PublicNode = ManagedNodeCore & {
  hasPendingJoinToken?: boolean;
  /** Whether page-visit notifications should include available updates for this node. */
  updateNotificationsEnabled?: boolean;
  /** Set while the last update attempt is unresolved; cleared on a successful update or by dismissal. */
  lastUpdateFailure?: NodeUpdateFailure;
};

/**
 * Server fields common to the panel's stored record and the API projection. The
 * panel adds node-local filesystem details on top (see ManagedServer in the
 * server package) which are deliberately withheld from clients.
 */
export type ManagedServerCore = {
  id: string;
  nodeId: string;
  displayName: string;
  storageName?: string;
  runtimeProfile: ServerRuntimeProfile;
  dockerContainer?: string;
  dockerImage?: string;
  dockerPorts?: string;
  managedPorts?: ManagedServerPort[];
  javaArgs?: string;
  startOnNodeStart?: boolean;
  runtimeIntent?: RuntimeIntent;
  restartPhase?: RestartPhase;
  crashAttemptTimestamps?: string[];
  crashNextRetryAt?: string;
  crashLoopSince?: string;
  crashStableSince?: string;
  restartRequiredSince?: string;
  restartRequiredChanges?: RestartRequiredChange[];
  restartRequiredModBaseline?: RestartRequiredModSnapshot[];
  schedules?: ScheduledExecution[];
  createdAt: string;
  updatedAt: string;
};

export type ServerRuntimeIssue = {
  code: "port_conflict";
  message: string;
  port: number;
  protocol: "tcp" | "udp";
  conflictingServerId: string;
  conflictingServerName: string;
};

/** A managed server exactly as the panel API serializes it. */
export type PublicServer = ManagedServerCore & {
  directoryLabel: string;
  hasDockerContainer: boolean;
  nodeName?: string;
  resolvedVersions?: ResolvedServerVersions;
  /** Configuration problems that must be fixed before this server can start. */
  runtimeIssues?: ServerRuntimeIssue[];
};

export type NodeInstallInstructions = {
  image: string;
  protocolVersion: string;
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
      SERVERSENTINEL_DATA_DIR: string;
      SERVERSENTINEL_DOCKER_DATA_DIR: string;
      TZ: string;
      SS_NODE_NAME?: string;
      SS_JOIN_TOKEN?: string;
    };
    volumes: string[];
  };
  dockerRun: string;
};

export type CreateNodeResponse = {
  node: PublicNode;
  joinToken: string;
  expiresAt: string;
  install: NodeInstallInstructions;
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
};

export type ConsoleSource = "logs/latest.log" | "docker" | "operations" | "schedules";

/**
 * A console line as the panel numbered it. Sequence numbers are assigned once, where the workload's
 * output enters the panel, so every viewer of a server sees the same line under the same number.
 * That is what lets a viewer resume with "everything after 4210" instead of comparing text against
 * the buffer it already holds.
 */
export type ConsoleLine = {
  seq: number;
  text: string;
};

/**
 * Identifies one continuous run of a server's console buffer. Sequence numbers only mean anything
 * within an epoch: when the panel restarts, or a buffer is evicted and rebuilt, the new epoch tells
 * viewers their sequence numbers no longer refer to anything and the console has to be redrawn.
 */
export type ConsoleEpoch = string;

export type ConsoleBacklog = {
  epoch: ConsoleEpoch;
  lines: ConsoleLine[];
  /** The sequence a viewer should ask for next. Holds even when `lines` is empty. */
  nextSeq: number;
  /** Set when the requested sequence had already left the retained window, so lines were skipped. */
  truncated: boolean;
};

export type ConsoleStreamFrame =
  | ({ type: "backlog" } & ConsoleBacklog)
  | { type: "log"; epoch: ConsoleEpoch; lines: ConsoleLine[] }
  | { type: "truncated"; message: string; droppedFrames?: number; at?: string }
  | { type: "unavailable"; message: string; code?: string; retryable?: boolean }
  | { type: "empty"; message?: string }
  | { type: "status"; status?: unknown }
  | { type: "heartbeat"; at?: string };

export type ServerEvent = {
  id: string;
  eventType:
    | "server_started"
    | "server_stopped"
    | "server_restarted"
    | "player_joined"
    | "player_left"
    | "automation_run"
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
  source: ConsoleSource;
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

export type ServerStorageSummary = {
  worldSizeBytes: number | null;
  totalBytes: number | null;
  availableBytes: number | null;
};

export type ServerTimelineEvent = ServerEvent & {
  occurredAt: number;
};

export type ServerTimelineScheduleMarker = {
  id: string;
  scheduleId: string;
  scheduleName: string;
  occurredAt: number;
  // The timeline viewport is clamped to the present, so every marker describes a run that already
  // started. Runs that have not happened yet are listed on the Schedules panel instead.
  kind: "run" | "active";
  status: "success" | "failed" | "skipped" | "cancelled" | "running" | "unknown";
  runId?: string;
  message?: string;
};

export type ServerTimelinePlayerSession = {
  id: string;
  player: string;
  startedAt: number;
  endedAt: number | null;
  startBoundary: "join" | "history-boundary";
  endBoundary: "leave" | "server-end" | "online" | "history-boundary";
};

export type ServerTimelinePlayerActivity = {
  snapshotState: PlayerSnapshot["state"];
  sampledAt?: string;
  onlineNames: string[];
  sessions: ServerTimelinePlayerSession[];
};

export type ServerTimelineResponse = {
  from: number;
  to: number;
  generatedAt: string;
  latest?: ServerTimelineResourcePoint;
  samples: ServerTimelineResourcePoint[];
  events: ServerTimelineEvent[];
  schedules: ServerTimelineScheduleMarker[];
  playerActivity?: ServerTimelinePlayerActivity;
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

/**
 * Export/import contract.
 *
 * Schema 4 replaced the base64-in-JSON artifact with a ZIP that carries `manifest.json` beside the
 * real files. Schema 3 could only ever describe a handful of small configuration files, so there is
 * no upgrade path worth writing: a schema-3 artifact is rejected and has to be recreated.
 */
export const EXPORT_SCHEMA_VERSION = 4;
export const EXPORT_MANIFEST_ENTRY = "manifest.json";
export const EXPORT_ARTIFACT_TYPE = "serversentinel.export";

/**
 * What an operator can choose to take with them. `content` and `panelSettings` are not directories:
 * content resolves to the runtime's own mods/plugins folder, and panel settings are database rows.
 */
export const EXPORT_CATEGORIES = [
  "serverConfig",
  "accessControl",
  "modConfig",
  "content",
  "world",
  "panelSettings",
  "logs"
] as const;

export type ExportCategory = typeof EXPORT_CATEGORIES[number];

/**
 * Mods are the one category with a real size/robustness tradeoff, so it gets a strategy rather than
 * a plain checkbox. `lockfile` records the Modrinth version and re-downloads on import; `jars` ships
 * the bytes. Lockfile exports still fall back to shipping any jar that Modrinth cannot identify.
 */
export type ExportContentStrategy = "lockfile" | "jars";

export type ExportSelection = {
  categories: ExportCategory[];
  contentStrategy: ExportContentStrategy;
};

export const EXPORT_DEFAULT_CATEGORIES: readonly ExportCategory[] = [
  "serverConfig",
  "accessControl",
  "modConfig",
  "content",
  "panelSettings"
];

export type ExportCategoryDescriptor = {
  key: ExportCategory;
  label: string;
  description: string;
  /** Content and world are the two that can dominate an artifact's size. */
  sizable: boolean;
};

export const EXPORT_CATEGORY_DESCRIPTORS: readonly ExportCategoryDescriptor[] = [
  {
    key: "serverConfig",
    label: "Server configuration",
    description: "server.properties and the recorded runtime version",
    sizable: false
  },
  {
    key: "accessControl",
    label: "Access control",
    description: "Whitelist, operators, banned players and IPs",
    sizable: false
  },
  {
    key: "modConfig",
    label: "Mod and plugin configs",
    description: "The config and defaultconfigs folders",
    sizable: true
  },
  {
    key: "content",
    label: "Mods and plugins",
    description: "Installed content, as a Modrinth lockfile or the jars themselves",
    sizable: true
  },
  {
    key: "world",
    label: "World",
    description: "Every world folder, including datapacks. Usually most of the archive.",
    sizable: true
  },
  {
    key: "panelSettings",
    label: "Panel settings",
    description: "Schedules, ports, Java arguments, and update channels",
    sizable: false
  },
  {
    key: "logs",
    label: "Logs and crash reports",
    description: "Useful for support, never needed to run the server",
    sizable: true
  }
];

export type ExportSizeCategoryEstimate = {
  category: ExportCategory;
  bytes: number;
  fileCount: number;
};

export type ExportSizeServerEstimate = {
  serverId: string;
  displayName: string;
  running: boolean;
  categories: ExportSizeCategoryEstimate[];
  totalBytes: number;
};

export type ExportSizeEstimate = {
  servers: ExportSizeServerEstimate[];
  totalBytes: number;
  /** Free space on the panel volume that holds export artifacts, when the platform reports it. */
  availableBytes?: number;
  /** Opaque, short-lived handle that lets the matching export reuse this filesystem inventory. */
  inventoryId?: string;
};

export type ExportLockfileEntry = {
  filename: string;
  enabled: boolean;
  projectId: string;
  versionId: string;
  versionNumber: string;
  channel: string;
  /** Present when known; import verifies the re-downloaded jar against it. */
  sha1?: string;
};

export type ImportIssue = {
  code: string;
  message: string;
  serverName?: string;
  path?: string;
};

export type ImportPlanServer = {
  sourceId: string;
  newId: string;
  displayName: string;
  storageName: string;
  serverDir: string;
  fileCount: number;
  totalBytes: number;
  lockfileCount: number;
  portConflicts: ImportIssue[];
};

export type ImportValidationResult = {
  valid: boolean;
  issues: ImportIssue[];
  warnings: ImportIssue[];
  plan: {
    targetNodeId: string;
    categories: ExportCategory[];
    servers: ImportPlanServer[];
  };
};
