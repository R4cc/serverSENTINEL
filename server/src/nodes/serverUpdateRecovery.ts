import { randomUUID, createHash } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureWritableInsideServer, validateExistingInsideServer } from "../core.js";
import { copyServerFile } from "../runtime/local/fileService.js";
import type { StorageDatabase } from "../storage/database.js";
import type { ManagedServer } from "../types.js";
import { compactNodeServerSpec } from "./protocol.js";

export function serverConfigurationFingerprint(server: ManagedServer) {
  return createHash("sha256").update(JSON.stringify(compactNodeServerSpec(server))).digest("hex");
}

export type AppliedServerUpdate = { previousFingerprint: string; server: ManagedServer };
type Journal = AppliedServerUpdate & {
  phase: "preparing" | "applied";
  files: Array<{ target: string; backup?: string }>;
  previousJournal?: string;
};

/** File commit and RPC delivery are separate: retain applied configuration for reconciliation. */
export class NodeServerUpdateRecovery {
  constructor(private readonly storage: StorageDatabase) {}
  private key(serverId: string) { return `node-server-update:${serverId}`; }
  private read(serverId: string): Journal | undefined {
    const value = this.storage.metadata(this.key(serverId));
    return value ? JSON.parse(value) as Journal : undefined;
  }

  needsRecovery(serverId: string) {
    const journal = this.read(serverId);
    return Boolean(journal && (journal.phase === "preparing" || journal.files.length || journal.previousJournal));
  }

  async prepare(previous: ManagedServer, updated: ManagedServer, root: string, targets: string[]) {
    const scope = { serverDir: root };
    const journal: Journal = {
      phase: "preparing", previousFingerprint: serverConfigurationFingerprint(previous),
      server: { ...compactNodeServerSpec(updated), startOnNodeStart: updated.startOnNodeStart, updatedAt: updated.updatedAt } as ManagedServer,
      files: [], previousJournal: this.storage.metadata(this.key(previous.id))
    };
    try {
      for (const target of new Set(targets)) {
        let source: string;
        try { source = await validateExistingInsideServer(scope, target); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          journal.files.push({ target });
          continue;
        }
        const backup = `.serversentinel-update-${randomUUID()}.backup`;
        await copyServerFile(scope, source, root, backup);
        journal.files.push({ target, backup });
      }
      this.storage.setMetadata(this.key(previous.id), JSON.stringify(journal));
    } catch (error) {
      await Promise.allSettled(journal.files.filter((file) => file.backup).map((file) => rm(join(root, file.backup!), { force: true })));
      throw error;
    }
  }

  applied(serverId: string) {
    const journal = this.read(serverId);
    if (!journal) throw new Error("Remote server update journal is missing");
    journal.phase = "applied";
    this.storage.setMetadata(this.key(serverId), JSON.stringify(journal));
  }

  async recover(serverId: string, root: string) {
    const journal = this.read(serverId);
    if (!journal) return;
    const scope = { serverDir: root };
    if (journal.phase === "preparing") {
      for (const file of journal.files) {
        const target = await ensureWritableInsideServer(scope, file.target);
        if (file.backup) {
          let backup: string;
          try { backup = await validateExistingInsideServer(scope, file.backup); } catch (error) {
            // A previous recovery may have renamed this backup before the process exited.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            continue;
          }
          await rename(backup, target);
        } else await rm(target, { force: true });
      }
      this.storage.setMetadata(this.key(serverId), journal.previousJournal ?? "");
    } else {
      if (!journal.files.length && !journal.previousJournal) return;
      for (const file of journal.files) if (file.backup) {
        await rm(await ensureWritableInsideServer(scope, file.backup), { force: true });
      }
      journal.files = [];
      journal.previousJournal = undefined;
      this.storage.setMetadata(this.key(serverId), JSON.stringify(journal));
    }
  }

  pending(server: ManagedServer): AppliedServerUpdate | undefined {
    const journal = this.read(server.id);
    return journal?.phase === "applied" && journal.previousFingerprint === serverConfigurationFingerprint(server)
      ? { previousFingerprint: journal.previousFingerprint, server: journal.server }
      : undefined;
  }
}
