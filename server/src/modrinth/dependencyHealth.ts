import type { ModrinthVersion } from "../types.js";

type InstalledDependencyIdentity = {
  projectId?: string;
  versionId?: string;
  enabled: boolean;
};

export function assessRequiredModDependencies(
  dependencies: NonNullable<ModrinthVersion["dependencies"]>,
  installed: InstalledDependencyIdentity[]
) {
  const required = dependencies.filter((dependency) => (dependency.dependency_type || "required") === "required");
  const installedByProject = new Map(installed.flatMap((item) => item.projectId ? [[item.projectId, item] as const] : []));
  const installedByVersion = new Map(installed.flatMap((item) => item.versionId ? [[item.versionId, item] as const] : []));
  const missing = required.flatMap((dependency) => {
    const matching = (dependency.project_id ? installedByProject.get(dependency.project_id) : undefined)
      ?? (dependency.version_id ? installedByVersion.get(dependency.version_id) : undefined);
    if (matching?.enabled) return [];
    return [{
      projectId: dependency.project_id,
      versionId: dependency.version_id,
      disabled: Boolean(matching && !matching.enabled)
    }];
  });
  return {
    status: missing.length > 0 ? "missing" as const : "satisfied" as const,
    requiredCount: required.length,
    missing
  };
}
