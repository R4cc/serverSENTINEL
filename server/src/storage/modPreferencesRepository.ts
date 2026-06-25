import type { ModPreference } from "../types.js";
import type { StorageDatabase } from "./database.js";

type ModPreferenceRow = { filename: string; channel: string; metadata_json: string | null };

export class ModPreferencesRepository {
  constructor(private readonly storage: StorageDatabase) {}

  list(serverId: string): Record<string, ModPreference> {
    return Object.fromEntries(this.storage.connection.prepare<[string], ModPreferenceRow>(`
      SELECT filename, channel, metadata_json FROM mod_preferences WHERE server_id = ? ORDER BY filename
    `).all(serverId).map((row) => [row.filename, {
      channel: row.channel,
      modrinth: row.metadata_json ? JSON.parse(row.metadata_json) : undefined
    } as ModPreference]));
  }

  replaceAll(serverId: string, preferences: Record<string, ModPreference>) {
    this.storage.transaction((database) => {
      const filenames = new Set(Object.keys(preferences));
      const existing = database.prepare<[string], { filename: string }>(
        "SELECT filename FROM mod_preferences WHERE server_id = ?"
      ).all(serverId);
      const remove = database.prepare("DELETE FROM mod_preferences WHERE server_id = ? AND filename = ?");
      for (const row of existing) if (!filenames.has(row.filename)) remove.run(serverId, row.filename);
      const upsert = database.prepare(`
        INSERT INTO mod_preferences (server_id, filename, channel, metadata_json) VALUES (?, ?, ?, ?)
        ON CONFLICT(server_id, filename) DO UPDATE SET channel = excluded.channel, metadata_json = excluded.metadata_json
      `);
      for (const [filename, preference] of Object.entries(preferences)) {
        upsert.run(serverId, filename, preference.channel, preference.modrinth ? JSON.stringify(preference.modrinth) : null);
      }
    });
  }
}
