import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoOverviewData, demoServer, demoStatus } from "../demo";
import type { ModUpdatePlan, ScheduledExecution, ServerActivity } from "../types";
import {
  ActivePlayersPanel,
  AutomationPanel,
  buildAutomationSnapshot,
  buildModHealthSummary,
  eventDate,
  formatRelativeEventTime,
  formatRelativeScheduleTime,
  ModHealthPanel,
  OverviewSummary
} from "./OverviewPage";

const activity = (overrides: Partial<ServerActivity> = {}): ServerActivity => ({
  playersOnline: 0,
  maxPlayers: 20,
  playerNames: [],
  ...overrides
});

const updatePlan = (counts: Partial<ModUpdatePlan["counts"]> = {}): ModUpdatePlan => ({
  serverId: "demo",
  generatedAt: "2026-07-11T12:00:00.000Z",
  counts: {
    totalInstalled: 4,
    safeUpdates: 0,
    reviewUpdates: 0,
    blockedUpdates: 0,
    upToDate: 4,
    unknown: 0,
    ...counts
  },
  updates: []
});

const schedule = (overrides: Partial<ScheduledExecution> = {}): ScheduledExecution => ({
  id: "schedule-1",
  name: "Nightly restart",
  cron: "0 4 * * *",
  steps: [{ type: "command", command: "stop", delaySeconds: 0 }],
  onlyWhenNoPlayers: true,
  enabled: true,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...overrides
});

describe("recent event timestamps", () => {
  const now = new Date("2026-07-11T12:00:00.000Z");

  it("formats elapsed minutes, hours, and days", () => {
    expect(formatRelativeEventTime("2026-07-11T11:55:00.000Z", now)).toBe("5 minutes ago");
    expect(formatRelativeEventTime("2026-07-11T10:00:00.000Z", now)).toBe("2 hours ago");
    expect(formatRelativeEventTime("2026-07-10T12:00:00.000Z", now)).toBe("1 day ago");
  });

  it("uses singular labels and handles missing timestamps", () => {
    expect(formatRelativeEventTime("2026-07-11T11:59:00.000Z", now)).toBe("1 minute ago");
    expect(formatRelativeEventTime(undefined, now)).toBe("No timestamp");
  });

  it("treats a future time-only log entry as yesterday", () => {
    const localNow = new Date(2026, 6, 11, 12, 0, 0);
    const date = eventDate("13:00:00", localNow);
    expect(date?.getDate()).toBe(10);
    expect(date?.getHours()).toBe(13);
  });
});

describe("overview summary", () => {
  it("replaces Container with mod health and reserves CPU and memory for the wide layout", () => {
    const server = demoServer();
    const html = renderToStaticMarkup(createElement(OverviewSummary, {
      server,
      status: demoStatus(server, true),
      dockerSocketMounted: true,
      activity: demoOverviewData(true).activity,
      updatePlan: updatePlan()
    }));

    expect((html.match(/class="[^"]*summaryTile/g) ?? []).length).toBe(8);
    expect((html.match(/overviewWideSummaryTile/g) ?? []).length).toBe(2);
    expect(html).toContain(">Mod updates<");
    expect(html).toContain(">CPU<");
    expect(html).toContain(">Memory<");
    expect(html).not.toContain(">Container<");
    expect(html).not.toContain("Server Activity &amp; Health");
  });

  it("exposes accessible loading state for every summary value", () => {
    const server = demoServer();
    const html = renderToStaticMarkup(createElement(OverviewSummary, {
      server,
      status: demoStatus(server, true),
      dockerSocketMounted: true,
      activity: demoOverviewData(true).activity,
      loading: true
    }));

    expect((html.match(/overviewSummaryValueSkeleton/g) ?? []).length).toBe(8);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading server summary");
  });
});

describe("active player states", () => {
  const render = (value: ServerActivity, running = true) => renderToStaticMarkup(createElement(ActivePlayersPanel, { activity: value, running }));

  it("distinguishes stopped, empty, and unavailable query states", () => {
    expect(render(activity({ playersOnline: 2, playerNames: ["Alex"] }), false)).toContain("Server is not running");
    expect(render(activity())).toContain("No players online");
    expect(render(activity({ playersOnline: null }))).toContain("Player query unavailable");
  });

  it("normalizes names and explains partial-name responses", () => {
    const html = render(activity({ playersOnline: 3, playerNames: [" Alex ", "Alex", "", "Steve"] }));
    expect((html.match(/>Alex</g) ?? []).length).toBe(1);
    expect(html).toContain(">Steve</");
    expect(html).toContain("1 additional player did not include a name");
  });

  it("explains a count-only response", () => {
    expect(render(activity({ playersOnline: 2, playerNames: undefined }))).toContain("reported a count but did not provide player names");
  });
});

describe("mod health", () => {
  it("covers permission, loading, unavailable, empty, current, update, and attention states", () => {
    expect(buildModHealthSummary(null, { canView: false }).label).toBe("No access");
    expect(buildModHealthSummary(null, { loading: true }).label).toBe("Checking");
    expect(buildModHealthSummary(null, { error: "offline" }).label).toBe("Unavailable");
    expect(buildModHealthSummary(updatePlan({ totalInstalled: 0, upToDate: 0 })).label).toBe("No mods");
    expect(buildModHealthSummary(updatePlan()).label).toBe("All up to date");
    expect(buildModHealthSummary(updatePlan({ safeUpdates: 2, reviewUpdates: 1, upToDate: 1 })).label).toBe("3 available");
    expect(buildModHealthSummary(updatePlan({ blockedUpdates: 1, unknown: 2, upToDate: 1 })).label).toBe("3 need attention");
  });

  it("shows pending restart changes even while the update plan is unavailable", () => {
    const html = renderToStaticMarkup(createElement(ModHealthPanel, {
      updatePlan: null,
      error: "offline",
      restartRequiredChanges: [{ type: "mod", identity: "sodium.jar", displayName: "Sodium", action: "updated" }],
      onOpenMods: () => undefined
    }));
    expect(html).toContain("Restart required");
    expect(html).toContain("Updated:");
    expect(html).toContain("Sodium");
  });
});

describe("automation summary", () => {
  const now = new Date("2026-07-11T12:00:00.000Z");

  it("selects the newest active run, nearest enabled run, and latest completed run", () => {
    const snapshot = buildAutomationSnapshot([
      schedule({
        nextRunAt: "2026-07-11T15:00:00.000Z",
        activeRuns: [{ id: "active", scheduleId: "schedule-1", scheduleName: "Nightly restart", status: "running", startedAt: "2026-07-11T11:58:00.000Z", stepCount: 2, cancellable: true }],
        recentRuns: [{ id: "recent", scheduleId: "schedule-1", scheduleName: "Nightly restart", status: "failed", ranAt: "2026-07-11T10:00:00.000Z" }]
      }),
      schedule({ id: "schedule-2", name: "Sooner", nextRunAt: "2026-07-11T13:00:00.000Z" }),
      schedule({ id: "disabled", name: "Disabled", enabled: false, nextRunAt: "2026-07-11T12:30:00.000Z" })
    ], now);

    expect(snapshot.active?.id).toBe("active");
    expect(snapshot.next?.id).toBe("schedule-2");
    expect(snapshot.recent?.status).toBe("failed");
  });

  it("handles disabled-only and empty schedules", () => {
    expect(buildAutomationSnapshot([schedule({ enabled: false })], now)).toEqual({ active: undefined, next: undefined, recent: undefined });
    expect(buildAutomationSnapshot([], now)).toEqual({ active: undefined, next: undefined, recent: undefined });
  });

  it("formats upcoming and completed times", () => {
    expect(formatRelativeScheduleTime("2026-07-11T13:00:00.000Z", now)).toBe("in 1h");
    expect(formatRelativeScheduleTime("2026-07-11T11:55:00.000Z", now)).toBe("5m ago");
  });

  it("renders empty and permission-limited states", () => {
    const props = { schedules: [], formatDate: String, onOpenSchedules: () => undefined };
    expect(renderToStaticMarkup(createElement(AutomationPanel, props))).toContain("No schedules configured");
    expect(renderToStaticMarkup(createElement(AutomationPanel, { ...props, canView: false }))).toContain("View schedules permission is required");
  });

  it("uses the full configured date and time when relative timestamps are disabled", () => {
    const value = schedule({
      nextRunAt: "2099-07-11T13:00:00.000Z",
      recentRuns: [{ id: "recent", scheduleId: "schedule-1", scheduleName: "Nightly restart", status: "success", ranAt: "2026-07-11T10:00:00.000Z" }]
    });
    const html = renderToStaticMarkup(createElement(AutomationPanel, {
      schedules: [value],
      formatDate: (timestamp) => `FULL ${new Date(timestamp).toISOString()}`,
      relativeTimestamps: false,
      onOpenSchedules: () => undefined
    }));

    expect(html).toContain("FULL 2099-07-11T13:00:00.000Z");
    expect(html).toContain("FULL 2026-07-11T10:00:00.000Z");
    expect(html).not.toContain(" ago");
  });
});
