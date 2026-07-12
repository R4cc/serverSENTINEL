import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { demoOverviewData, demoServer, demoStatus } from "../demo";
import { eventDate, formatRelativeEventTime, OverviewSummary } from "./OverviewPage";

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
  it("keeps six non-overlapping operational facts", () => {
    const server = demoServer();
    const html = renderToStaticMarkup(createElement(OverviewSummary, {
      server,
      status: demoStatus(server, true),
      dockerSocketMounted: true,
      activity: demoOverviewData(true).activity
    }));

    expect((html.match(/summaryTile/g) ?? []).length).toBe(6);
    expect(html).not.toContain(">Runtime<");
    expect(html).toContain(">Minecraft<");
    expect(html).toContain(">Fabric<");
  });

  it("skeletonizes all six values while keeping the summary structure", () => {
    const server = demoServer();
    const html = renderToStaticMarkup(createElement(OverviewSummary, {
      server,
      status: demoStatus(server, true),
      dockerSocketMounted: true,
      activity: demoOverviewData(true).activity,
      loading: true
    }));

    expect((html.match(/overviewSummaryValueSkeleton/g) ?? []).length).toBe(6);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading server summary");
  });
});
