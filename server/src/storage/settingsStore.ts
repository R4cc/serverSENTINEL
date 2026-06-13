import { join } from "node:path";
import { config } from "../config.js";
import type { AppSettings } from "../types.js";
import { AsyncQueue } from "../core.js";
import { asObject, optionalString, readJsonFile, writeJsonFile } from "./jsonFile.js";

const settingsFile = join(config.configDir, "settings.json");
const settingsQueue = new AsyncQueue();

async function readSettings() {
  return readJsonFile(settingsFile, initialSettings(), validateSettings);
}

function queuedReadSettings() {
  return settingsQueue.enqueue(() => readSettings());
}

async function writeSettings(settings: AppSettings) {
  await writeJsonFile(settingsFile, validateSettings(settings));
}

export async function updateSettings(updater: (settings: AppSettings) => Promise<void> | void) {
  return settingsQueue.enqueue(async () => {
    const settings = await readSettings();
    await updater(settings);
    await writeSettings(settings);
  });
}

export async function modrinthApiKey() {
  const settings = await queuedReadSettings();
  return settings.modrinthApiKey || process.env.MODRINTH_API_KEY || "";
}

function initialSettings(): AppSettings {
  return {
    modrinthApiKey: process.env.MODRINTH_API_KEY || undefined
  };
}

function validateSettings(value: unknown): AppSettings {
  const settings = asObject(value, "settings.json");
  return {
    modrinthApiKey: optionalString(settings.modrinthApiKey, "settings.modrinthApiKey")?.trim() || undefined
  };
}
