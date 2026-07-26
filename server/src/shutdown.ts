type ShutdownLogger = {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
};

const shutdownSignals = ["SIGTERM", "SIGINT"] as const;

/**
 * Container runtimes stop serverSENTINEL with SIGTERM, and Node's default
 * handling terminates the process outright. That skips every registered
 * teardown step: in-flight requests are cut mid-reply, background pollers keep
 * their timers, and the SQLite handle closes without a WAL checkpoint. Draining
 * through `close` first keeps both the HTTP surface and the data root
 * consistent, and the timeout guarantees the container still stops if a
 * teardown step hangs.
 */
export function registerShutdownHandlers(
  close: () => Promise<void>,
  options: { logger: ShutdownLogger; timeoutMs?: number }
) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    options.logger.info({ signal }, "Shutting down serverSENTINEL");
    const timer = setTimeout(() => {
      options.logger.error({ signal, timeoutMs }, "Shutdown did not finish in time; exiting anyway");
      process.exit(1);
    }, timeoutMs);
    timer.unref();
    try {
      await close();
      clearTimeout(timer);
      process.exit(0);
    } catch (error) {
      clearTimeout(timer);
      options.logger.error(
        { signal, errorDetails: error instanceof Error ? error.message : String(error) },
        "Shutdown failed"
      );
      process.exit(1);
    }
  };

  for (const signal of shutdownSignals) {
    process.once(signal, () => void shutdown(signal));
  }
}
