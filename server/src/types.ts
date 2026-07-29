import type {
  FileEditLease as PublicFileEditLease,
  ManagedNodeCore,
  ManagedServerCore,
  Permission,
  ReleaseChannel,
  RolePreset
} from "@serversentinel/contracts";

export type {
  CreateNodeResponse,
  JavaMajorVersion,
  ManagedServerPort,
  ModCompatibility,
  ModCompatibilityStatus,
  ModrinthInstallVersionStatus,
  ModUpdatePlan,
  ModUpdatePlanEntry,
  ModUpdatePlanStatus,
  NodeInstallInstructions,
  NodeStatus,
  NodeType,
  OperationRecord,
  OperationStatus,
  OperationType,
  Permission,
  PlayerSnapshot,
  PlayerSnapshotErrorCode,
  PublicNode,
  PublicServer,
  PublicUser,
  ReleaseChannel,
  ResolvedServerVersions,
  RestartPhase,
  RestartRequiredChange,
  RestartRequiredModSnapshot,
  RolePreset,
  RuntimeVersion,
  SafeBatchUpdateResult,
  ScheduleStep,
  ScheduledActiveRun,
  ScheduledExecution,
  ScheduledRun,
  ScheduledRunDetails,
  ScheduledRunStepDetails,
  ServerActivity,
  ServerEvent,
  ServerTimelineEvent,
  ServerTimelinePlayerActivity,
  ServerTimelinePlayerSession,
  ServerTimelineResourcePoint,
  ServerTimelineScheduleMarker,
  ServerRuntimeProfile,
  ServerRuntimeType
} from "@serversentinel/contracts";

export type AppSettings = {
  modrinthApiKey?: string;
  playerHeadsEnabled: boolean;
  playerHeadsOnboardingCompleted: boolean;
};

export type StoredUser = {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  rolePreset: RolePreset;
  permissions: Permission[];
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

export type FileEditLease = PublicFileEditLease & {
  sessionId: string;
};

/**
 * The stored node record: the shared wire contract plus the credential hashes
 * that must never leave the panel. PublicNode is the projection clients see.
 */
export type ManagedNode = ManagedNodeCore & {
  secretHash?: string;
  joinTokenHash?: string;
};

/**
 * The stored server record: the shared wire contract plus the node-local
 * filesystem details that must never leave the panel. PublicServer is the
 * projection clients see.
 */
export type ManagedServer = ManagedServerCore & {
  serverDir: string;
  dockerMountSource?: string;
  dockerWorkingDir?: string;
};

export type DockerState = "running" | "exited" | "created" | "paused" | "restarting" | "removing" | "dead" | "unknown";
