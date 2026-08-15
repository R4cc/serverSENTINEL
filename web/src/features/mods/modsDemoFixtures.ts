

const modsDemoFixtureQuery = "mods-fixture";
const modsDemoFixtureNames = ["default", "empty", "large", "mixed", "updates", "missing-modrinth", "fail-update-plan", "fail-search", "fail-versions"] as const;
export type ModsDemoFixtureName = typeof modsDemoFixtureNames[number];

type ModsDemoFailure = "update-plan" | "search" | "versions";

export function readModsDemoFixture(search = window.location.search): ModsDemoFixtureName {
  const requested = new URLSearchParams(search).get(modsDemoFixtureQuery);
  return modsDemoFixtureNames.includes(requested as ModsDemoFixtureName) ? requested as ModsDemoFixtureName : "default";
}

export function demoFixtureModrinthConfigured(fixture: ModsDemoFixtureName) {
  return fixture !== "missing-modrinth";
}

export function demoFixtureFailureMessage(fixture: ModsDemoFixtureName, failure: ModsDemoFailure) {
  if (fixture !== `fail-${failure}`) return "";
  if (failure === "update-plan") return "Demo fixture: the update plan request failed.";
  if (failure === "search") return "Demo fixture: the Modrinth search request failed.";
  return "Demo fixture: version lookup failed for this project.";
}
