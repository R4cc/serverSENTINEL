import { describe, expect, it } from "vitest";
import { cronExpressionError } from "@serversentinel/contracts";
import { scheduleTemplateById, scheduleTemplates } from "./scheduleTemplates";
import { scheduleValidationMessage } from "./scheduleWorkspaceHelpers";

describe("schedule templates", () => {
  // A template that cannot be saved is worse than no template: it fills the form and then fails on
  // submit, so every one of them is held to the same validation the editor applies.
  it("produces a schedule the editor would accept", () => {
    for (const template of scheduleTemplates) {
      expect(cronExpressionError(template.cron), template.id).toBeNull();
      expect(scheduleValidationMessage({
        name: template.name,
        cron: template.cron,
        steps: template.steps,
        onlyWhenNoPlayers: template.onlyWhenNoPlayers,
        waitForPlayersToLeave: template.waitForPlayersToLeave,
        enabled: true
      }), template.id).toBe("");
    }
  });

  it("keeps Restart last and never uses more than one, as the server requires", () => {
    for (const template of scheduleTemplates) {
      const restartIndexes = template.steps.flatMap((step, index) => step.type === "action" ? [index] : []);
      expect(restartIndexes.length, template.id).toBeLessThanOrEqual(1);
      if (restartIndexes.length) {
        expect(restartIndexes[0], template.id).toBe(template.steps.length - 1);
      }
    }
  });

  it("only claims to wait for players when it actually requires an empty server", () => {
    for (const template of scheduleTemplates) {
      if (template.waitForPlayersToLeave) expect(template.onlyWhenNoPlayers, template.id).toBe(true);
    }
  });

  it("looks templates up by id", () => {
    expect(scheduleTemplateById("nightly-restart")?.name).toBe("Nightly restart");
    expect(scheduleTemplateById("nope")).toBeUndefined();
  });
});
