import type {
  Permission,
  ReleaseChannel,
  ResolvedServerVersions,
  RestartRequiredChange,
  RolePreset,
  RuntimeIntent,
  ScheduledExecution,
  ServerAccess,
  ServerRuntimeProfile
} from "@serversentinel/contracts";

export type {
  JavaMajorVersion,
  LoaderType,
  OperationRecord,
  OperationStatus,
  OperationType,
  Permission,
  PlayerSnapshot,
  PlayerSnapshotErrorCode,
  PublicUser,
  ReleaseChannel,
  ResolvedServerVersions,
  RestartRequiredChange,
  RestartRequiredModAction,
  RolePreset,
  RuntimeCompatibilityStatus,
  RuntimeIntent,
  RuntimeLifecycleStatus,
  ScheduleStep,
  ScheduledActiveRun,
  ScheduledExecution,
  ScheduledRun,
  ScheduledRunDetails,
  ScheduledRunStepDetails,
  ServerAccess,
  ServerActivity,
  ServerEvent,
  ServerTimelineEvent,
  ServerTimelinePlayerActivity,
  ServerTimelinePlayerSession,
  ServerTimelineResourcePoint,
  ServerTimelineResponse,
  ServerTimelineScheduleMarker,
  ServerJarProviderId,
  ServerRuntimeProfile,
  ServerRuntimeType,
  VersionResolution,
  VersionSource
} from "@serversentinel/contracts";

export type AppSettings = {
  modrinthApiKey?: string;
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

export type Session = {
  id: string;
  userId: string;
  createdAt: string;
};

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

export type RestartRequiredModSnapshot = {
  identity: string;
  displayName: string;
  filename: string;
  enabled: boolean;
  sha1: string;
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
  all_project_types?: string[];
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
  features?: string[];
  dockerStatus?: string;
  dataPathStatus?: string;
  totalMemory?: number;
  secretHash?: string;
  joinTokenHash?: string;
  joinTokenExpiresAt?: string;
};

export type PublicNode = Omit<ManagedNode, "secretHash" | "joinTokenHash"> & {
  hasPendingJoinToken?: boolean;
  protocolMode?: "current" | "fallback" | "update-only" | "incompatible";
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

export type RestartPhase = "stopping" | "starting";

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

export type PublicServer = Omit<ManagedServer, "serverDir" | "dockerMountSource" | "dockerWorkingDir"> & {
  directoryLabel: string;
  hasDockerContainer: boolean;
  nodeName?: string;
  resolvedVersions?: ResolvedServerVersions;
};

export type DockerState = "running" | "exited" | "created" | "paused" | "restarting" | "removing" | "dead" | "unknown";
