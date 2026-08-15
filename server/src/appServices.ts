import type { FastifyBaseLogger } from "fastify";
import { PanelNodeConnections } from "./nodes/panelConnections.js";
import type { NodeRuntimeRegistry } from "./nodes/registry.js";
import type { NodeRuntime } from "./nodes/types.js";
import type { ManagedServer } from "./types.js";
import type { RemoteObservationCoordinator } from "./nodes/observationCoordinator.js";
import type { ModUpdatePlanCoordinator } from "./modrinth/updatePlanCoordinator.js";
import type { OperationService } from "./operations/operationService.js";
import type { ExportArtifactMaintenance } from "./exportArtifactMaintenance.js";
import type { ExportCoordinator } from "./exportCoordinator.js";
import type { PlayerHeadService } from "./playerHeadService.js";
import type { PlayerSnapshotCoordinator } from "./playerSnapshots.js";
import type { ResourceStatsCollector } from "./resourceStatsCollector.js";
import type { RuntimeStateCoordinator } from "./runtimeStateCoordinator.js";
import type { TimelineEventCollector } from "./timelineEventCollector.js";
import type { StorageDatabase } from "./storage/database.js";
import type { UsersRepository } from "./storage/usersRepository.js";
import type { NodesRepository } from "./storage/nodesRepository.js";
import type { SettingsRepository } from "./storage/settingsRepository.js";
import type { PlayerHeadCacheRepository } from "./storage/playerHeadCacheRepository.js";
import type { SessionsRepository } from "./storage/sessionsRepository.js";
import type { ServersRepository } from "./storage/serversRepository.js";
import type { FileEditLeasesRepository } from "./storage/fileEditLeasesRepository.js";
import type { ResourceStatsRepository } from "./storage/resourceStatsRepository.js";
import type { TimelineEventsRepository } from "./storage/timelineEventsRepository.js";
import type { ModPreferencesRepository } from "./storage/modPreferencesRepository.js";
import type { OperationsRepository } from "./storage/operationsRepository.js";

/**
 * Singletons created while the Fastify instance boots (see buildApp in app.ts)
 * and consumed by the domain service modules. Repositories are assigned before
 * any route can run, so they are typed as always present; collectors and
 * coordinators stay optional because panel-only mode never constructs them.
 */
interface AppServices {
  usersRepository: UsersRepository;
  nodesRepository: NodesRepository;
  settingsRepository: SettingsRepository;
  playerHeadCacheRepository: PlayerHeadCacheRepository;
  playerHeadService: PlayerHeadService;
  sessionsRepository: SessionsRepository;
  serversRepository: ServersRepository;
  fileEditLeasesRepository: FileEditLeasesRepository;
  modPreferencesRepository: ModPreferencesRepository;
  operationsRepository: OperationsRepository;
  operationService: OperationService;
  exportArtifactMaintenance: ExportArtifactMaintenance;
  exportCoordinator: ExportCoordinator;
  storageDatabase: StorageDatabase;
  modUpdatePlanCoordinator: ModUpdatePlanCoordinator;
  resourceStatsRepository: ResourceStatsRepository;
  timelineEventsRepository: TimelineEventsRepository;
  appLogger: FastifyBaseLogger | undefined;
  runtimeRegistry: NodeRuntimeRegistry | undefined;
  resourceStatsCollector: ResourceStatsCollector | undefined;
  timelineEventCollector: TimelineEventCollector | undefined;
  runtimeStateCoordinator: RuntimeStateCoordinator | undefined;
  playerSnapshotCoordinator: PlayerSnapshotCoordinator | undefined;
  remoteObservationCoordinator: RemoteObservationCoordinator | undefined;
}

export const services = {} as AppServices;

/** Live panel-side websocket connections to remote nodes; survives app rebuilds. */
export const panelNodeConnections = new PanelNodeConnections();

export function runtimeForServer(server: ManagedServer): NodeRuntime {
  if (!services.runtimeRegistry) {
    throw new Error("Node runtime registry is not initialized");
  }
  return services.runtimeRegistry.forServer(server);
}

export function runtimeForNodeId(nodeId: string): NodeRuntime {
  if (!services.runtimeRegistry) {
    throw new Error("Node runtime registry is not initialized");
  }
  return services.runtimeRegistry.forNodeId(nodeId);
}
