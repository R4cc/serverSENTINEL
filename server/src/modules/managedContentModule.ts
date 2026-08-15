import type { ModuleRuntime } from "./moduleRegistry.js";

export const modUpdateCheckIntervalMs = 60 * 60 * 1000;

/**
 * The managed-content module's background work: the periodic Modrinth update check.
 *
 * The coordinator, and the plan cache behind it, are built inside `start` rather than at boot. An
 * installation that does not manage mods or plugins therefore never opens the cache, never holds a
 * poll timer, and never reaches Modrinth — which is the difference between a module being switched
 * off and merely being hidden.
 *
 * `stop` drops the coordinator as well as cancelling it, so the services it published are gone
 * while the module is off and a later `start` builds them again from the current configuration.
 * Nothing it touches is destructive: installed jars, the plan cache rows, and the servers' own
 * files are untouched by either call.
 */
export function createManagedContentModuleRuntime<Coordinator extends { start(): void; stop(): void }>(deps: {
  createCoordinator(): Coordinator;
  publish(coordinator: Coordinator | undefined): void;
}): ModuleRuntime {
  let coordinator: Coordinator | undefined;

  return {
    start() {
      if (coordinator) return;
      coordinator = deps.createCoordinator();
      deps.publish(coordinator);
      coordinator.start();
    },
    stop() {
      const running = coordinator;
      coordinator = undefined;
      deps.publish(undefined);
      running?.stop();
    }
  };
}
