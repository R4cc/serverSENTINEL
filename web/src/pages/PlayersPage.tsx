import { useEffect, useState, type FormEvent } from "react";
import { Activity, Globe, MapPin, Wrench } from "lucide-react";
import type { ManagedServer, PlayerActivityHour, PlayerInsightsEntry, PlayerInsightsResponse, PlayerLatencyPoint, PlayerRegionSummary } from "../types";
import { InlineState } from "../components/InlineState";
import { PlayerHead } from "../components/PlayerHead";
import { Banner, Button, EmptyState, FormField, MetricTile, PanelHeader, SkeletonBlock, Surface } from "../components/UiPrimitives";
import { playerHeadVersion } from "../utils/playerHeads";
import { PlayerGeographyMap } from "../features/players/PlayerGeographyMap";
import {
  describeLocationPrecision,
  formatDistance,
  formatEstimatedLatency,
  formatLocation,
  formatMaintenanceWindow,
  latencyTone,
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

function LatencyChart({ points, timeZone }: { points: readonly PlayerLatencyPoint[]; timeZone: string }) {
  const measured = points.filter((point) => point.medianEstimatedLatencyMs !== undefined);
  if (measured.length < 2) {
    return (
      <EmptyState
        compact
        title="Not enough history yet"
        message="The estimate is drawn from the joins and leaves the panel has recorded. It fills in as players come and go."
      />
    );
  }

  const width = 720;
  const height = 180;
  const padding = { top: 12, right: 8, bottom: 22, left: 40 };
  const from = points[0].at;
  const to = points.at(-1)!.at;
  const maximum = Math.max(...measured.map((point) => point.p95EstimatedLatencyMs ?? point.medianEstimatedLatencyMs!));
  const ceiling = Math.max(50, Math.ceil(maximum / 50) * 50);
  const x = (at: number) => padding.left + ((at - from) / Math.max(1, to - from)) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + (1 - value / ceiling) * (height - padding.top - padding.bottom);
  const line = (pick: (point: PlayerLatencyPoint) => number | undefined) => {
    const segments: string[] = [];
    let open = false;
    for (const point of points) {
      const value = pick(point);
      if (value === undefined) {
        open = false;
        continue;
      }
      segments.push(`${open ? "L" : "M"}${x(point.at).toFixed(1)} ${y(value).toFixed(1)}`);
      open = true;
    }
    return segments.join("");
  };
  const gridValues = [0, ceiling / 2, ceiling];
  const timeLabel = (at: number) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(at));

  return (
    <div className="playerLatencyChart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Estimated latency over time, peaking near ${ceiling} milliseconds`}>
        {gridValues.map((value) => (
          <g key={value}>
            <line className="playerChartGrid" x1={padding.left} y1={y(value)} x2={width - padding.right} y2={y(value)} />
            <text className="playerChartAxisLabel" x={padding.left - 6} y={y(value) + 4} textAnchor="end">{value} ms</text>
          </g>
        ))}
        <path className="playerChartLine playerChartLine--p95" d={line((point) => point.p95EstimatedLatencyMs)} />
        <path className="playerChartLine playerChartLine--median" d={line((point) => point.medianEstimatedLatencyMs)} />
        <text className="playerChartAxisLabel" x={padding.left} y={height - 6} textAnchor="start">{timeLabel(from)}</text>
        <text className="playerChartAxisLabel" x={width - padding.right} y={height - 6} textAnchor="end">{timeLabel(to)}</text>
      </svg>
      <ul className="playerChartLegend">
        <li><span className="playerChartSwatch playerChartSwatch--median" aria-hidden="true" />Median estimate</li>
        <li><span className="playerChartSwatch playerChartSwatch--p95" aria-hidden="true" />95th percentile</li>
      </ul>
    </div>
  );
}

function ActivityHours({ hours, timeZone }: { hours: readonly PlayerActivityHour[]; timeZone: string }) {
  const peak = peakActivity(hours);
  const observed = observedActivityHours(hours);
  if (observed === 0) {
    return <EmptyState compact title="No activity recorded yet" message="Hourly activity is read from the player counts the panel samples alongside CPU and memory." />;
  }
  return (
    <div className="playerActivityHours">
      <ol className="playerActivityBars" aria-label={`Average players by hour of the day, ${timeZone}`}>
        {hours.map((hour) => (
          <li
            key={hour.hour}
            className={`playerActivityBar ${hour.samples === 0 ? "playerActivityBar--unobserved" : ""}`.trim()}
            style={{ "--player-activity-height": `${peak ? Math.round((hour.averagePlayers / peak) * 100) : 0}%` } as Record<string, string>}
            title={hour.samples === 0
              ? `${String(hour.hour).padStart(2, "0")}:00 — not observed yet`
              : `${String(hour.hour).padStart(2, "0")}:00 — ${hour.averagePlayers.toFixed(1)} players on average, peak ${hour.peakPlayers}`}
          >
            <span className="playerActivityBarFill" />
          </li>
        ))}
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
    return <EmptyState compact title="No regions yet" message="A region appears once a player has joined from an address GeoLite2 can place." />;
  }
  return (
    <table className="playerRegionTable">
      <thead>
        <tr>
          <th scope="col">Region</th>
          <th scope="col">Share</th>
          <th scope="col" className="playerNumericColumn">Players</th>
          <th scope="col" className="playerNumericColumn">Est. ping</th>
        </tr>
      </thead>
      <tbody>
        {regions.map((region) => (
          <tr key={region.continentCode}>
            <th scope="row">{region.continent}</th>
            <td>
              <span className="playerRegionBar" aria-hidden="true">
                <span className="playerRegionBarFill" style={{ "--player-region-share": `${Math.round(region.share * 100)}%` } as Record<string, string>} />
              </span>
              <span className="playerRegionShare">{Math.round(region.share * 100)}%</span>
            </td>
            <td className="playerNumericColumn">{region.players}</td>
            <td className={`playerNumericColumn playerLatency playerLatency--${latencyTone(region.averageEstimatedLatencyMs)}`}>
              {formatEstimatedLatency(region.averageEstimatedLatencyMs)}
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
  formatDate
}: {
  players: readonly PlayerInsightsEntry[];
  serverId: string;
  playerHeadsEnabled: boolean;
  formatDate: (value: string | number | Date) => string;
}) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [serverId, players.length]);
  if (players.length === 0) {
    return <EmptyState compact title="No players recorded yet" message="Players appear here once they join, whether or not their location can be resolved." />;
  }
  const pages = Math.max(1, Math.ceil(players.length / rosterPageSize));
  const current = Math.min(page, pages - 1);
  const visible = players.slice(current * rosterPageSize, current * rosterPageSize + rosterPageSize);
  const headVersion = playerHeadVersion();

  return (
    <>
      <table className="playerRosterTable">
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col">Location</th>
            <th scope="col" className="playerNumericColumn">Distance</th>
            <th scope="col" className="playerNumericColumn">Est. ping</th>
            <th scope="col" className="playerNumericColumn">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((entry) => (
            <tr key={`${entry.serverId}:${entry.player}`} className={entry.online ? "playerRosterRow--online" : undefined}>
              <th scope="row">
                <span className="playerIdentity">
                  <PlayerHead serverId={entry.serverId} playerName={entry.player} version={headVersion} enabled={playerHeadsEnabled} />
                  <span className="playerIdentityCopy">
                    <strong>{entry.player}</strong>
                    {entry.online && <small className="playerOnlineFlag">Online</small>}
                  </span>
                </span>
              </th>
              <td>
                <span className="playerLocation">
                  <span>{formatLocation(entry.location)}</span>
                  <small>{entry.location ? describeLocationPrecision(entry.location) : "No location could be resolved"}</small>
                </span>
              </td>
              <td className="playerNumericColumn">{formatDistance(entry.distanceKm)}</td>
              <td className={`playerNumericColumn playerLatency playerLatency--${latencyTone(entry.estimatedLatencyMs)}`}>
                {formatEstimatedLatency(entry.estimatedLatencyMs)}
              </td>
              <td className="playerNumericColumn">{entry.lastSeenAt ? formatDate(entry.lastSeenAt) : unknownValue}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {pages > 1 && (
        <div className="playerRosterFooter">
          <span>Showing {visible.length} of {players.length} players</span>
          <span className="playerRosterPager">
            <Button variant="ghost" compact disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</Button>
            <span>{current + 1} / {pages}</span>
            <Button variant="ghost" compact disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next</Button>
          </span>
        </div>
      )}
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
  useEffect(() => setDraft(address), [address]);
  if (!canManage) {
    return <p className="playerCardNote">Distances are measured from {address || "a server address that has not been set"}. Configuring it needs the player insights management permission.</p>;
  }
  return (
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
        description="The public hostname or IP players connect to. Resolved locally against the GeoLite2 database to give distances something to measure from."
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
}

export function PlayersPage({
  active,
  server,
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
  formatDate
}: {
  active: boolean;
  server: ManagedServer;
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
  formatDate: (value: string | number | Date) => string;
}) {
  if (!active) return null;
  if (loading) {
    return (
      <section className="tabPage playersPage layoutWide">
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
          tone={latencyTone(summary?.medianEstimatedLatencyMs)}
          label="Median est. ping"
          value={formatEstimatedLatency(summary?.medianEstimatedLatencyMs)}
          detail={summary?.onlinePlayers ? "Players online now" : "Everyone seen so far"}
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
              ? `Approximate player locations, measured from ${serverLocation.location.label}.`
              : "Approximate player locations. Set the server address to measure distance and estimate latency."}
          />
          <PlayerGeographyMap
            players={insights?.players ?? []}
            serverLocation={serverLocation?.location}
            serverName={server.displayName}
          />
          <ul className="playerMapLegend">
            <li><span className="playerMapLegendMark playerMapLegendMark--server" aria-hidden="true" />This server</li>
            <li><span className="playerMapLegendMark playerMapLegendMark--online" aria-hidden="true" />Online now</li>
            <li><span className="playerMapLegendMark playerMapLegendMark--known" aria-hidden="true" />Played before</li>
            <li><span className="playerMapLegendMark playerMapLegendMark--accuracy" aria-hidden="true" />GeoLite2 accuracy radius</li>
          </ul>
          <ServerLocationForm
            address={serverLocation?.address ?? ""}
            error={serverLocation?.error}
            canManage={canManage}
            busy={busy}
            onSave={onSaveServerAddress}
          />
        </Surface>

        <Surface className="playerCard playerRegionCard">
          <PanelHeader title="Region overview" description="Where this server's players have connected from, and what that distance implies for latency." />
          <RegionTable regions={insights?.regions ?? []} />
        </Surface>
      </div>

      <div className="playerAnalysisRow">
        <Surface className="playerCard playerLatencyCard">
          <PanelHeader
            title="Connection quality"
            description="Estimated latency of the players online, replayed from the panel's own join and leave history."
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
          <LatencyChart points={insights?.latency ?? []} timeZone={insights?.timeZone ?? "UTC"} />
        </Surface>

        <Surface className="playerCard playerActivityCard">
          <PanelHeader title="Activity by hour" description={`Average players per hour of the day, ${insights?.timeZone ?? "UTC"}.`} />
          <ActivityHours hours={insights?.activityHours ?? []} timeZone={insights?.timeZone ?? "UTC"} />
        </Surface>
      </div>

      <Surface className="playerCard playerRosterCard">
        <PanelHeader
          title="Players"
          description="Everyone this server has seen, online first. Locations are approximate and latency is estimated from distance, never measured."
        />
        <PlayerRoster
          players={insights?.players ?? []}
          serverId={server.id}
          playerHeadsEnabled={playerHeadsEnabled}
          formatDate={formatDate}
        />
      </Surface>

      <footer className="playerAttribution">
        <p>{insights?.attribution}</p>
        {geoDatabase?.buildDate && <p>Database built {formatDate(geoDatabase.buildDate)}. Addresses are looked up against this local database and are not stored; none is sent to MaxMind or any other geolocation service.</p>}
      </footer>
    </section>
  );
}
