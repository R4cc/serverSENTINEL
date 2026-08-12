import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStorageDatabase, type StorageDatabase } from "./storage/database.js";
import { completeOnboarding, initializeOnboarding, onboardingCurrentVersion, publicOnboardingState } from "./onboarding.js";

const roots: string[] = [];
const databases: StorageDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storage() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-onboarding-"));
  roots.push(root);
  const database = openStorageDatabase(join(root, "state.sqlite"));
  databases.push(database);
  return database;
}

describe("versioned onboarding state", () => {
  it("keeps a fresh data root pending across restarts until completion", async () => {
    const database = await storage();
    initializeOnboarding(database, 0);
    expect(publicOnboardingState(database)).toEqual({ currentVersion: onboardingCurrentVersion, completedVersion: 0 });

    initializeOnboarding(database, 1);
    expect(publicOnboardingState(database).completedVersion).toBe(0);

    expect(completeOnboarding(database)).toEqual({
      currentVersion: onboardingCurrentVersion,
      completedVersion: onboardingCurrentVersion
    });
  });

  it("grandfathers an existing installation without an onboarding marker", async () => {
    const database = await storage();
    initializeOnboarding(database, 1);
    expect(publicOnboardingState(database).completedVersion).toBe(onboardingCurrentVersion);
  });
});
