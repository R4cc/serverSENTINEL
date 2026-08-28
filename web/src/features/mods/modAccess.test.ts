import { describe, expect, it } from "vitest";
import type { GeneralJob, ServerStatus } from "../../types";
import { managedContentTerminology } from "./contentTerminology";
import { isAnyModJobRunning, resolveModGuards } from "./modAccess";

function serverStatus(): ServerStatus {
  return {
    server: { id: "server-1" },
    docker: { configured: true, available: true, controllable: true, state: "exited", running: false },
    fileLogsAvailable: true,
    controlAvailable: true,
    commandInputAvailable: true,
    commandInputMessage: "",
    lifecycle: { state: "idle", message: "" } as unknown as ServerStatus["lifecycle"]
  };
}

const runningModJob = [{ id: "job-1", type: "mod-install", status: "running" }] as unknown as GeneralJob[];

const modDefaults = {
  isProvisioning: false,
  dockerOperationalLock: false,
  canManageMods: true,
  canInstallMods: true,
  activeStatus: serverStatus(),
  activeJobs: [] as GeneralJob[],
  modrinthApiConfigured: true,
  runtimeControlsDisabledReason: "",
  managedContent: managedContentTerminology("fabric")
};

describe("isAnyModJobRunning", () => {
  it("recognizes only this module's jobs, and only while they run", () => {
    expect(isAnyModJobRunning(runningModJob)).toBe(true);
    expect(isAnyModJobRunning([{ id: "job-1", type: "mod-install", status: "succeeded" }] as unknown as GeneralJob[])).toBe(false);
    expect(isAnyModJobRunning([{ id: "job-2", type: "server-create", status: "running" }] as unknown as GeneralJob[])).toBe(false);
    expect(isAnyModJobRunning([])).toBe(false);
  });
});

describe("resolveModGuards", () => {
  it("unlocks mod actions when everything is ready", () => {
    const guards = resolveModGuards(modDefaults);
    expect(guards).toMatchObject({ modsLocked: false, uploadModDisabled: false, addModFromModrinthDisabled: false });
    expect(guards.addModFromModrinthDisabledReason).toBe("Search Modrinth for compatible Fabric mods.");
  });

  it("points at Settings when no Modrinth key is configured", () => {
    const guards = resolveModGuards({ ...modDefaults, modrinthApiConfigured: false });
    expect(guards.addModFromModrinthDisabled).toBe(true);
    expect(guards.addModFromModrinthDisabledReason).toBe("Add a Modrinth API key in Settings before searching for mods.");
    // Uploading a local file does not need the key.
    expect(guards.uploadModDisabled).toBe(false);
  });

  it("reports an in-flight job ahead of a missing permission", () => {
    expect(resolveModGuards({ ...modDefaults, activeJobs: runningModJob, canInstallMods: false }).addModFromModrinthDisabledReason)
      .toBe("A mod operation is already running.");
  });

  it("uses plugin wording for Paper servers", () => {
    const guards = resolveModGuards({ ...modDefaults, managedContent: managedContentTerminology("paper"), activeJobs: runningModJob });
    expect(guards.uploadModDisabledReason).toBe("A plugin operation is already running.");
  });

  it("locks every action while the status is still loading", () => {
    const guards = resolveModGuards({ ...modDefaults, activeStatus: null });
    expect(guards).toMatchObject({ modsLocked: true, modToggleLocked: true, uploadModDisabled: true, addModFromModrinthDisabled: true });
    expect(guards.uploadModDisabledReason).toBe("Server status is still loading.");
  });

  it("locks every managed-content mutation during an export", () => {
    const guards = resolveModGuards({
      ...modDefaults,
      exportMutationLocked: true,
      exportMutationBlockedReason: "Export in progress."
    });
    expect(guards).toMatchObject({
      modsLocked: true,
      modReviewAcknowledgementLocked: true,
      modToggleLocked: true,
      uploadModDisabled: true,
      addModFromModrinthDisabled: true,
      uploadModDisabledReason: "Export in progress.",
      addModFromModrinthDisabledReason: "Export in progress."
    });
  });
});
