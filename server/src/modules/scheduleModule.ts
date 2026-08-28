import type { ModuleRuntime } from "./moduleRegistry.js";

export const schedulePollIntervalMs = 30_000;

/**
 * The schedules module's background work: the poll that decides which schedules are due.
 *
 * It reschedules itself only after a tick settles, so a slow tick cannot overlap the next one, and
 * a failing tick keeps polling rather than leaving every schedule stranded. Switching the module
 * off cancels the pending timer; runs already in flight are left to finish, because interrupting a
 * schedule midway through a restart would leave the server in the state the operator least expects.
 */
export function createScheduleModuleRuntime(deps: {
  tick(): Promise<void>;
  onError(error: unknown): void;
  intervalMs?: number;
}): ModuleRuntime {
  const intervalMs = deps.intervalMs ?? schedulePollIntervalMs;
  let timer: NodeJS.Timeout | undefined;
  let stopped = true;

  function scheduleNextTick() {
    timer = setTimeout(async () => {
      timer = undefined;
      try {
        await deps.tick();
      } catch (error: unknown) {
        deps.onError(error);
      } finally {
        if (!stopped) scheduleNextTick();
      }
    }, intervalMs);
    timer.unref();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      scheduleNextTick();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    }
  };
}
