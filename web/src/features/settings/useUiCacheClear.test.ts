import { describe, expect, it } from "vitest";
import { uiCacheDisabledReason, uiCacheLocalBlockedReason, type UiCacheLocalActivity } from "./useUiCacheClear";

const idle: UiCacheLocalActivity = {
  runningTasks: false,
  unsavedFileChanges: false,
  fileMutation: false,
  runtimeMutation: false,
  serverSettingsMutation: false,
  consoleCommand: false,
  nodeMutation: false,
  scheduleMutation: false,
  userMutation: false,
  integrationMutation: false,
  transferMutation: false,
  modMutation: false
};

describe("Clear UI cache guards", () => {
  it("allows clearing only after local work and server operations have settled", () => {
    expect(uiCacheLocalBlockedReason(idle)).toBe("");
    expect(uiCacheDisabledReason("", "ready", false)).toBe("");
    expect(uiCacheDisabledReason("", "blocked", false)).toContain("running task");
    expect(uiCacheDisabledReason("", "checking", false)).toContain("Checking");
  });

  it("prioritizes unsaved file edits over background task state", () => {
    expect(uiCacheLocalBlockedReason({ ...idle, runningTasks: true, unsavedFileChanges: true })).toBe(
      "Save or discard the open file edit before clearing the UI cache."
    );
  });

  it("describes the client mutation that blocks a destructive reload", () => {
    expect(uiCacheLocalBlockedReason({ ...idle, consoleCommand: true })).toContain("console command");
    expect(uiCacheLocalBlockedReason({ ...idle, integrationMutation: true })).toContain("integration change");
    expect(uiCacheDisabledReason("Local action", "ready", true)).toBe("The UI cache is being cleared.");
  });
});
