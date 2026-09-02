import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState
} from "@tanstack/react-table";
import { Activity, ChevronDown, Globe, MapPin, Wrench } from "lucide-react";
import type { ManagedServer, PlayerActivityHour, PlayerInsightsEntry, PlayerInsightsResponse, PlayerRegionSummary } from "../types";
import { InlineState } from "../components/InlineState";
import { PlayerHead } from "../components/PlayerHead";
import { SortHeaderButton, TablePagination, headerAriaSort } from "../components/TableControls";
import { Banner, Button, EmptyState, FormField, HelpTooltip, LoadingLabel, MetricTile, PanelHeader, SkeletonBlock, StatusBadge, Surface } from "../components/UiPrimitives";
import { playerHeadVersion } from "../utils/playerHeads";
import { PlayerGeographyMap } from "../features/players/PlayerGeographyMap";
import { ConnectionQualityChart } from "../features/players/ConnectionQualityChart";
import {
  countryFlag,
  formatDistance,
  formatPing,
  formatLocation,
  formatMaintenanceWindow,
  latencyTone,
  locationAccuracyPresentation,
  observedActivityHours,
  peakActivity,
  playerInsightsRanges,
  unknownValue,
  type PlayerInsightsRange
} from "../features/players/playerInsightsView";

/**
 * The Players workspace.
 *
 * Every figure on this page is either observed or derived from something observed, and the ones
 * that are estimated say so in their own label rather than in a footnote. Where the panel could not
 * derive something — no GeoLite2 database, no server location, not enough history — the card says
 * which of those it was and what would fix it, because those are the states a real installation
 * spends its first week in.
 */

const rosterPageSize = 8;
type PlayerMapScope = "online" | "all";

function LocationAccuracyBadge({ location }: { location: NonNullable<PlayerInsightsEntry["location"]> }) {
  const tooltipId = useId();
  const accuracy = locationAccuracyPresentation(location)!;
  return (
    <span className="playerLocationAccuracy">
      <StatusBadge
        className={`playerAccuracyBadge playerAccuracyBadge--${accuracy.tone}`}
        tabIndex={0}
        aria-describedby={tooltipId}
      >
        {accuracy.label}
      </StatusBadge>
      <span className="playerAccuracyTooltip" id={tooltipId} role="tooltip">{accuracy.description}</span>
    </span>
  );
}

function PlayerLocationDisplay({ location }: { location: PlayerInsightsEntry["location"] }) {
  if (!location) return <span className="playerLocation"><span className="playerLocationText">No location resolved</span></span>;
  const flag = countryFlag(location.countryCode);
  const label = formatLocation(location);
  return (
    <span className="playerLocation">
      <span className="playerLocationLabel" title={label}>
        {flag && <span className="playerCountryFlag" aria-hidden="true">{flag}</span>}
        <span className="playerLocationText">{label}</span>
      </span>
      <LocationAccuracyBadge location={location} />
    </span>
  );
}

function ActivityHours({ hours, timeZone }: { hours: readonly PlayerActivityHour[]; timeZone: string }) {
  const peak = peakActivity(hours);
  const observed = observedActivityHours(hours);
  if (observed === 0) {
    return <EmptyState compact title="No activity recorded yet" />;
  }
  return (
    <div className="playerActivityHours">
      <ol className="playerActivityBars" aria-label={`Average players by hour of the day, ${timeZone}`}>
        {hours.map((hour) => {
          const clock = `${String(hour.hour).padStart(2, "0")}:00`;
          const description = hour.samples === 0
            ? `${clock}, not observed yet`
            : `${clock}, ${hour.averagePlayers.toFixed(1)} players on average, peak ${hour.peakPlayers}`;
          return (
            <li
              key={hour.hour}
              className={`playerActivityBar ${hour.samples === 0 ? "playerActivityBar--unobserved" : ""}`.trim()}
              style={{ "--player-activity-height": `${peak ? Math.round((hour.averagePlayers / peak) * 100) : 0}%` } as Record<string, string>}
              tabIndex={0}
              aria-label={description}
            >
              <span className="playerActivityBarFill" />
              <span className="playerActivityHourLabel" aria-hidden="true">
                <strong>{clock}</strong>
                <small>{hour.samples === 0 ? "Not observed" : `${hour.averagePlayers.toFixed(1)} avg · ${hour.peakPlayers} peak`}</small>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="playerActivityScale">
        <span>00:00</span>
        <span>12:00</span>
        <span>23:00</span>
      </div>
      {observed < 24 && (
        <p className="playerCardNote">
          {observed} of 24 hours observed so far. A maintenance window is only suggested once every hour has been seen.
        </p>
      )}
    </div>
  );
}

function RegionTable({ regions }: { regions: readonly PlayerRegionSummary[] }) {
  if (regions.length === 0) {
    return <EmptyState compact title="No regions yet" />;
  }
  return (
    <table className="playerRegionTable uiDataTable" aria-label="Player regions">
      <thead className="uiTableHeader">
        <tr>
          <th scope="col">Region</th>
          <th scope="col">Share</th>
          <th scope="col" className="playerNumericColumn">Players</th>
          <th scope="col" className="playerNumericColumn">Ping</th>
        </tr>
      </thead>
      <tbody>
        {regions.map((region) => (
          <tr className="uiTableRow" key={region.continentCode}>
            <th scope="row">{region.continent}</th>
            <td>
              <span className="playerRegionShareCell">
                <span className="playerRegionBar" aria-hidden="true">
                  <span className="playerRegionBarFill" style={{ "--player-region-share": `${Math.round(region.share * 100)}%` } as Record<string, string>} />
                </span>
                <span className="playerRegionShare">{Math.round(region.share * 100)}%</span>
              </span>
            </td>
            <td className="playerNumericColumn">{region.players}</td>
            <td className={`playerNumericColumn playerLatency playerLatency--${latencyTone(region.averagePingMs)}`}>
              {formatPing(region.averagePingMs)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PlayerRoster({
  players,
  serverId,
  playerHeadsEnabled,
  formatDate,
  formatNumber
}: {
  players: readonly PlayerInsightsEntry[];
  serverId: string;
  playerHeadsEnabled: boolean;
  formatDate: (value: string | number | Date) => string;
  formatNumber: (value: number) => string;
}) {
  const [page, setPage] = useState(0);
  const [sorting, setSorting] = useState<SortingState>([]);
  // Only a different server starts the reader over. The roster refreshes every thirty seconds and
  // its length moves whenever anyone joins or leaves, so resetting on that threw whoever was
  // reading page three back to page one for no reason they could see. A page that no longer exists
  // is clamped below instead.
  useEffect(() => setPage(0), [serverId]);
  const columns = useMemo<ColumnDef<PlayerInsightsEntry>[]>(() => [
    { id: "player", accessorKey: "player", header: "Player" },
    { id: "location", accessorFn: (entry) => formatLocation(entry.location), header: "Location" },
    { id: "distanceKm", accessorKey: "distanceKm", header: "Distance" },
    { id: "pingMs", accessorKey: "pingMs", header: "Ping" },
    { id: "lastSeenAt", accessorKey: "lastSeenAt", header: "Last seen" }
  ], []);
  const tableData = useMemo(() => [...players], [players]);
  const table = useReactTable({
    data: tableData,
    columns,
    getRowId: (entry) => `${entry.serverId}:${entry.player}`,
    state: { sorting },
    onSortingChange: (updater) => {
      setSorting(updater);
      setPage(0);
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });
  if (players.length === 0) {
    return <EmptyState compact title="No players recorded yet" />;
  }
  const rows = table.getRowModel().rows;
  const pages = Math.max(1, Math.ceil(rows.length / rosterPageSize));
  const current = Math.min(page, pages - 1);
  const visible = rows.slice(current * rosterPageSize, current * rosterPageSize + rosterPageSize);
  const headVersion = playerHeadVersion();

  return (
    <>
      <table className="playerRosterTable uiDataTable" aria-label="Player roster">
        <thead className="uiTableHeader">
          <tr>
            {table.getHeaderGroups()[0]?.headers.map((header) => (
              <th
                key={header.id}
                scope="col"
                className={header.id === "player" || header.id === "location" ? undefined : "playerNumericColumn"}
                aria-sort={headerAriaSort(header)}
              >
                <SortHeaderButton header={header}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </SortHeaderButton>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => {
            const entry = row.original;
            return (
              <tr key={`${entry.serverId}:${entry.player}`} className={`uiTableRow ${entry.online ? "playerRosterRow--online" : ""}`.trim()}>
                <th scope="row">
                  <span className="playerIdentity">
                    {playerHeadsEnabled && (
                      <PlayerHead serverId={entry.serverId} playerName={entry.player} version={headVersion} enabled />
                    )}
                    <span className="playerIdentityCopy">
                      <strong>{entry.player}</strong>
                      {entry.online && <small className="playerOnlineFlag">Online</small>}
                    </span>
                  </span>
                </th>
                <td>
                  <PlayerLocationDisplay location={entry.location} />
                </td>
                <td className="playerNumericColumn">{formatDistance(entry.distanceKm, formatNumber)}</td>
                <td className={`playerNumericColumn playerLatency playerLatency--${latencyTone(entry.pingMs)}`}>
                  {formatPing(entry.pingMs)}
                </td>
                <td className="playerNumericColumn" data-label="Last seen">{entry.lastSeenAt ? formatDate(entry.lastSeenAt) : unknownValue}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <TablePagination
        pageIndex={current}
        pageSize={rosterPageSize}
        totalItems={rows.length}
        itemLabel="players"
        onPageChange={setPage}
      />
    </>
  );
}

function ServerLocationForm({
  address,
  error,
  canManage,
  busy,
  onSave
}: {
  address: string;
  error?: string;
  canManage: boolean;
  busy: boolean;
  onSave: (address: string) => void;
}) {
  const [draft, setDraft] = useState(address);
  const [expanded, setExpanded] = useState(!address || Boolean(error));
  const disclosureId = useId();
  useEffect(() => {
    setDraft(address);
    setExpanded(!address || Boolean(error));
  }, [address, error]);
  if (!canManage) {
    return <p className="playerCardNote">Distances are measured from {address || "a server address that has not been set"}. Configuring it needs the player insights management permission.</p>;
  }
  const form = (
    <form
      className="playerLocationForm"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSave(draft.trim());
      }}
    >
      <FormField
        label="Server address"
        htmlFor="player-insights-server-address"
        help={<HelpTooltip label="server address">Use the public hostname or IP players connect to. It is resolved locally through GeoLite2 and provides the starting point for distance estimates.</HelpTooltip>}
        error={error}
      >
        <input
          id="player-insights-server-address"
          className="uiInput"
          value={draft}
          placeholder="play.example.net"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
        />
      </FormField>
      <Button type="submit" variant="secondary" compact disabled={busy || draft.trim() === address}>Save</Button>
    </form>
  );

  if (!address) return form;
  return (
    <div className="playerLocationDisclosure">
      <Button
        variant="ghost"
        className="playerLocationDisclosureToggle"
        aria-expanded={expanded}
        aria-controls={disclosureId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="playerLocationDisclosureCopy">
          <strong>Server address</strong>
          <small>{address}</small>
        </span>
        <ChevronDown aria-hidden="true" />
      </Button>
      {expanded && <div className="playerLocationDisclosureBody" id={disclosureId}>{form}</div>}
    </div>
  );
}

export function PlayersPage({
  active,
  server,
  serverRunning,
  insights,
  loading,
  error,
  busy,
  range,
  onRangeChange,
  onReload,
  onSaveServerAddress,
  onRefreshGeoDatabase,
  canManage,
  playerHeadsEnabled,
  compactLayout,
  formatDate,
  formatNumber
}: {
  active: boolean;
  server: ManagedServer;
  serverRunning: boolean;
  insights: PlayerInsightsResponse | null;
  loading: boolean;
  error: string;
  busy: boolean;
  range: PlayerInsightsRange;
  onRangeChange: (range: PlayerInsightsRange) => void;
  onReload: () => void;
  onSaveServerAddress: (address: string) => void;
  onRefreshGeoDatabase: () => void;
  canManage: boolean;
  playerHeadsEnabled: boolean;
  /** Phone layout. The chart needs it because its geometry is drawn in viewBox units, not pixels. */
  compactLayout: boolean;
  formatDate: (value: string | number | Date) => string;
  formatNumber: (value: number) => string;
}) {
  const [mapScope, setMapScope] = useState<PlayerMapScope>("online");
  if (!active) return null;
  if (loading) {
    return (
      <section className="tabPage playersPage layoutWide" aria-busy="true">
        <LoadingLabel>Loading player insights</LoadingLabel>
        <div className="playerSummaryGrid" aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => <SkeletonBlock key={index} className="playerSummarySkeleton" />)}
        </div>
        <SkeletonBlock className="playerMapSkeleton" />
      </section>
    );
  }

  const serverLocation = insights?.serverLocations.find((entry) => entry.serverId === server.id);
  const geoDatabase = insights?.geoDatabase;
  const summary = insights?.summary;
  const pingMeasurement = insights?.pingMeasurements.find((entry) => entry.serverId === server.id);
  const mapPlayers = mapScope === "online"
    ? insights?.players.filter((entry) => entry.online) ?? []
    : insights?.players ?? [];
  return (
    <section className="tabPage playersPage layoutWide">
      {error && (
        <InlineState
          tone="error"
          title="Player insights could not be refreshed"
          message={error}
          actionLabel="Retry"
          onAction={onReload}
        />
      )}

      {geoDatabase && !geoDatabase.available && (
        <Banner
          tone={geoDatabase.configured ? "warning" : "info"}
          title={geoDatabase.configured ? "No GeoLite2 database is loaded yet" : "Player geography is not configured"}
          message={geoDatabase.error
            ?? (geoDatabase.configured
              ? "The panel is downloading the GeoLite2 City database. Player names and activity are shown meanwhile."
              : "Add a MaxMind account ID and license key in Settings → Integrations. The panel downloads the GeoLite2 City database and looks addresses up against its own copy, so no player address is sent to MaxMind or any other geolocation service, and none is stored.")}
          action={canManage && geoDatabase.configured
            ? <Button variant="secondary" compact disabled={busy} onClick={onRefreshGeoDatabase}>Check now</Button>
            : undefined}
        />
      )}

      <div className="playerSummaryGrid">
        <MetricTile
          variant="summary"
          icon={<Activity aria-hidden="true" />}
          iconPlacement="leading"
          tone={latencyTone(summary?.medianPingMs)}
          label="Median ping"
          value={formatPing(summary?.medianPingMs)}
          detail={pingMeasurement?.onlinePlayers
            ? `${pingMeasurement.measuredPlayers} of ${pingMeasurement.onlinePlayers} online measured`
            : "No players online"}
        />
        <MetricTile
          variant="summary"
          icon={<Globe aria-hidden="true" />}
          iconPlacement="leading"
          label="Countries"
          value={summary ? String(summary.countries) : unknownValue}
          detail={`${summary?.locatedPlayers ?? 0} of ${summary?.knownPlayers ?? 0} players placed`}
        />
        <MetricTile
          variant="summary"
          icon={<MapPin aria-hidden="true" />}
          iconPlacement="leading"
          label="Most active region"
          value={summary?.mostActiveRegion?.continent ?? unknownValue}
          detail={summary?.mostActiveRegion ? `${Math.round(summary.mostActiveRegion.share * 100)}% of placed players` : "No region resolved yet"}
        />
        <MetricTile
          variant="summary"
          icon={<Wrench aria-hidden="true" />}
          iconPlacement="leading"
          label="Quietest hours"
          value={formatMaintenanceWindow(summary?.maintenanceWindow, insights?.timeZone ?? "UTC")}
          detail={summary?.maintenanceWindow ? "Lowest average player count" : "Needs a full day of history"}
        />
      </div>

      <div className="playerGeographyRow">
        <Surface className="playerCard playerGeographyCard">
          <PanelHeader
            title="Player geography"
            description={serverLocation?.location
              ? `Measured from ${serverLocation.location.label}`
              : serverLocation?.address
                ? `${serverLocation.address} could not be placed; distances are unavailable.`
                : "Set the server address for distance estimates."}
            help={<HelpTooltip label="player geography">Locations are approximate. Player heads mark locations, stacked heads are clusters, the server badge marks the host, and rings show GeoLite2 accuracy. Zooming separates nearby clusters.</HelpTooltip>}
            actions={(
              <div className="playerMapScopeSwitch" role="group" aria-label="Players shown on map">
                <Button
                  variant={mapScope === "online" ? "secondary" : "ghost"}
                  compact
                  aria-pressed={mapScope === "online"}
                  onClick={() => setMapScope("online")}
                >
                  Online
                </Button>
                <Button
                  variant={mapScope === "all" ? "secondary" : "ghost"}
                  compact
                  aria-pressed={mapScope === "all"}
                  onClick={() => setMapScope("all")}
                >
                  All time
                </Button>
              </div>
            )}
          />
          <PlayerGeographyMap
            players={mapPlayers}
            serverLocation={serverLocation?.location}
            serverName={server.displayName}
            serverRunning={serverRunning}
            playerHeadsEnabled={playerHeadsEnabled}
          />
          <ServerLocationForm
            address={serverLocation?.address ?? ""}
            error={serverLocation?.error}
            canManage={canManage}
            busy={busy}
            onSave={onSaveServerAddress}
          />
        </Surface>

        <Surface className="playerCard playerRegionCard">
          <PanelHeader title="Region overview" />
          <RegionTable regions={insights?.regions ?? []} />
        </Surface>
      </div>

      <div className="playerAnalysisRow">
        <Surface className="playerCard playerLatencyCard">
          <PanelHeader
            title="Connection quality"
            help={<HelpTooltip label="connection quality">Ping is the Linux TCP round-trip time measured on the server host for directly matched, currently connected players. Proxies and unsupported nodes may leave it unavailable. {pingMeasurement?.message ?? "Hover or focus the chart to inspect a moment."}</HelpTooltip>}
            actions={(
              <div className="playerRangeSwitch" role="group" aria-label="Latency history range">
                {playerInsightsRanges.map((option) => (
                  <Button
                    key={option.id}
                    variant={option.id === range ? "secondary" : "ghost"}
                    compact
                    aria-pressed={option.id === range}
                    onClick={() => onRangeChange(option.id)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            )}
          />
          <ConnectionQualityChart points={insights?.latency ?? []} timeZone={insights?.timeZone ?? "UTC"} compact={compactLayout} />
        </Surface>

        <Surface className="playerCard playerActivityCard">
          <PanelHeader title="Activity by hour" help={<HelpTooltip label="activity by hour">Average players for each hour of the day in {insights?.timeZone ?? "UTC"}.</HelpTooltip>} />
          <ActivityHours hours={insights?.activityHours ?? []} timeZone={insights?.timeZone ?? "UTC"} />
        </Surface>
      </div>

      <Surface className="playerCard playerRosterCard">
        <PanelHeader
          title="Players"
          help={<HelpTooltip label="player data">Locations are approximate. Ping is measured from the player's active TCP connection and is unavailable for offline or unmatched players.</HelpTooltip>}
          actions={summary && (
            <StatusBadge tone={summary.onlinePlayers ? "success" : "neutral"}>
              {summary.onlinePlayers} online · {summary.knownPlayers} known
            </StatusBadge>
          )}
        />
        <PlayerRoster
          players={insights?.players ?? []}
          serverId={server.id}
          playerHeadsEnabled={playerHeadsEnabled}
          formatDate={formatDate}
          formatNumber={formatNumber}
        />
      </Surface>

      <footer className="playerAttribution">
        <p>{insights?.attribution}</p>
        {geoDatabase?.buildDate && <HelpTooltip label="player location privacy">Database built {formatDate(geoDatabase.buildDate)}. Addresses are looked up locally, are not stored, and are not sent to MaxMind or another geolocation service.</HelpTooltip>}
      </footer>
    </section>
  );
}
