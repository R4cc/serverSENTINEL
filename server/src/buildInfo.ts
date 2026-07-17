export const appVersion = process.env.npm_package_version ?? "1.4.0";

export function appUserAgentFor(component: string) {
  return `serverSENTINEL/${appVersion} (${component})`;
}

function normalizeBuildId(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "unknown" || trimmed === "local") return undefined;
  return trimmed;
}

export const appBuildId = normalizeBuildId(
  process.env.SERVERSENTINEL_BUILD_ID
    ?? process.env.SS_BUILD_ID
    ?? process.env.GITHUB_SHA
    ?? process.env.COMMIT_SHA
    ?? process.env.SOURCE_COMMIT
    ?? process.env.RAILWAY_GIT_COMMIT_SHA
);
