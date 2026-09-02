import type { ModuleRuntime } from "./moduleRegistry.js";

/**
 * The Player Insights module's background work.
 *
 * All services are built inside `start`: the GeoLite2 database, the collector that turns a login
 * line into a location, and the in-memory collector that matches that login to a live TCP RTT.
 * An installation that switches this module off therefore holds no MMDB or player endpoints in
 * memory, makes no request to MaxMind, and does not inspect player sockets.
 *
 * `stop` drops all three, so the services the routes reach through are gone while the module is off and
 * a later `start` rebuilds them from the current configuration. Nothing stored is touched: the
 * geography already derived survives, and the module resumes from it.
 */
export type PlayerInsightsRuntimeServices<Database, Collector, PingCollector = Collector> = {
  geoDatabase: Database;
  collector: Collector;
  pingCollector?: PingCollector;
};

export function createPlayerInsightsModuleRuntime<
  Database extends { start(): Promise<void> | void; stop(): void },
  Collector extends { start(): void; stop(): void },
  PingCollector extends { start(): void; stop(): void } = Collector
>(deps: {
  create(): PlayerInsightsRuntimeServices<Database, Collector, PingCollector>;
  publish(services: PlayerInsightsRuntimeServices<Database, Collector, PingCollector> | undefined): void;
  onError?(error: unknown): void;
}): ModuleRuntime {
  let running: PlayerInsightsRuntimeServices<Database, Collector, PingCollector> | undefined;

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
      if (running !== services) return;
      services.pingCollector?.start();
      services.collector.start();
    },
    stop() {
      const services = running;
      running = undefined;
      deps.publish(undefined);
      services?.collector.stop();
      services?.pingCollector?.stop();
      services?.geoDatabase.stop();
    }
  };
}
