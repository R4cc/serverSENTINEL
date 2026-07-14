import { describe, expect, it } from "vitest";
import { assessRequiredModDependencies } from "./dependencyHealth.js";

describe("Modrinth dependency health", () => {
  it("reports only absent required dependencies", () => {
    const health = assessRequiredModDependencies([
      { project_id: "fabric-api", dependency_type: "required" },
      { project_id: "cloth-config", version_id: "cloth-v1", dependency_type: "required" },
      { project_id: "mod-menu", dependency_type: "optional" }
    ], [{ projectId: "fabric-api", versionId: "fabric-v1", enabled: true }]);

    expect(health).toEqual({
      status: "missing",
      requiredCount: 2,
      missing: [{ projectId: "cloth-config", versionId: "cloth-v1", disabled: false }]
    });
  });

  it("treats disabled dependencies as unavailable and repairable", () => {
    const health = assessRequiredModDependencies([
      { version_id: "fabric-v1", dependency_type: "required" }
    ], [{ projectId: "fabric-api", versionId: "fabric-v1", enabled: false }]);

    expect(health.missing).toEqual([{ projectId: undefined, versionId: "fabric-v1", disabled: true }]);
  });
});
