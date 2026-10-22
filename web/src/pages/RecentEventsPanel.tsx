import { useEffect, useMemo, useState, type ReactNode } from "react";
import { flexRender, useTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { sortableTableFeatures, type SortableTableFeatures } from "../utils/tableFeatures";
import type { ServerEvent } from "../types";
import { Button, EmptyState, HelpTooltip, LoadingLabel, SkeletonBlock } from "../components/UiPrimitives";
import { EventIcon, type EventIconKind } from "../components/EventIcon";
import { SortHeaderButton, TablePagination, headerAriaSort } from "../components/TableControls";
import { InlineState } from "../components/InlineState";
import { usePlayerHead } from "../components/PlayerHead";
import { playerHeadVersion } from "../utils/playerHeads";
import { groupNearbyRepeatedEvents, playerEventSubject, playerReconnectWindowMs, samePlayerName } from "../utils/serverEvents";
import { formatRelativeTimestamp } from "../utils/format";
import { OverviewCard } from "./OverviewPage";

const serverEventsPageSize = 10;

export function eventDate(value: string | undefined, now = new Date()) {
  if (!value) return null;
  const timeOnly = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (timeOnly) {
    const date = new Date(now);
    date.setHours(Number(timeOnly[1]), Number(timeOnly[2]), Number(timeOnly[3]), 0);
    if (date.getTime() > now.getTime()) date.setDate(date.getDate() - 1);
    return date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatRelativeEventTime(value: string | undefined, now = new Date()) {
  const date = eventDate(value, now);
  if (!date) return value ? "Unknown" : "No timestamp";
  return formatRelativeTimestamp(date, now);
}

type RecentEventKind = EventIconKind;
export type ServerEventCategory = "player" | "server" | "automation";
type ServerEventFilter = "all" | ServerEventCategory;

const serverEventFilters: Array<{ id: ServerEventFilter; label: string }> = [
  { id: "all", label: "All events" },
  { id: "player", label: "Player activity" },
  { id: "server", label: "Server events" },
  { id: "automation", label: "Automation runs" }
];

export function serverEventCategory(event: ServerEvent): ServerEventCategory {
  if (event.eventType === "automation_run") return "automation";
  if (event.eventType === "player_joined" || event.eventType === "player_left") return "player";
  return "server";
}

function serverEventCategoryLabel(category: ServerEventCategory) {
  if (category === "player") return "Player activity";
  if (category === "automation") return "Automation run";
  return "Server event";
}

/** Event kinds whose subject is a player name, so the row can show that player's head. */
const playerHeadEventKinds = new Set<RecentEventKind>(["player_joined", "player_left", "player_reconnected"]);
/** Kinds that always collapse into one row, so an occurrence count would be misleading. */
const uncountedEventKinds = new Set<RecentEventKind>(["player_reconnected", "server_restarted"]);

type RecentEventGroup = {
  id: string;
  kind: RecentEventKind;
  severity: ServerEvent["severity"];
  title: string;
  details?: string;
  timestamp?: string;
  events: ServerEvent[];
};

function secondsBetween(first: ServerEvent, second: ServerEvent, now: Date) {
  const firstDate = eventDate(first.timestamp, now);
  const secondDate = eventDate(second.timestamp, now);
  if (!firstDate || !secondDate) return null;
  return Math.abs(firstDate.getTime() - secondDate.getTime()) / 1000;
}

function defaultEventDetails(event: ServerEvent) {
  if (event.eventType === "server_started") return undefined;
  if (event.details) return event.details;
  if (event.eventType === "player_left" && event.severity === "warning") return "The connection was lost";
  if (event.eventType === "mod_disabled") return "Review the mod configuration before the next restart";
  if (event.eventType === "server_crashed") return "Open the console or crash reports for the cause";
  return undefined;
}

function restartDowntimeDetails(duration: number) {
  if (duration < 2) return "Back online in under 2 seconds";
  if (duration < 60) return `Back online after ${Math.round(duration)} seconds`;
  const minutes = Math.round(duration / 6) / 10;
  return `Back online after ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function restartDetails(stopped: ServerEvent, duration: number) {
  const purpose = stopped.details?.trim();
  return [purpose, restartDowntimeDetails(duration)].filter(Boolean).join(" · ");
}

export function groupRecentEvents(events: ServerEvent[], now = new Date()): RecentEventGroup[] {
  const groups: RecentEventGroup[] = [];
  const repeatedGroups = groupNearbyRepeatedEvents(events, (event) => eventDate(event.timestamp, now)?.getTime() ?? null);

  for (let index = 0; index < repeatedGroups.length; index += 1) {
    const repeated = repeatedGroups[index];
    const event = repeated[0];
    const nextGroup = repeatedGroups[index + 1];
    const next = nextGroup?.length === 1 ? nextGroup[0] : undefined;
    const duration = next ? secondsBetween(event, next, now) : null;

    if (repeated.length > 1) {
      groups.push({
        id: repeated.map((item) => item.id).join(":"),
        kind: event.eventType,
        severity: event.severity,
        title: event.text,
        details: defaultEventDetails(event),
        timestamp: event.timestamp,
        events: repeated
      });
      continue;
    }

    if (
      event.eventType === "player_joined"
      && next?.eventType === "player_left"
      && samePlayerName(playerEventSubject(event), playerEventSubject(next))
      && duration !== null
      && duration * 1_000 <= playerReconnectWindowMs
    ) {
      const player = playerEventSubject(event);
      groups.push({
        id: `${event.id}:${next.id}`,
        kind: "player_reconnected",
        severity: "success",
        title: `${player} reconnected`,
        details: duration < 2 ? "Offline only momentarily" : `Offline for ${Math.round(duration)} seconds`,
        timestamp: event.timestamp,
        events: [event, next]
      });
      index += 1;
      continue;
    }

    if (
      event.eventType === "server_started"
      && next?.eventType === "server_stopped"
      && duration !== null
      && duration <= 5 * 60
    ) {
      groups.push({
        id: `${event.id}:${next.id}`,
        kind: "server_restarted",
        severity: "success",
        title: "Server restarted",
        details: restartDetails(next, duration),
        timestamp: event.timestamp,
        events: [event, next]
      });
      index += 1;
      continue;
    }

    groups.push({
      id: event.id,
      kind: event.eventType,
      severity: event.severity,
      title: event.text,
      details: defaultEventDetails(event),
      timestamp: event.timestamp,
      events: [event]
    });
  }

  return groups;
}

export function recentEventPresentation(group: RecentEventGroup) {
  const playerEvent = group.events[0];
  const player = playerEventSubject(playerEvent) || group.title.replace(/\s+(?:joined|left|reconnected)$/i, "").trim();
  if (group.kind === "player_joined") {
    return { title: "Joined", subject: player, details: playerEvent.details };
  }
  if (group.kind === "player_left") {
    return {
      title: "Left",
      subject: player,
      details: playerEvent.details || (group.severity === "warning" ? "The connection was lost" : undefined)
    };
  }
  if (group.kind === "player_reconnected") {
    return { title: "Reconnected", subject: player, details: group.details };
  }
  return { title: group.title, subject: undefined, details: group.details };
}

function relatedEventLabel(group: RecentEventGroup) {
  if (group.events.length < 2) return null;
  return group.kind === "player_reconnected" || group.kind === "server_restarted"
    ? `${group.events.length} related events`
    : null;
}

function RelatedEventsTooltip({
  group,
  formatDate
}: {
  group: RecentEventGroup;
  formatDate: (value: string | number | Date) => string;
}) {
  const label = relatedEventLabel(group);
  if (!label) return null;
  const events = [...group.events].sort((left, right) => {
    const leftTime = eventDate(left.timestamp)?.getTime() ?? 0;
    const rightTime = eventDate(right.timestamp)?.getTime() ?? 0;
    return leftTime - rightTime;
  });

  return (
    <HelpTooltip
      className="serverEventRelatedTooltip"
      label={label}
      trigger={<span className="eventCount">{label}</span>}
    >
      <span className="serverEventRelatedList">
        {events.map((event) => {
          const timestamp = eventDate(event.timestamp);
          const details = defaultEventDetails(event);
          return (
            <span className="serverEventRelatedItem" key={event.id}>
              <span className="serverEventRelatedHeading">
                <strong>{event.text}</strong>
                {timestamp && <time dateTime={timestamp.toISOString()}>{formatDate(timestamp)}</time>}
              </span>
              {details && <small>{details}</small>}
            </span>
          );
        })}
      </span>
    </HelpTooltip>
  );
}

export function RecentEventsPanel({
  events,
  eventsStatus = "ok",
  active = true,
  formatDate,
  relativeTimestamps = true,
  serverId = "",
  playerHeadsEnabled = false,
  onOpenConsole,
  loading = false
}: {
  events: ServerEvent[];
  eventsStatus?: "ok" | "unavailable";
  active?: boolean;
  formatDate: (value: string | number | Date) => string;
  relativeTimestamps?: boolean;
  serverId?: string;
  playerHeadsEnabled?: boolean;
  onOpenConsole: () => void;
  loading?: boolean;
}) {
  const [filter, setFilter] = useState<ServerEventFilter>("all");
  const [page, setPage] = useState(0);
  const [sorting, setSorting] = useState<SortingState>([{ id: "timestamp", desc: true }]);
  const [now, setNow] = useState(() => new Date());
  const groupedEvents = useMemo(() => groupRecentEvents(events, now), [events, now]);
  const filteredEvents = useMemo(() => filter === "all"
    ? groupedEvents
    : groupedEvents.filter((group) => serverEventCategory(group.events[0]) === filter), [filter, groupedEvents]);
  const columns = useMemo<ColumnDef<SortableTableFeatures, RecentEventGroup>[]>(() => [
    {
      id: "event",
      accessorFn: (group) => {
        const presentation = recentEventPresentation(group);
        return `${presentation.title} ${presentation.subject ?? ""}`.trim();
      },
      header: "Event"
    },
    {
      id: "category",
      accessorFn: (group) => serverEventCategoryLabel(serverEventCategory(group.events[0])),
      header: "Category"
    },
    {
      id: "details",
      accessorFn: (group) => recentEventPresentation(group).details ?? relatedEventLabel(group) ?? "",
      header: "Purpose / details"
    },
    {
      id: "timestamp",
      accessorFn: (group) => eventDate(group.timestamp, now)?.getTime() ?? 0,
      header: "Time"
    }
  ], [now]);
  const tableData = useMemo(() => [...filteredEvents], [filteredEvents]);
  const table = useTable({
    features: sortableTableFeatures,
    data: tableData,
    columns,
    getRowId: (group) => group.id,
    state: { sorting },
    onSortingChange: (updater) => {
      setSorting(updater);
      setPage(0);
    }
  });
  const rows = table.getRowModel().rows;
  const pages = Math.max(1, Math.ceil(rows.length / serverEventsPageSize));
  const currentPage = Math.min(page, pages - 1);
  const pageRows = rows.slice(currentPage * serverEventsPageSize, currentPage * serverEventsPageSize + serverEventsPageSize);
  const headVersion = playerHeadVersion(now.getTime());
  const filterCounts = useMemo(() => groupedEvents.reduce<Record<ServerEventCategory, number>>((counts, group) => {
    counts[serverEventCategory(group.events[0])] += 1;
    return counts;
  }, { player: 0, server: 0, automation: 0 }), [groupedEvents]);

  useEffect(() => {
    if (!active) return undefined;
    const updateNow = () => {
      if (!document.hidden) setNow(new Date());
    };
    updateNow();
    const timer = window.setInterval(updateNow, 30_000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => setPage(0), [filter, serverId]);

  return (
    <OverviewCard
      className="eventsPanel"
      title="Server events"
      actions={<Button variant="ghost" compact className="textLinkButton" onClick={onOpenConsole}>View full log</Button>}
      loading={loading}
    >
      <div className="serverEventsBody">
        <div className="serverEventFilters" role="group" aria-label="Filter server events">
          {serverEventFilters.map((option) => {
            const count = option.id === "all" ? groupedEvents.length : filterCounts[option.id];
            return (
              <Button
                key={option.id}
                variant="ghost"
                compact
                className={filter === option.id ? "active" : undefined}
                aria-pressed={filter === option.id}
                onClick={() => setFilter(option.id)}
              >
                {option.label}<span className="serverEventFilterCount">{count}</span>
              </Button>
            );
          })}
        </div>
        {loading && <LoadingLabel>Loading server events</LoadingLabel>}
        {loading ? (
          <div className="serverEventsSkeleton" aria-hidden="true">
            {Array.from({ length: 5 }, (_, index) => (
              <div className="eventSkeletonRow" key={index}>
                <SkeletonBlock className="eventMarkerSkeleton" />
                <SkeletonBlock className="eventTextSkeleton" />
                <SkeletonBlock className="eventTimeSkeleton" />
              </div>
            ))}
          </div>
        ) : rows.length ? (
          <div className="serverEventsTableViewport uiTableViewport">
            <table className="serverEventsTable uiDataTable" aria-label="Server events">
              <thead className="uiTableHeader">
                <tr>
                  {table.getHeaderGroups()[0]?.headers.map((header) => (
                    <th key={header.id} scope="col" aria-sort={headerAriaSort(header)}>
                      <SortHeaderButton header={header}>
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </SortHeaderButton>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  const group = row.original;
                  const timestamp = eventDate(group.timestamp, now);
                  const presentation = recentEventPresentation(group);
                  const playerName = playerHeadEventKinds.has(group.kind) ? presentation.subject : undefined;
                  const occurrenceCount = group.events.length > 1 && !uncountedEventKinds.has(group.kind) ? group.events.length : 0;
                  const category = serverEventCategory(group.events[0]);
                  return (
                    <tr className={`serverEventRow ${group.severity} eventKind--${group.kind} uiTableRow`} key={group.id}>
                      <th scope="row">
                        <span className="serverEventIdentity">
                          <RecentEventMarker
                            kind={group.kind}
                            playerName={playerName}
                            serverId={serverId}
                            playerHeadsEnabled={playerHeadsEnabled}
                            version={headVersion}
                          >
                            {occurrenceCount > 0 && <span className="eventOccurrenceBadge">×{occurrenceCount}</span>}
                          </RecentEventMarker>
                          <span className="eventCopy">
                            <strong>{presentation.title}</strong>
                            {presentation.subject && <small className="eventSubject" title={presentation.subject}>{presentation.subject}</small>}
                            {occurrenceCount > 0 && <span className="srOnly">{occurrenceCount} occurrences</span>}
                          </span>
                        </span>
                      </th>
                      <td><span className={`serverEventCategory tone-${category}`}>{serverEventCategoryLabel(category)}</span></td>
                      <td className="serverEventDetails">
                        <span title={presentation.details}>{presentation.details || "—"}</span>
                        <RelatedEventsTooltip group={group} formatDate={formatDate} />
                      </td>
                      <td className="serverEventTime">
                        <time dateTime={timestamp?.toISOString()} title={relativeTimestamps && timestamp ? formatDate(timestamp) : undefined}>
                          {relativeTimestamps ? formatRelativeEventTime(group.timestamp, now) : timestamp ? formatDate(timestamp) : group.timestamp ? "Unknown" : "No timestamp"}
                        </time>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : eventsStatus === "unavailable" ? (
          <InlineState
            tone="warning"
            title="Events are unavailable"
            message="Open the console to inspect raw logs, or try again after the server writes new output."
            actionLabel="View full log"
            onAction={onOpenConsole}
          />
        ) : (
          <EmptyState
            compact
            className="eventEmpty"
            title={filter !== "all" && groupedEvents.length > 0 ? `No ${serverEventFilters.find((option) => option.id === filter)?.label.toLowerCase()} yet` : "No server events yet"}
            message={filter !== "all" && groupedEvents.length > 0 ? "Choose another filter to view the rest of the event history." : undefined}
          />
        )}
        {!loading && <TablePagination
          pageIndex={currentPage}
          pageSize={serverEventsPageSize}
          totalItems={rows.length}
          itemLabel="events"
          onPageChange={setPage}
        />}
      </div>
    </OverviewCard>
  );
}

function RecentEventMarker({
  kind,
  playerName,
  serverId,
  playerHeadsEnabled,
  version,
  children
}: {
  kind: RecentEventKind;
  playerName?: string;
  serverId: string;
  playerHeadsEnabled: boolean;
  version: number;
  children?: ReactNode;
}) {
  const { source, showHead, onHeadError } = usePlayerHead(serverId, playerName, version, playerHeadsEnabled);
  return (
    <span className={`eventIcon${showHead ? " eventIcon--withPlayerHead" : ""}`} aria-hidden="true">
      {showHead ? (
        <>
          <img
            className="eventPlayerHead"
            src={source}
            alt=""
            loading="lazy"
            decoding="async"
            onError={onHeadError}
          />
          <span className="eventPlayerIconBadge">
            <EventIcon kind={kind} />
          </span>
        </>
      ) : <EventIcon kind={kind} />}
      {children}
    </span>
  );
}
