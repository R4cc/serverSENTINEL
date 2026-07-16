import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoOverviewData, demoPlayerSnapshot, demoServer, demoStatus } from "../demo";
import type { ModUpdatePlan, PlayerSnapshot, ScheduledExecution, ServerEvent } from "../types";
import {
  ActivePlayersPanel,
  AutomationPanel,
  buildAutomationSnapshot,
  eventDate,
  formatRelativeEventTime,
  formatRelativeScheduleTime,
  groupRecentEvents,
  ModHealthPanel,
  OverviewSummary
} from "./OverviewPage";

const serverEvent = (eventType: ServerEvent["eventType"], timestamp: string, overrides: Partial<ServerEvent> = {}): ServerEvent => ({
  id: `${eventType}-${timestamp}`,
  eventType,
  type: "info",
  severity: "info",
  text: eventType,
  message: eventType,
  timestamp,
  signature: eventType,
  source: "logs/latest.log",
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
  it("keeps mod updates out of the persistent summary and reserves CPU and memory for the wide layout", () => {
    const server = demoServer();
    const html = renderToStaticMarkup(createElement(OverviewSummary, {
      server,
      status: demoStatus(server, true),
      dockerSocketMounted: true,
      activity: demoOverviewData(true).activity,
      playerSnapshot: demoPlayerSnapshot(true)
    }));

    expect((html.match(/class="[^"]*summaryTile/g) ?? []).length).toBe(7);
    expect((html.match(/overviewWideSummaryTile/g) ?? []).length).toBe(2);
    expect(html).not.toContain(">Mod updates<");
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
      playerSnapshot: demoPlayerSnapshot(true),
      loading: true
    }));

    expect((html.match(/overviewSummaryValueSkeleton/g) ?? []).length).toBe(7);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading server summary");
  });
});

describe("active player states", () => {
  const render = (snapshot: PlayerSnapshot | undefined, running = true) => renderToStaticMarkup(createElement(ActivePlayersPanel, { snapshot, running }));
  const live = (overrides: Partial<Extract<PlayerSnapshot, { state: "live" }>> = {}): Extract<PlayerSnapshot, { state: "live" }> => ({
    state: "live",
    online: 2,
    maxPlayers: 20,
    names: ["Alex", "Steve"],
    sampledAt: new Date().toISOString(),
    ...overrides
  });

  it("distinguishes stopped, empty, and unavailable query states", () => {
    expect(render(live(), false)).toContain("Server is not running");
    expect(render(live({ online: 0, names: [] }))).toContain("No players online");
    expect(render({ state: "unavailable", online: null, maxPlayers: 20, names: [], code: "QUERY_TIMEOUT", message: "Minecraft Query timed out" })).toContain("Player query unavailable");
  });

  it("renders every name from a complete live snapshot", () => {
    const html = render(live());
    expect(html).toContain(">Alex</");
    expect(html).toContain(">Steve</");
  });

  it("keeps the complete roster and labels stale snapshots", () => {
    const html = render({
      ...live(),
      state: "stale",
      lastAttemptAt: new Date().toISOString(),
      code: "QUERY_TIMEOUT",
      message: "Minecraft Query timed out"
    });
    expect(html).toContain(">Alex</");
    expect(html).toContain("Last verified");
    expect(html).toContain("Minecraft Query timed out");
  });
});

describe("recent event grouping", () => {
  const now = new Date("2026-07-11T12:05:00.000Z");

  it("combines an immediate leave and rejoin into one reconnect entry", () => {
    const groups = groupRecentEvents([
      serverEvent("player_joined", "2026-07-11T12:00:08.000Z", { text: "Steve joined", subject: "Steve", signature: "player_joined:steve", severity: "success" }),
      serverEvent("player_left", "2026-07-11T12:00:01.000Z", { text: "Steve left", subject: "Steve", signature: "player_left:steve", severity: "warning" })
    ], now);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "player_reconnected", title: "Steve reconnected", details: "Left and rejoined after 7 seconds" });
    expect(groups[0].events).toHaveLength(2);
  });

  it("combines adjacent stop/start lifecycle events into a restart", () => {
    const groups = groupRecentEvents([
      serverEvent("server_started", "2026-07-11T12:01:00.000Z", { text: "Server started", severity: "success" }),
      serverEvent("server_stopped", "2026-07-11T12:00:30.000Z", { text: "Server stopped" })
    ], now);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "server_restarted", title: "Server restarted", details: "Back online after 30 seconds" });
  });

  it("collapses repeated operational warnings while keeping unrelated player activity separate", () => {
    const overload = { text: "Server is falling behind", signature: "server_overloaded", severity: "warning" as const, details: "Running 100 ticks behind" };
    const groups = groupRecentEvents([
      serverEvent("server_overloaded", "2026-07-11T12:00:20.000Z", overload),
      serverEvent("server_overloaded", "2026-07-11T12:00:00.000Z", overload),
      serverEvent("player_joined", "2026-07-11T11:59:50.000Z", { text: "Alex joined", subject: "Alex", signature: "player_joined:alex" })
    ], now);

    expect(groups).toHaveLength(2);
    expect(groups[0].events).toHaveLength(2);
    expect(groups[0].details).toContain("2 occurrences within a minute");
    expect(groups[1].title).toBe("Alex joined");
  });
});

describe("mod health", () => {
  it("only renders the clickable update count when updates are available", () => {
    const render = (plan: ModUpdatePlan | null, canView = true) => renderToStaticMarkup(createElement(ModHealthPanel, {
      updatePlan: plan,
      canView,
      onOpenMods: () => undefined
    }));

    expect(render(null)).toBe("");
    expect(render(updatePlan())).toBe("");
    expect(render(updatePlan({ blockedUpdates: 1, unknown: 1, upToDate: 2 }))).toBe("");
    expect(render(updatePlan({ safeUpdates: 1 }), false)).toBe("");

    const html = render(updatePlan({ safeUpdates: 2, reviewUpdates: 1, upToDate: 1 }));
    expect(html).toContain("<button");
    expect(html).toContain("Mod updates available");
    expect(html).toContain("<strong>3</strong>");
    expect(html).toContain("Open Mods, 3 mod updates available");
    expect(html).not.toContain("installed");
    expect(html).not.toContain("Safe");
    expect(html).not.toContain("Review");
    expect(html).not.toContain("Attention");
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

  it("renders past, active, and future automation as an interactive chronological timeline", () => {
    const html = renderToStaticMarkup(createElement(AutomationPanel, {
      schedules: [schedule({
        nextRunAt: "2099-07-11T13:00:00.000Z",
        activeRuns: [{ id: "active", scheduleId: "schedule-1", scheduleName: "Nightly restart", status: "running", startedAt: "2026-07-11T11:58:00.000Z", stepCount: 2, currentStep: "Saving world", cancellable: true }],
        recentRuns: [{ id: "recent", scheduleId: "schedule-1", scheduleName: "Nightly restart", status: "success", ranAt: "2026-07-11T10:00:00.000Z" }]
      })],
      formatDate: (timestamp) => new Date(timestamp).toISOString(),
      onOpenSchedules: () => undefined
    }));

    expect(html).toContain("automationTimelineItem--past");
    expect(html).toContain("automationTimelineItem--active");
    expect(html).toContain("automationTimelineItem--future");
    expect(html).toContain('aria-label="View details for Nightly restart, Succeeded');
    expect(html).toContain('aria-label="Open active run Nightly restart, Saving world"');
    expect(html).toContain('aria-label="Open Nightly restart, next run');
    expect(html.indexOf("Last run")).toBeLessThan(html.indexOf("Running now"));
    expect(html.indexOf("Running now")).toBeLessThan(html.indexOf("Next up"));
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
