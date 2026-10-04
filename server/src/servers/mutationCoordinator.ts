import { AsyncLocalStorage } from "node:async_hooks";
import { operationInProgress } from "../http/errors.js";

/** Reserve before I/O; nested helpers share the reservation, unrelated requests never do. */
export class ServerMutationCoordinator {
  private readonly active = new Map<string, { owners: Set<symbol>; sharedFiles: boolean }>();
  private readonly context = new AsyncLocalStorage<ReadonlyMap<string, symbol>>();

  isActive(serverId: string) { return this.active.has(serverId); }

  acquire(serverId: string, sharedFiles = false) {
    const owner = this.context.getStore()?.get(serverId);
    const active = this.active.get(serverId);
    if (owner && active?.owners.has(owner)) {
      if (!sharedFiles && active.sharedFiles) {
        if (active.owners.size > 1) operationInProgress("Other file saves are running. Wait for them to finish before making changes.", "SERVER_MUTATION_IN_PROGRESS");
        active.sharedFiles = false;
      }
      return { run: <T>(action: () => T) => action(), release: () => {} };
    }
    if (active && !(sharedFiles && active.sharedFiles)) {
      operationInProgress("Another server change is running. Wait for it to finish before making changes.", "SERVER_MUTATION_IN_PROGRESS");
    }
    const token = Symbol(serverId);
    const reservation = active ?? { owners: new Set<symbol>(), sharedFiles };
    reservation.owners.add(token);
    this.active.set(serverId, reservation);
    const scope = new Map(this.context.getStore());
    scope.set(serverId, token);
    return {
      run: <T>(action: () => T) => this.context.run(scope, action),
      release: () => {
        reservation.owners.delete(token);
        if (!reservation.owners.size && this.active.get(serverId) === reservation) this.active.delete(serverId);
      }
    };
  }

  async run<T>(serverId: string, action: () => Promise<T>, sharedFiles = false): Promise<T> {
    const lease = this.acquire(serverId, sharedFiles);
    try { return await lease.run(action); } finally { lease.release(); }
  }
}

export const serverMutations = new ServerMutationCoordinator();
