const scheduleDemoFixtureQuery = "schedule-fixture";
const scheduleDemoFixtureNames = ["default", "active"] as const;

type ScheduleDemoFixtureName = typeof scheduleDemoFixtureNames[number];

export function readScheduleDemoFixture(search = window.location.search): ScheduleDemoFixtureName {
  const requested = new URLSearchParams(search).get(scheduleDemoFixtureQuery);
  return scheduleDemoFixtureNames.includes(requested as ScheduleDemoFixtureName)
    ? requested as ScheduleDemoFixtureName
    : "default";
}
