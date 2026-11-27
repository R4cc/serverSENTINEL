import type { ServerTimelineEvent, ServerTimelineScheduleMarker } from "../types";

/**
 * Types shared by the timeline component and its chart builders. They lived in ServerTimeline.tsx,
 * which made the pure chart modules import the component that imports them -- an import cycle
 * that kept the helpers from being used or tested without the 1,600-line component.
 */
export type SeriesKey = "cpuUtilizationPercent" | "memoryUsageBytes" | "networkRxBytesPerSecond" | "networkTxBytesPerSecond" | "playersOnline";

export type TimelineWindow = { from: number; to: number };

export type TimelineMarker = {
  id: string;
  occurredAt: number;
  label: string;
  tone: "server" | "automation";
  event?: ServerTimelineEvent;
  occurrences?: number;
  restart?: {
    durationSeconds: number;
    events: [ServerTimelineEvent, ServerTimelineEvent];
  };
  schedule?: ServerTimelineScheduleMarker;
};

export type MarkerCluster = {
  id: string;
  occurredAt: number;
  markers: TimelineMarker[];
  tone: TimelineMarker["tone"];
  slot: number;
  slotCount: number;
};
