import { describe, expect, it } from "vitest";
import { exportStatePollInterval, type ServerExportState } from "./useExportWorkspace";

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
