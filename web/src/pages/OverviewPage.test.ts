import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoOverviewData, demoPlayerSnapshot, demoServer, demoStatus } from "../demo";
import type { ModUpdatePlan, ModUpdatePlanEntry, PlayerSnapshot, ScheduledExecution, ServerEvent } from "../types";
import {
  ActivePlayersPanel,
  buildUpcomingScheduleSnapshot,
  eventDate,
  formatRelativeEventTime,
  formatRelativeScheduleTime,
  groupRecentEvents,
  groupRecentEventsByTime,
  ModHealthPanel,
  OverviewSummary,
  RecentEventsPanel,
  recentEventPresentation,
  SchedulePanel
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

const updatePlan = (counts: Partial<ModUpdatePlan["counts"]> = {}, updates: ModUpdatePlanEntry[] = []): ModUpdatePlan => ({
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
  updates
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

  it("keeps the complete roster and shows when stale snapshots were updated", () => {
    const html = render({
      ...live({ sampledAt: new Date(Date.now() - 60_000).toISOString() }),
      state: "stale",
      lastAttemptAt: new Date().toISOString(),
      code: "QUERY_TIMEOUT",
      message: "Minecraft Query timed out"
    });
    expect(html).toContain(">Alex</");
    expect(html).toContain("Updated 1 minute ago");
    expect(html).not.toContain("Last verified");
    expect(html).not.toContain("Minecraft Query timed out");
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
    expect(groups[0]).toMatchObject({ kind: "player_reconnected", title: "Steve reconnected", details: "Offline for 7 seconds" });
    expect(groups[0].events).toHaveLength(2);
    expect(recentEventPresentation(groups[0])).toEqual({ title: "Reconnected", subject: "Steve", details: "Offline for 7 seconds" });
  });

  it("uses the event type as the player-event heading and the player as its subject", () => {
    const [joined, left] = groupRecentEvents([
      serverEvent("player_joined", "2026-07-11T12:03:00.000Z", { text: "Alex joined", subject: "Alex", signature: "player_joined:alex", severity: "success" }),
      serverEvent("player_left", "2026-07-11T11:30:00.000Z", { text: "Steve left", subject: "Steve", signature: "player_left:steve" })
    ], now);

    expect(recentEventPresentation(joined)).toEqual({ title: "Joined", subject: "Alex", details: undefined });
    expect(recentEventPresentation(left)).toEqual({ title: "Left", subject: "Steve", details: undefined });
  });

  it("groups displayed events into just now, within the last hour, and earlier sections", () => {
    const groups = groupRecentEvents([
      serverEvent("player_joined", "2026-07-11T12:03:00.000Z", { text: "Alex joined", subject: "Alex", signature: "player_joined:alex" }),
      serverEvent("player_left", "2026-07-11T11:30:00.000Z", { text: "Steve left", subject: "Steve", signature: "player_left:steve" }),
      serverEvent("server_started", "2026-07-11T10:00:00.000Z", { text: "Server started", signature: "server_started" })
    ], now);

    const sections = groupRecentEventsByTime(groups, now);
    expect(sections.map((section) => section.label)).toEqual(["Just now", "Within the last hour", "Earlier"]);
    expect(sections.map((section) => section.events.length)).toEqual([1, 1, 1]);
  });

  it("combines adjacent stop/start lifecycle events into a restart", () => {
    const groups = groupRecentEvents([
      serverEvent("server_started", "2026-07-11T12:01:00.000Z", { text: "Server started", severity: "success" }),
      serverEvent("server_stopped", "2026-07-11T12:00:30.000Z", { text: "Server stopped" })
    ], now);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "server_restarted", title: "Server restarted", details: "Back online after 30 seconds" });
  });

  it("collapses adjacent matching events within ten minutes while keeping unrelated player activity separate", () => {
    const overload = { text: "Server is falling behind", signature: "server_overloaded", severity: "warning" as const, details: "Running 100 ticks behind" };
    const groups = groupRecentEvents([
      serverEvent("server_overloaded", "2026-07-11T12:00:20.000Z", overload),
      serverEvent("server_overloaded", "2026-07-11T12:00:00.000Z", overload),
      serverEvent("player_joined", "2026-07-11T11:59:50.000Z", { text: "Alex joined", subject: "Alex", signature: "player_joined:alex" })
    ], now);

    expect(groups).toHaveLength(2);
    expect(groups[0].events).toHaveLength(2);
    expect(groups[0].details).toBe("Running 100 ticks behind");
    expect(groups[1].title).toBe("Alex joined");
  });

  it("shows one recent-event row with an occurrence badge for repeated player disconnects", () => {
    const events = Array.from({ length: 9 }, (_, index) => serverEvent("player_left", new Date(now.getTime() - index * 30_000).toISOString(), {
      id: `left-${index}`,
      text: "Oliverano left",
      subject: "Oliverano",
      signature: "player_left:oliverano",
      severity: "warning"
    }));
    const html = renderToStaticMarkup(createElement(RecentEventsPanel, {
      events,
      formatDate: String,
      onOpenConsole: () => undefined,
      requestConfirmation: async () => false
    }));

    expect((html.match(/class="eventRow warning/g) ?? [])).toHaveLength(1);
    expect(html).toContain('class="srOnly">9 occurrences');
    expect(html).toContain("×9");
  });

  it("starts a new occurrence group at the ten-minute boundary", () => {
    const groups = groupRecentEvents([
      serverEvent("player_left", "2026-07-11T12:00:00.000Z", { signature: "player_left:alex", subject: "Alex" }),
      serverEvent("player_left", "2026-07-11T11:50:00.000Z", { signature: "player_left:alex", subject: "Alex" })
    ], now);

    expect(groups).toHaveLength(2);
  });

  it("does not extend one occurrence burst past ten minutes through chaining", () => {
    const groups = groupRecentEvents([
      serverEvent("player_left", "2026-07-11T12:00:00.000Z", { signature: "player_left:alex", subject: "Alex" }),
      serverEvent("player_left", "2026-07-11T11:51:00.000Z", { signature: "player_left:alex", subject: "Alex" }),
      serverEvent("player_left", "2026-07-11T11:42:00.000Z", { signature: "player_left:alex", subject: "Alex" })
    ], now);

    expect(groups.map((group) => group.events.length)).toEqual([2, 1]);
  });
});

describe("mod health", () => {
  it("reserves the mod update card with a skeleton while the plan loads", () => {
    const render = (plan: ModUpdatePlan | null, canView = true, loading = false) => renderToStaticMarkup(createElement(ModHealthPanel, {
      updatePlan: plan,
      loading,
      canView,
      onOpenMods: () => undefined
    }));

    const loadingHtml = render(null);
    expect(loadingHtml).toContain("modsHealthPanel");
    expect(loadingHtml).toContain("modUpdatesCardSkeleton");
    expect(loadingHtml).toContain("Loading mod updates");
    expect(loadingHtml).toContain("<strong>Mod updates</strong>");
    expect(loadingHtml).toContain("Checking for updates");
    expect(loadingHtml).not.toContain("modUpdatesTitleSkeleton");
    expect(loadingHtml).not.toContain("modUpdatesWideTitleSkeleton");
    expect(loadingHtml).toContain("modUpdatesCompact");
    expect(loadingHtml).toContain("modUpdatesWideSkeleton");
    expect(render(updatePlan({ safeUpdates: 1 }), true, true)).toContain("modUpdatesCardSkeleton");
    expect(render(null, false)).toBe("");
  });

  it("keeps a neutral clickable card focused only on updates when none are available", () => {
    const render = (plan: ModUpdatePlan | null, canView = true) => renderToStaticMarkup(createElement(ModHealthPanel, {
      updatePlan: plan,
      canView,
      onOpenMods: () => undefined
    }));

    const healthyHtml = render(updatePlan({ totalInstalled: 4, upToDate: 4 }));
    expect(healthyHtml).toContain("modUpdatesCard--healthy");
    expect(healthyHtml).toContain("<strong>Mod updates</strong>");
    expect(healthyHtml).toContain("No updates available");
    expect(healthyHtml).toContain("Everything is up to date");
    expect(healthyHtml).toContain("modUpdatesListItem modUpdatesListItem--healthy");
    expect(healthyHtml).toContain("modUpdatesListCopy");
    expect(healthyHtml).not.toContain("modUpdatesHealthyState");
    expect(healthyHtml).toContain("Open Mods, no mod updates available");
    const attentionHtml = render(updatePlan({ totalInstalled: 4, blockedUpdates: 1, unknown: 1, upToDate: 2 }));
    expect(attentionHtml).toContain("modUpdatesCard--healthy");
    expect(attentionHtml).toContain("No updates available");
    expect(attentionHtml).not.toContain("attention");
    expect(attentionHtml).not.toContain("review");
    expect(attentionHtml).not.toContain("installed");
    expect(render(updatePlan({ safeUpdates: 1 }), false)).toBe("");
  });

  it("renders the clickable update count when updates are available", () => {
    const render = (plan: ModUpdatePlan | null, canView = true) => renderToStaticMarkup(createElement(ModHealthPanel, {
      updatePlan: plan,
      canView,
      onOpenMods: () => undefined
    }));

    const html = render(updatePlan({ safeUpdates: 2, reviewUpdates: 1, upToDate: 1 }));
    expect(html).toContain("<button");
    expect(html).toContain("<strong>Mod updates</strong>");
    expect(html).toContain("3 updates available");
    expect(html).toContain("<strong>3</strong>");
    expect(html).toContain("Open Mods, 3 mod updates available");
    expect(html).not.toContain("installed");
    expect(html).not.toContain("Safe");
    expect(html).not.toContain("Review");
    expect(html).not.toContain("Attention");
  });

  it("offers a separate refresh action without nesting it in the card link", () => {
    const html = renderToStaticMarkup(createElement(ModHealthPanel, {
      updatePlan: updatePlan({ safeUpdates: 1 }),
      onOpenMods: () => undefined,
      onRefresh: () => undefined
    }));

    expect(html).toContain('class="modUpdatesCardOpen"');
    expect(html).toContain('aria-label="Recheck mods for updates"');
    expect(html).toContain('<path d="M20 6v5h-5"></path>');
    expect(html).toContain('<span class="modUpdatesRefreshLabel">Refresh</span>');
    expect(html).toContain('uiButton--secondary');
    expect(html).toContain('</button><button aria-label="Recheck mods for updates"');
  });

  it("includes update names, icons, and version transitions for the wide layout", () => {
    const entry: ModUpdatePlanEntry = {
      filename: "lithium.jar",
      displayName: "Lithium",
      iconUrl: "/api/modrinth/icons/lithium.png",
      currentVersion: "0.14.8",
      currentFilename: "lithium.jar",
      targetVersion: "0.15.0",
      targetFilename: "lithium-0.15.0.jar",
      channel: "release",
      status: "safe_update",
      reason: "Compatible update",
      safeBatchEligible: true,
      acknowledgementRequired: false,
      enabled: true
    };
    const html = renderToStaticMarkup(createElement(ModHealthPanel, {
      updatePlan: updatePlan({ safeUpdates: 1, upToDate: 3 }, [entry]),
      onOpenMods: () => undefined
    }));

    expect(html).toContain("Lithium");
    expect(html).toContain("/api/modrinth/icons/lithium.png");
    expect(html).toContain("0.14.8");
    expect(html).toContain("0.15.0");
    expect(html).not.toContain("modUpdatesListItem--placeholder");
    expect(html.match(/modUpdatesListItem/g)).toHaveLength(1);
  });

  it("fills all predefined update slots with real updates", () => {
    const entries = Array.from({ length: 3 }, (_, index): ModUpdatePlanEntry => ({
      filename: `mod-${index}.jar`,
      displayName: `Mod ${index}`,
      iconUrl: undefined,
      currentVersion: "1.0.0",
      currentFilename: `mod-${index}.jar`,
      targetVersion: "1.1.0",
      targetFilename: `mod-${index}-1.1.0.jar`,
      channel: "release",
      status: "safe_update",
      reason: "Compatible update",
      safeBatchEligible: true,
      acknowledgementRequired: false,
      enabled: true
    }));
    const html = renderToStaticMarkup(createElement(ModHealthPanel, {
      updatePlan: updatePlan({ safeUpdates: 3 }, entries),
      onOpenMods: () => undefined
    }));

    expect(html).not.toContain("modUpdatesListItem--placeholder");
    expect(html.indexOf("Mod 0")).toBeLessThan(html.indexOf("Mod 1"));
    expect(html.indexOf("Mod 1")).toBeLessThan(html.indexOf("Mod 2"));
  });
});

describe("upcoming schedule summary", () => {
  const now = new Date("2026-07-11T12:00:00.000Z");
  const upcomingAt = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  it("shows up to four enabled future schedules from the next 24 hours", () => {
    const snapshot = buildUpcomingScheduleSnapshot([
      schedule({ id: "schedule-6", nextRunAt: "2026-07-11T18:00:00.000Z" }),
      schedule({ id: "schedule-1", nextRunAt: "2026-07-11T13:00:00.000Z" }),
      schedule({ id: "schedule-3", nextRunAt: "2026-07-11T15:00:00.000Z" }),
      schedule({ id: "schedule-5", nextRunAt: "2026-07-11T17:00:00.000Z" }),
      schedule({ id: "schedule-2", nextRunAt: "2026-07-11T14:00:00.000Z" }),
      schedule({ id: "schedule-4", nextRunAt: "2026-07-11T16:00:00.000Z" }),
      schedule({ id: "past", nextRunAt: "2026-07-11T11:59:00.000Z" }),
      schedule({ id: "disabled", enabled: false, nextRunAt: "2026-07-11T12:30:00.000Z" })
    ], now);

    expect(snapshot.schedules.map(({ id }) => id)).toEqual(["schedule-1", "schedule-2", "schedule-3", "schedule-4"]);
    expect(snapshot.remainingInNext24Hours).toBe(2);
  });

  it("still shows the nearest future schedule when it is beyond the 24-hour window", () => {
    const snapshot = buildUpcomingScheduleSnapshot([
      schedule({ id: "later", nextRunAt: "2026-07-13T12:00:00.000Z" }),
      schedule({ id: "nearest", nextRunAt: "2026-07-12T13:00:00.000Z" })
    ], now);

    expect(snapshot.schedules.map(({ id }) => id)).toEqual(["nearest"]);
    expect(snapshot.remainingInNext24Hours).toBe(0);
  });

  it("handles disabled-only, invalid, past, and empty schedules", () => {
    const emptySnapshot = { schedules: [], remainingInNext24Hours: 0 };
    expect(buildUpcomingScheduleSnapshot([schedule({ enabled: false })], now)).toEqual(emptySnapshot);
    expect(buildUpcomingScheduleSnapshot([schedule({ nextRunAt: "invalid" })], now)).toEqual(emptySnapshot);
    expect(buildUpcomingScheduleSnapshot([schedule({ nextRunAt: "2026-07-11T11:59:00.000Z" })], now)).toEqual(emptySnapshot);
    expect(buildUpcomingScheduleSnapshot([], now)).toEqual(emptySnapshot);
  });

  it("formats upcoming and completed times", () => {
    expect(formatRelativeScheduleTime("2026-07-11T13:00:00.000Z", now)).toBe("in 1h");
    expect(formatRelativeScheduleTime("2026-07-11T11:55:00.000Z", now)).toBe("5m ago");
  });

  it("renders empty and permission-limited states", () => {
    const props = { schedules: [], formatDate: String, onOpenSchedules: () => undefined };
    expect(renderToStaticMarkup(createElement(SchedulePanel, props))).toContain("No schedules configured");
    expect(renderToStaticMarkup(createElement(SchedulePanel, { ...props, canView: false }))).toContain("View schedules permission is required");
  });

  it("renders at most four upcoming schedules and summarizes the rest", () => {
    const html = renderToStaticMarkup(createElement(SchedulePanel, {
      schedules: Array.from({ length: 6 }, (_, index) => schedule({
        id: `schedule-${index}`,
        name: `Task ${index}`,
        nextRunAt: upcomingAt(index + 1),
        activeRuns: index === 0 ? [{ id: "active", scheduleId: "schedule-0", scheduleName: "Past activity", status: "running", startedAt: "2026-07-11T11:58:00.000Z", stepCount: 2, currentStep: "Saving world", cancellable: true }] : [],
        recentRuns: index === 0 ? [{ id: "recent", scheduleId: "schedule-0", scheduleName: "Past activity", status: "success", ranAt: "2026-07-11T10:00:00.000Z" }] : []
      })),
      formatDate: (timestamp) => new Date(timestamp).toISOString(),
      onOpenSchedules: () => undefined
    }));

    expect(html).toContain(">Schedule<");
    expect(html).toContain(">Next up<");
    expect((html.match(/class="scheduleUpcomingItem"/g) ?? []).length).toBe(4);
    expect(html).toContain("2 more schedules in the next 24 hours");
    expect(html).not.toContain("Task 4");
    expect(html).not.toContain("Task 5");
    expect(html).not.toContain("Past activity");
    expect(html).not.toContain("Last run");
    expect(html).not.toContain("Running now");
  });

  it("uses the full configured date and time when relative timestamps are disabled", () => {
    const nextRunAt = upcomingAt(2);
    const value = schedule({
      nextRunAt,
      recentRuns: [{ id: "recent", scheduleId: "schedule-1", scheduleName: "Nightly restart", status: "success", ranAt: "2026-07-11T10:00:00.000Z" }]
    });
    const html = renderToStaticMarkup(createElement(SchedulePanel, {
      schedules: [value],
      formatDate: (timestamp) => `FULL ${new Date(timestamp).toISOString()}`,
      relativeTimestamps: false,
      onOpenSchedules: () => undefined
    }));

    expect(html).toContain(`FULL ${nextRunAt}`);
    expect(html).not.toContain("FULL 2026-07-11T10:00:00.000Z");
    expect(html).not.toContain(" ago");
  });
});
