import { nextCronRunsInTimeZone } from "@serversentinel/contracts";

type CronPreview = {
  /** Formatted in the timezone the expression is written in, which is the panel's. */
  occurrences: string[];
  /** Present only when the reader's clock disagrees with the panel's, which is the confusing case. */
  viewerNote?: string;
};

const scheduleZoneFormatters = new Map<string, Intl.DateTimeFormat>();

function scheduleZoneFormatter(timeZone: string) {
  let formatter = scheduleZoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    });
    scheduleZoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * What the expression will actually do, in both clocks that matter. The panel matches cron against
 * its own timezone while the page renders timestamps in the reader's, so an expression written as
 * 04:00 shows up as 06:00 two columns away; naming both removes the contradiction rather than
 * asking the reader to hold the offset in their head.
 */
export function buildCronPreview(
  cron: string,
  scheduleTimeZone: string,
  viewerTimeZone: string,
  formatViewerDate: (value: Date) => string,
  now: Date = new Date(),
  count = 3
): CronPreview | null {
  const runs = nextCronRunsInTimeZone(cron, scheduleTimeZone, now, count);
  if (!runs.length) return null;
  const formatter = scheduleZoneFormatter(scheduleTimeZone);
  return {
    occurrences: runs.map((run) => formatter.format(run)),
    viewerNote: viewerTimeZone && viewerTimeZone !== scheduleTimeZone
      ? `${formatViewerDate(runs[0])} in your time (${viewerTimeZone})`
      : undefined
  };
}
