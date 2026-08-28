import type { FastifyInstance } from "fastify";
import { moduleAccessStates, moduleDescriptor, type ModuleAccessState, type ModuleId } from "@serversentinel/contracts";
import { throwHttp } from "../http/errors.js";
import type { Permission, StoredUser } from "../types.js";
import type { StorageDatabase } from "../storage/database.js";
import { readDisabledModules, writeDisabledModules } from "./moduleSettings.js";

/**
 * The optional work a module performs on its own, away from any request: pollers, timers, queues.
 * `start` and `stop` are called when the module is switched on or off, so a disabled module costs
 * an installation nothing beyond the code sitting unused in the image.
 */
export type ModuleRuntime = {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
};

/**
 * The panel's authority on which optional features exist and which are switched on.
 *
 * Adding a module means adding its descriptor to the shared catalog and, here, at most two calls:
 * `registerRoutes` for its endpoints and `registerRuntime` for its background work. Nothing else in
 * the application has to learn about it.
 */
export class ModuleRegistry {
  private readonly disabled: Set<ModuleId>;
  private readonly runtimes = new Map<ModuleId, ModuleRuntime>();
  private readonly running = new Set<ModuleId>();
  /** Set once the boot-time start has run, so a runtime registered later is not left dormant. */
  private started = false;
  /** Serializes every state change; two administrators toggling at once must not interleave. */
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: StorageDatabase,
    private readonly options: { onRuntimeError?(error: unknown, id: ModuleId, phase: "start" | "stop"): void } = {}
  ) {
    this.disabled = readDisabledModules(storage);
  }

  /** The operator's setting, which is what Settings shows and what survives a restart. */
  isEnabled(id: ModuleId) {
    return !this.disabled.has(id);
  }

  /**
   * Whether the module can actually answer for itself: switched on, and — where it has background
   * work — that work running. The two differ only when a runtime failed to start, which is exactly
   * the case where its endpoints must refuse rather than answer from a half-built module.
   */
  isServing(id: ModuleId) {
    return this.isEnabled(id) && (!this.runtimes.has(id) || this.running.has(id));
  }

  /** Module state as one user sees it. Callers without a user get the installation view only. */
  states(user?: Pick<StoredUser, "permissions"> | null): ModuleAccessState[] {
    const granted = new Set<Permission>(user?.permissions ?? []);
    return moduleAccessStates({
      isEnabled: (id) => this.isEnabled(id),
      isServing: (id) => this.isServing(id),
      hasPermission: (permission) => granted.has(permission)
    });
  }

  /**
   * Registering after `startEnabled` is legitimate — wiring order is not the module's business —
   * so a late runtime is started straight away rather than silently sitting dormant until the next
   * toggle, which is the kind of bug that only shows up as "the poll never ran on this install".
   */
  registerRuntime(id: ModuleId, runtime: ModuleRuntime) {
    this.runtimes.set(id, runtime);
    if (this.started && this.isEnabled(id)) {
      this.pending = this.pending.then(() => this.startRuntime(id).catch(() => undefined));
    }
  }

  /** Starts the background work of every module that is switched on. Called once, after wiring. */
  async startEnabled() {
    this.started = true;
    for (const id of this.runtimes.keys()) {
      // Boot continues even when one module cannot start: the rest of the panel is not its hostage,
      // and `isServing` keeps the failed module's endpoints closed until it is switched off and on.
      if (this.isEnabled(id)) await this.startRuntime(id).catch(() => undefined);
    }
  }

  /**
   * Route guards read `isEnabled` per request, so endpoints follow the flag the moment it moves.
   * Only the background work has to be told, which is what keeps a toggle from needing a restart.
   *
   * The order matters and is not symmetric. A module whose runtime builds the services its own
   * routes call would answer a request with a half-built module if the flag moved first, so the
   * runtime is started before the endpoints open and stopped after they have closed.
   */
  async setEnabled(id: ModuleId, enabled: boolean) {
    const change = this.pending.then(async () => {
      if (this.isEnabled(id) === enabled && this.isServing(id) === enabled) return this.states();
      if (enabled) {
        // Nothing is written until the runtime is up. A module that cannot start stays off, and the
        // caller is told why, rather than the panel recording an enabled module that does not work.
        await this.startRuntime(id);
        this.disabled.delete(id);
      } else {
        this.disabled.add(id);
      }
      writeDisabledModules(this.storage, this.disabled);
      if (!enabled) await this.stopRuntime(id);
      return this.states();
    });
    // A failed change must not poison the queue for the next one.
    this.pending = change.catch(() => undefined);
    return change;
  }

  async stopAll() {
    await this.pending.catch(() => undefined);
    for (const id of [...this.running]) await this.stopRuntime(id);
  }

  /**
   * Registers a module's endpoints inside their own Fastify scope, behind a guard that refuses
   * every one of them while the module is off. Encapsulation is what makes this safe to extend: a
   * route added to the module later inherits the guard instead of having to remember it.
   */
  async registerRoutes(app: FastifyInstance, id: ModuleId, register: (scope: FastifyInstance) => void) {
    await app.register(async (scope) => {
      scope.addHook("onRequest", async () => {
        if (this.isServing(id)) return;
        const label = moduleDescriptor(id).label;
        if (this.isEnabled(id)) {
          throwHttp(503, `The ${label} module is not running. Check the panel log, then switch it off and on again.`, { code: "MODULE_UNAVAILABLE" });
        }
        throwHttp(403, `The ${label} module is disabled for this installation.`, { code: "MODULE_DISABLED" });
      });
      register(scope);
    });
  }

  /** Rejects when the module's background work could not start; the caller decides what that means. */
  private async startRuntime(id: ModuleId) {
    const runtime = this.runtimes.get(id);
    if (!runtime || this.running.has(id)) return;
    this.running.add(id);
    try {
      await runtime.start();
    } catch (error) {
      this.running.delete(id);
      this.options.onRuntimeError?.(error, id, "start");
      // Best effort: a runtime that threw partway through may still hold what it managed to build.
      try {
        await runtime.stop();
      } catch {
        // Already reported; the start failure is the one worth surfacing.
      }
      throw error;
    }
  }

  private async stopRuntime(id: ModuleId) {
    const runtime = this.runtimes.get(id);
    if (!runtime || !this.running.has(id)) return;
    this.running.delete(id);
    try {
      await runtime.stop();
    } catch (error) {
      this.options.onRuntimeError?.(error, id, "stop");
    }
  }
}
