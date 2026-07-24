import type { AppSettings } from "../types.js";
import type { StorageDatabase } from "./database.js";

type SettingsRow = {
  modrinth_api_key: string | null;
  player_heads_enabled: number;
  player_heads_onboarding_completed: number;
};

export class SettingsRepository {
  constructor(private readonly storage: StorageDatabase) {}

  get(): AppSettings {
    const row = this.storage.connection.prepare<[], SettingsRow>(`
      SELECT modrinth_api_key, player_heads_enabled, player_heads_onboarding_completed
      FROM app_settings WHERE id = 1
    `).get();
    return {
      modrinthApiKey: row?.modrinth_api_key?.trim() || undefined,
      playerHeadsEnabled: row?.player_heads_enabled === 1,
      playerHeadsOnboardingCompleted: row?.player_heads_onboarding_completed === 1
    };
  }

  setModrinthApiKey(value: string) {
    const modrinthApiKey = value.trim();
    this.storage.connection.prepare(`
      INSERT INTO app_settings (id, modrinth_api_key) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET modrinth_api_key = excluded.modrinth_api_key
    `).run(modrinthApiKey || null);
  }

  setPlayerHeadsEnabled(enabled: boolean) {
    this.storage.connection.prepare(`
      INSERT INTO app_settings (id, player_heads_enabled, player_heads_onboarding_completed) VALUES (1, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        player_heads_enabled = excluded.player_heads_enabled,
        player_heads_onboarding_completed = 1
    `).run(enabled ? 1 : 0);
  }
}
