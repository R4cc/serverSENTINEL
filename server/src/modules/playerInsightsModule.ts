import type { ModuleRuntime } from "./moduleRegistry.js";

/**
 * The Player Insights module's background work.
 *
 * Both halves are built inside `start`: the GeoLite2 database — loading whatever is on disk and
 * keeping it current — and the collector that turns a login line into a location. An installation
 * that switches this module off therefore holds no MMDB in memory, makes no request to MaxMind,
 * and never reads a player's address at all. That is the difference this module has to make, since
 * "switched off" here is a privacy promise and not only a hidden page.
 *
 * `stop` drops both, so the services the routes reach through are gone while the module is off and
 * a later `start` rebuilds them from the current configuration. Nothing stored is touched: the
 * geography already derived survives, and the module resumes from it.
 */
export type PlayerInsightsRuntimeServices<Database, Collector> = {
  geoDatabase: Database;
  collector: Collector;
};

export function createPlayerInsightsModuleRuntime<
  Database extends { start(): Promise<void> | void; stop(): void },
  Collector extends { start(): void; stop(): void }
>(deps: {
  create(): PlayerInsightsRuntimeServices<Database, Collector>;
  publish(services: PlayerInsightsRuntimeServices<Database, Collector> | undefined): void;
  onError?(error: unknown): void;
}): ModuleRuntime {
  let running: PlayerInsightsRuntimeServices<Database, Collector> | undefined;

  return {
    async start() {
      if (running) return;
      const services = deps.create();
      running = services;
      deps.publish(services);
      // A database that cannot be loaded or downloaded is not a reason to refuse the module: the
      // workspace still reports who is online and when they play, and says plainly that geography
      // is unavailable. Only an outright throw would leave the module half-built.
      await Promise.resolve(services.geoDatabase.start()).catch((error: unknown) => deps.onError?.(error));
      services.collector.start();
    },
    stop() {
      const services = running;
      running = undefined;
      deps.publish(undefined);
      services?.collector.stop();
      services?.geoDatabase.stop();
    }
  };
}
