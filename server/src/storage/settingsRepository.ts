import type { AppSettings } from "../types.js";
import type { StorageDatabase } from "./database.js";

type SettingsRow = {
  modrinth_api_key: string | null;
  player_heads_enabled: number;
  player_heads_onboarding_completed: number;
  maxmind_account_id: string | null;
  maxmind_license_key: string | null;
};

export class SettingsRepository {
  constructor(private readonly storage: StorageDatabase) {}

  get(): AppSettings {
    const row = this.storage.connection.prepare<[], SettingsRow>(`
      SELECT modrinth_api_key, player_heads_enabled, player_heads_onboarding_completed,
        maxmind_account_id, maxmind_license_key
      FROM app_settings WHERE id = 1
    `).get();
    return {
      modrinthApiKey: row?.modrinth_api_key?.trim() || undefined,
      playerHeadsEnabled: row?.player_heads_enabled === 1,
      playerHeadsOnboardingCompleted: row?.player_heads_onboarding_completed === 1,
      maxmindAccountId: row?.maxmind_account_id?.trim() || undefined,
      maxmindLicenseKey: row?.maxmind_license_key?.trim() || undefined
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

  /**
   * Both halves move together: MaxMind's download endpoint authenticates with the pair, so half of
   * one and half of another would only produce a rejected download with no obvious cause.
   */
  setMaxmindCredentials(accountId: string, licenseKey: string) {
    const account = accountId.trim();
    const license = licenseKey.trim();
    this.storage.connection.prepare(`
      INSERT INTO app_settings (id, maxmind_account_id, maxmind_license_key) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        maxmind_account_id = excluded.maxmind_account_id,
        maxmind_license_key = excluded.maxmind_license_key
    `).run(account || null, license || null);
  }
}
