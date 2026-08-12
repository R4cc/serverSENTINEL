import type { StorageDatabase } from "./storage/database.js";

export const onboardingCurrentVersion = 1;
const onboardingCompletedVersionKey = "onboarding.completed-version";

function normalizedCompletedVersion(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) return 0;
  return Math.min(Number(value), onboardingCurrentVersion);
}

/**
 * A missing marker belongs either to a pre-onboarding installation or to a new
 * empty data root. Existing installations are grandfathered so an upgrade does
 * not interrupt an operator; a fresh root remains pending across restarts.
 */
export function initializeOnboarding(storage: StorageDatabase, existingUserCount: number) {
  if (storage.metadata(onboardingCompletedVersionKey) !== undefined) return;
  storage.setMetadata(onboardingCompletedVersionKey, String(existingUserCount > 0 ? onboardingCurrentVersion : 0));
}

export function publicOnboardingState(storage: StorageDatabase) {
  return {
    currentVersion: onboardingCurrentVersion,
    completedVersion: normalizedCompletedVersion(storage.metadata(onboardingCompletedVersionKey))
  };
}

export function completeOnboarding(storage: StorageDatabase) {
  storage.setMetadata(onboardingCompletedVersionKey, String(onboardingCurrentVersion));
  return publicOnboardingState(storage);
}
