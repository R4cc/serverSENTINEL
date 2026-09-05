import type { ModHistoryEntry, ModPreference } from "../types.js";
import type { StorageDatabase } from "./database.js";

export type ModHistorySnapshot = {
  identity: string;
  directory: string;
  displayName: string;
  iconUrl?: string;
  filename: string;
  version: string | null;
  enabled: boolean;
  sha1: string;
  preference?: ModPreference;
};

export type StoredModHistoryEntry = Omit<ModHistoryEntry, "before" | "after" | "canRevert" | "revertBlockedReason"> & {
  before: ModHistorySnapshot | null;
  after: ModHistorySnapshot | null;
};

export const modHistoryRetention = 500;

export class ModHistoryRepository {
  constructor(private readonly storage: StorageDatabase) {}

  list(serverId: string): StoredModHistoryEntry[] {
    return this.storage.connection.prepare<[string], { entry_json: string; reverted_at: string | null }>(
      "SELECT entry_json, reverted_at FROM mod_history WHERE server_id = ? ORDER BY sequence DESC"
    ).all(serverId).map((row) => ({ ...JSON.parse(row.entry_json), revertedAt: row.reverted_at }));
  }

  append(serverId: string, entries: StoredModHistoryEntry[], revertedId?: string) {
    this.storage.transaction((database) => {
      const insert = database.prepare("INSERT INTO mod_history (id, server_id, entry_json) VALUES (?, ?, ?)");
      for (const entry of entries) insert.run(entry.id, serverId, JSON.stringify(entry));
      if (revertedId) database.prepare("UPDATE mod_history SET reverted_at = ? WHERE server_id = ? AND id = ?")
        .run(new Date().toISOString(), serverId, revertedId);
      database.prepare(`DELETE FROM mod_history WHERE server_id = ? AND sequence NOT IN (
        SELECT sequence FROM mod_history WHERE server_id = ? ORDER BY sequence DESC LIMIT ?
      )`).run(serverId, serverId, modHistoryRetention);
    });
  }
}
