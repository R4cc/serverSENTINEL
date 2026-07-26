/**
 * Demo mode is an opt-in feature, but its fixtures (synthetic players, resource
 * curves, timeline events, Modrinth results) are large. This module keeps them
 * out of the entry bundle: `demo.ts` is reached only through a dynamic import,
 * so the bundler emits it as a separate chunk that is fetched when demo mode
 * actually turns on.
 *
 * The invariant that makes the synchronous accessor safe: demoMode is never set
 * to true before loadDemoFixtures() has resolved. Boot honours it in main.tsx,
 * and the two sign-in paths that enable demo mode await the load first.
 */

export type DemoFixtures = typeof import("./demo");

/**
 * Lives here rather than in demo.ts so that the many `serverId === demoServerId`
 * comparisons stay synchronous and cost nothing in a production bundle.
 */
export const demoServerId = "demo-survival";

let fixtures: DemoFixtures | undefined;
let pending: Promise<DemoFixtures> | undefined;

/** Loads the demo fixture chunk once; concurrent callers share one request. */
export function loadDemoFixtures(): Promise<DemoFixtures> {
  if (fixtures) return Promise.resolve(fixtures);
  pending ??= import("./demo").then((module) => {
    fixtures = module;
    pending = undefined;
    return module;
  }).catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}

export function demoFixturesLoaded() {
  return fixtures !== undefined;
}

/**
 * The loaded fixtures. Callers must be on a demo-mode path, which by the
 * invariant above means the chunk has already resolved.
 */
export function demoFixtures(): DemoFixtures {
  if (!fixtures) {
    throw new Error("Demo fixtures are not loaded. Call loadDemoFixtures() before enabling demo mode.");
  }
  return fixtures;
}
