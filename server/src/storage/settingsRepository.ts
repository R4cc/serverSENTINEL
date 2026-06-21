import type { AppSettings } from "../types.js";
import type { StorageDatabase } from "./database.js";

type SettingsRow = { modrinth_api_key: string | null };

export class SettingsRepository {
  constructor(private readonly storage: StorageDatabase) {}

  get(): AppSettings {
    const row = this.storage.connection.prepare<[], SettingsRow>("SELECT modrinth_api_key FROM app_settings WHERE id = 1").get();
    return { modrinthApiKey: row?.modrinth_api_key?.trim() || undefined };
  }

  setModrinthApiKey(value: string) {
    const modrinthApiKey = value.trim();
    this.storage.connection.prepare(`
      INSERT INTO app_settings (id, modrinth_api_key) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET modrinth_api_key = excluded.modrinth_api_key
    `).run(modrinthApiKey || null);
  }
}
