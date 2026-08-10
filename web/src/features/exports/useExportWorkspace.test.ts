import { describe, expect, it } from "vitest";
import { exportStatePollInterval, sameServerExportState, type ServerExportState } from "./useExportWorkspace";

const state = (status?: NonNullable<ServerExportState["latest"]>["status"]): ServerExportState => ({
  latest: status ? {
    id: "export-1",
    status,
    progress: 25,
    task: "Exporting",
    createdAt: "2026-01-01T00:00:00.000Z",
    canCancel: true
  } : null,
  artifact: null
});

describe("export state polling", () => {
  it.each(["queued", "running"] as const)("polls every second while %s", (status) => {
    expect(exportStatePollInterval(state(status))).toBe(1_000);
  });

  it.each([undefined, "succeeded", "failed", "cancelled"] as const)("polls periodically while %s", (status) => {
    expect(exportStatePollInterval(state(status))).toBe(5_000);
  });
});

// The poll runs for the whole session and its result feeds the guard layer the files, mods and
// schedules workspaces read, so an unchanged response has to be recognised as unchanged.
describe("export state equality", () => {
  it("treats a repeated response as unchanged", () => {
    expect(sameServerExportState(state("running"), state("running"))).toBe(true);
  });

  it("treats an idle server with no export as unchanged", () => {
    expect(sameServerExportState(state(), state())).toBe(true);
  });

  it("notices a status change", () => {
    expect(sameServerExportState(state("running"), state("succeeded"))).toBe(false);
  });

  it("notices progress moving within the same status", () => {
    const advanced = state("running");
    expect(sameServerExportState(state("running"), { ...advanced, latest: { ...advanced.latest!, progress: 70 } })).toBe(false);
  });

  it("notices an artifact arriving", () => {
    const withArtifact: ServerExportState = {
      ...state("succeeded"),
      artifact: { operationId: "export-1", filename: "server.zip", createdAt: "2026-01-01T00:00:00.000Z" }
    };
    expect(sameServerExportState(state("succeeded"), withArtifact)).toBe(false);
  });
});
