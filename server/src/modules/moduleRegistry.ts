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

  constructor(
    private readonly storage: StorageDatabase,
    private readonly options: { onRuntimeError?(error: unknown, id: ModuleId, phase: "start" | "stop"): void } = {}
  ) {
    this.disabled = readDisabledModules(storage);
  }

  isEnabled(id: ModuleId) {
    return !this.disabled.has(id);
  }

  /** Module state as one user sees it. Callers without a user get the installation view only. */
  states(user?: Pick<StoredUser, "permissions"> | null): ModuleAccessState[] {
    const granted = new Set<Permission>(user?.permissions ?? []);
    return moduleAccessStates({
      isEnabled: (id) => this.isEnabled(id),
      hasPermission: (permission) => granted.has(permission)
    });
  }

  registerRuntime(id: ModuleId, runtime: ModuleRuntime) {
    this.runtimes.set(id, runtime);
  }

  /** Starts the background work of every module that is switched on. Called once, after wiring. */
  async startEnabled() {
    for (const id of this.runtimes.keys()) {
      if (this.isEnabled(id)) await this.startRuntime(id);
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
    if (this.isEnabled(id) === enabled) return this.states();
    if (enabled) await this.startRuntime(id);
    if (enabled) this.disabled.delete(id);
    else this.disabled.add(id);
    writeDisabledModules(this.storage, this.disabled);
    if (!enabled) await this.stopRuntime(id);
    return this.states();
  }

  async stopAll() {
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
        if (this.isEnabled(id)) return;
        throwHttp(403, `The ${moduleDescriptor(id).label} module is disabled for this installation.`, { code: "MODULE_DISABLED" });
      });
      register(scope);
    });
  }

  private async startRuntime(id: ModuleId) {
    const runtime = this.runtimes.get(id);
    if (!runtime || this.running.has(id)) return;
    this.running.add(id);
    try {
      await runtime.start();
    } catch (error) {
      this.running.delete(id);
      this.options.onRuntimeError?.(error, id, "start");
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
