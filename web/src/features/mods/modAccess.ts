import type { GeneralJob, ServerStatus } from "../../types";
import type { ManagedContentTerminology } from "./contentTerminology";

/**
 * Which mod and plugin actions are available, and why not.
 *
 * This lives with the module rather than in the app shell: every string it produces is written in
 * the module's own vocabulary — mods or plugins, Modrinth, the runtime's name — and the shell has
 * no reason to know any of it. The shell supplies only conditions it already owns for its own sake:
 * whether the server is provisioning, whether the runtime is reachable, and whether an export has
 * the server locked.
 */
export type ModAccessConditions = {
  isProvisioning: boolean;
  dockerOperationalLock: boolean;
  canManageMods: boolean;
  canInstallMods: boolean;
  activeStatus: ServerStatus | null;
  activeJobs: readonly GeneralJob[];
  modrinthApiConfigured: boolean;
  runtimeControlsDisabledReason: string;
  managedContent: ManagedContentTerminology;
  exportMutationLocked?: boolean;
  exportMutationBlockedReason?: string;
};

/** The panel-wide job list is generic; which of its entries belong to this module is not. */
export function isAnyModJobRunning(jobs: readonly GeneralJob[]) {
  return jobs.some((job) => (job.type === "mod-install" || job.type === "mod-upload") && job.status === "running");
}

export function resolveModGuards(input: ModAccessConditions) {
  const {
    isProvisioning, dockerOperationalLock, canManageMods, canInstallMods, activeStatus,
    modrinthApiConfigured, runtimeControlsDisabledReason, managedContent,
    exportMutationLocked = false, exportMutationBlockedReason = ""
  } = input;
  const modJobRunning = isAnyModJobRunning(input.activeJobs);

  const modsLocked = isProvisioning || dockerOperationalLock || exportMutationLocked || !canManageMods || !activeStatus || modJobRunning;

  return {
    modJobRunning,
    modsLocked,
    modReviewAcknowledgementLocked: isProvisioning || dockerOperationalLock || exportMutationLocked || !canManageMods || !activeStatus || modJobRunning,
    modToggleLocked: modsLocked,
    addModFromModrinthDisabled: isProvisioning || dockerOperationalLock || exportMutationLocked || !activeStatus || modJobRunning || !canInstallMods || !modrinthApiConfigured,
    uploadModDisabled: modsLocked,
    addModFromModrinthDisabledReason: isProvisioning
      ? "Server setup is still running."
      : dockerOperationalLock
        ? runtimeControlsDisabledReason || "Server runtime is unavailable."
        : exportMutationLocked
          ? exportMutationBlockedReason
        : !activeStatus
          ? "Server status is still loading."
          : modJobRunning
            ? `A ${managedContent.singular} operation is already running.`
            : !canInstallMods
              ? "Server management permission is required."
              : !modrinthApiConfigured
                ? `Add a Modrinth API key in Settings before searching for ${managedContent.plural}.`
                : `Search Modrinth for compatible ${managedContent.runtimeName} ${managedContent.plural}.`,
    uploadModDisabledReason: isProvisioning
      ? "Server setup is still running."
      : dockerOperationalLock
        ? runtimeControlsDisabledReason || "Server runtime is unavailable."
        : exportMutationLocked
          ? exportMutationBlockedReason
        : !canManageMods
          ? "Server management permission is required."
          : !activeStatus
            ? "Server status is still loading."
            : modJobRunning
              ? `A ${managedContent.singular} operation is already running.`
              : `Upload a local ${managedContent.runtimeName} ${managedContent.singular} file.`
  };
}
