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
  let generation = 0;
  const pendingTicks = new Set<Promise<void>>();

  function scheduleNextTick(epoch: number) {
    timer = setTimeout(async () => {
      if (stopped || epoch !== generation) return;
      timer = undefined;
      let pending: Promise<void> | undefined;
      try {
        pending = deps.tick();
        pendingTicks.add(pending);
        await pending;
      } catch (error: unknown) {
        deps.onError(error);
      } finally {
        if (pending) pendingTicks.delete(pending);
        if (!stopped && epoch === generation) scheduleNextTick(epoch);
      }
    }, intervalMs);
    timer.unref();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      scheduleNextTick(++generation);
    },
    async stop() {
      stopped = true;
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await Promise.allSettled([...pendingTicks]);
    }
  };
}
