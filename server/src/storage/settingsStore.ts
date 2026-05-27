import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import type { AppSettings } from "../types.js";

const settingsFile = join(config.configDir, "settings.json");

export async function readSettings() {
  await mkdir(config.configDir, { recursive: true });
  if (!existsSync(settingsFile)) {
    const initial: AppSettings = {
      modrinthApiKey: process.env.MODRINTH_API_KEY || undefined
    };
    await writeFile(settingsFile, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
    return initial;
  }
  return JSON.parse(await readFile(settingsFile, "utf8")) as AppSettings;
}

export async function writeSettings(settings: AppSettings) {
  await mkdir(config.configDir, { recursive: true });
  await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export async function modrinthApiKey() {
  const settings = await readSettings();
  return settings.modrinthApiKey || process.env.MODRINTH_API_KEY || "";
}
