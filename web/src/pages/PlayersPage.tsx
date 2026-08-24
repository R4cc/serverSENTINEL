import { useEffect, useId, useState, type FormEvent } from "react";
import { Activity, Globe, MapPin, Wrench } from "lucide-react";
import type { ManagedServer, PlayerActivityHour, PlayerInsightsEntry, PlayerInsightsResponse, PlayerLatencyPoint, PlayerRegionSummary } from "../types";
import { InlineState } from "../components/InlineState";
import { PlayerHead } from "../components/PlayerHead";
import { Banner, Button, EmptyState, FormField, MetricTile, PanelHeader, SkeletonBlock, StatusBadge, Surface } from "../components/UiPrimitives";
import { playerHeadVersion } from "../utils/playerHeads";
import { PlayerGeographyMap } from "../features/players/PlayerGeographyMap";
import {
  countryFlag,
  formatDistance,
  formatEstimatedLatency,
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

function PlayerMapLegendHead({
  entry,
  version,
  enabled
}: {
  entry: PlayerInsightsEntry | undefined;
  version: number;
  enabled: boolean;
}) {
  if (!entry) return <span className="playerMapLegendHead playerMapLegendHead--placeholder" aria-hidden="true" />;
  return (
    <PlayerHead
      serverId={entry.serverId}
      playerName={entry.player}
      version={version}
      enabled={enabled}
      className="playerMapLegendHead"
    />
  );
}

/**
 * The chart's geometry, in the units its viewBox is drawn in.
 *
 * A phone renders this SVG about half as wide as a desktop does, so one viewBox for both means the
 * axis labels are either unreadable on the phone or oversized on the desktop. Scaling the font
 * inside a fixed viewBox is what broke it: the gutters are measured in the same units, so a bigger
 * font ran "150 ms" off the left edge and dropped "0 ms" on top of the date beneath it. Choosing a
 * viewBox close to the size it will actually be drawn at keeps one set of proportions honest at
 * both widths, and the padding below is sized for the labels that have to fit inside it.
 */
function latencyChartGeometry(compact: boolean) {
  return compact
    ? { width: 360, height: 190, fontSize: 11, padding: { top: 10, right: 8, bottom: 28, left: 50 } }
    : { width: 720, height: 180, fontSize: 10, padding: { top: 12, right: 8, bottom: 22, left: 64 } };
}

function LatencyChart({ points, timeZone, compact }: { points: readonly PlayerLatencyPoint[]; timeZone: string; compact: boolean }) {
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

  const { width, height, fontSize, padding } = latencyChartGeometry(compact);
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
  const showsMultipleDates = to - from >= 20 * 60 * 60 * 1000;
  const axisFormatter = new Intl.DateTimeFormat("en-GB", showsMultipleDates
    ? { timeZone, day: "numeric", month: "short" }
    : { timeZone, hour: "2-digit", minute: "2-digit" });
  const timeLabel = (at: number) => axisFormatter.format(new Date(at));

  return (
    <div className="playerLatencyChart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Estimated latency over time, peaking near ${ceiling} milliseconds`}>
        {gridValues.map((value) => (
          <g key={value}>
            <line className="playerChartGrid" x1={padding.left} y1={y(value)} x2={width - padding.right} y2={y(value)} />
            <text className="playerChartAxisLabel" fontSize={fontSize} x={padding.left - 6} y={y(value) + fontSize * 0.36} textAnchor="end">{value} ms</text>
          </g>
        ))}
        <path className="playerChartLine playerChartLine--p95" d={line((point) => point.p95EstimatedLatencyMs)} />
        <path className="playerChartLine playerChartLine--median" d={line((point) => point.medianEstimatedLatencyMs)} />
        <text className="playerChartAxisLabel" fontSize={fontSize} x={padding.left} y={height - 4} textAnchor="start">{timeLabel(from)}</text>
        <text className="playerChartAxisLabel" fontSize={fontSize} x={width - padding.right} y={height - 4} textAnchor="end">{timeLabel(to)}</text>
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
        {hours.map((hour) => {
          const clock = `${String(hour.hour).padStart(2, "0")}:00`;
          return (
            <li
              key={hour.hour}
              className={`playerActivityBar ${hour.samples === 0 ? "playerActivityBar--unobserved" : ""}`.trim()}
              style={{ "--player-activity-height": `${peak ? Math.round((hour.averagePlayers / peak) * 100) : 0}%` } as Record<string, string>}
              title={hour.samples === 0
                ? `${clock} — not observed yet`
                : `${clock} — ${hour.averagePlayers.toFixed(1)} players on average, peak ${hour.peakPlayers}`}
            >
              <span className="playerActivityBarFill" />
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
              <span className="playerRegionShareCell">
                <span className="playerRegionBar" aria-hidden="true">
                  <span className="playerRegionBarFill" style={{ "--player-region-share": `${Math.round(region.share * 100)}%` } as Record<string, string>} />
                </span>
                <span className="playerRegionShare">{Math.round(region.share * 100)}%</span>
              </span>
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
  // Only a different server starts the reader over. The roster refreshes every thirty seconds and
  // its length moves whenever anyone joins or leaves, so resetting on that threw whoever was
  // reading page three back to page one for no reason they could see. A page that no longer exists
  // is clamped below instead.
  useEffect(() => setPage(0), [serverId]);
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
  const locatedPlayers = insights?.players.filter((entry) => (
    entry.location?.latitude !== undefined && entry.location.longitude !== undefined
  )) ?? [];
  const legendOnlinePlayer = locatedPlayers.find((entry) => entry.online) ?? locatedPlayers[0];
  const legendKnownPlayer = locatedPlayers.find((entry) => !entry.online) ?? locatedPlayers.at(-1);
  const legendClusterPlayers = locatedPlayers.slice(0, 3);
  const legendHeadVersion = playerHeadVersion();

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
              : serverLocation?.address
                // An address is configured but could not be placed. Saying "set the server address"
                // here would be telling the operator to do what they have already done.
                ? `Approximate player locations. ${serverLocation.address} could not be placed, so distances are unavailable.`
                : "Approximate player locations. Set the server address to measure distance and estimate latency."}
          />
          <PlayerGeographyMap
            players={insights?.players ?? []}
            serverLocation={serverLocation?.location}
            serverName={server.displayName}
            serverRunning={serverRunning}
            playerHeadsEnabled={playerHeadsEnabled}
          />
          <ul className="playerMapLegend">
            <li><span className="playerMapLegendMark playerMapLegendMark--server" aria-hidden="true" />This server</li>
            <li>
              <span className="playerMapLegendPlayer playerMapLegendPlayer--online" aria-hidden="true">
                <PlayerMapLegendHead entry={legendOnlinePlayer} version={legendHeadVersion} enabled={playerHeadsEnabled} />
              </span>
              Online player
            </li>
            <li>
              <span className="playerMapLegendPlayer playerMapLegendPlayer--known" aria-hidden="true">
                <PlayerMapLegendHead entry={legendKnownPlayer} version={legendHeadVersion} enabled={playerHeadsEnabled} />
              </span>
              Played before
            </li>
            <li>
              <span className="playerMapLegendCluster" aria-hidden="true">
                {Array.from({ length: 3 }, (_, index) => (
                  <PlayerMapLegendHead
                    key={legendClusterPlayers[index]?.player ?? `placeholder-${index}`}
                    entry={legendClusterPlayers[index]}
                    version={legendHeadVersion}
                    enabled={playerHeadsEnabled}
                  />
                ))}
                <b>3</b>
              </span>
              Player cluster
            </li>
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
          <LatencyChart points={insights?.latency ?? []} timeZone={insights?.timeZone ?? "UTC"} compact={compactLayout} />
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
          formatNumber={formatNumber}
        />
      </Surface>

      <footer className="playerAttribution">
        <p>{insights?.attribution}</p>
        {geoDatabase?.buildDate && <p>Database built {formatDate(geoDatabase.buildDate)}. Addresses are looked up against this local database and are not stored; none is sent to MaxMind or any other geolocation service.</p>}
      </footer>
    </section>
  );
}
