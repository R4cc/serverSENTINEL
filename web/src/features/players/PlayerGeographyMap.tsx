import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Server as ServerIcon } from "lucide-react";
import { usePlayerHead } from "../../components/PlayerHead";
import type { PlayerInsightsEntry, PlayerLocation } from "../../types";
import { playerHeadVersion } from "../../utils/playerHeads";
import {
  accuracyRadiusToMapUnits,
  formatEstimatedLatency,
  formatLocation,
  latencyTone,
  playerMapArc,
  playerMapMarks,
  projectToMap,
  type PlayerMapMark
} from "./playerInsightsView";
import { worldLandRings } from "./worldOutline";

/**
 * Where this server's players connect from.
 *
 * GeoLite2 locations stay approximate: accuracy rings remain centred on the inferred area, while
 * fixed-size HTML markers sit above the SVG so heads and cluster controls remain legible as the map
 * scales. Routes, rings, markers, and popovers all consume the same responsive cluster model.
 */

const mapWidth = 720;
const mapHeight = 360;
const markerCollisionPx = 34;
const serverClearancePx = 54;
const clusterMarkerSizePx = 44;
const clusterPopupHeightPx = 240;

type MapPoint = { x: number; y: number };

function landPath() {
  return worldLandRings.map((ring) => {
    const points = ring.split(",").map((pair) => {
      const [longitude, latitude] = pair.split(" ").map(Number);
      const { x, y } = projectToMap(longitude, latitude, mapWidth, mapHeight);
      return `${x.toFixed(1)} ${y.toFixed(1)}`;
    });
    return `M${points.join("L")}Z`;
  }).join(" ");
}

function markTitle(mark: PlayerMapMark) {
  const players = mark.players.length === 1 ? mark.players[0] : `${mark.players.length} players`;
  const accuracy = mark.accuracyRadiusKm ? `, accurate to about ${mark.accuracyRadiusKm} km` : "";
  const latency = mark.estimatedLatencyMs === undefined ? "" : ` · ~${mark.estimatedLatencyMs} ms estimated`;
  return `${players} near ${mark.label}${accuracy}${latency}`;
}

function hashAngle(value: string) {
  const hash = [...value].reduce((total, character) => ((total * 31) + character.charCodeAt(0)) >>> 0, 0);
  return 0.35 + (hash % 70) / 100;
}

/** Keep a player at the server's own centroid selectable instead of hiding it under the rack. */
function separateFromServer(point: MapPoint, server: MapPoint | undefined, scale: number, id: string): MapPoint {
  if (!server || scale <= 0) return point;
  const distancePx = Math.hypot(point.x - server.x, point.y - server.y) * scale;
  if (distancePx >= serverClearancePx) return point;
  const distance = serverClearancePx / scale;
  const angle = hashAngle(id);
  return {
    x: Math.min(mapWidth - 18, Math.max(18, server.x + Math.cos(angle) * distance)),
    y: Math.min(mapHeight - 18, Math.max(18, server.y + Math.sin(angle) * distance))
  };
}

function clusterAccuracyRadius(mark: PlayerMapMark, centre: MapPoint) {
  return mark.entries.reduce((widest, entry) => {
    const location = entry.location;
    if (location?.latitude === undefined || location.longitude === undefined) return widest;
    const point = projectToMap(location.longitude, location.latitude, mapWidth, mapHeight);
    const radius = location.accuracyRadiusKm ? accuracyRadiusToMapUnits(location.accuracyRadiusKm, mapWidth) : 0;
    return Math.max(widest, Math.hypot(point.x - centre.x, point.y - centre.y) + radius);
  }, 0);
}

function MapPlayerAvatar({
  entry,
  version,
  enabled,
  compact = false
}: {
  entry: PlayerInsightsEntry;
  version: number;
  enabled: boolean;
  compact?: boolean;
}) {
  const { source, showHead, onHeadError } = usePlayerHead(entry.serverId, entry.player, version, enabled);
  const classes = `playerMapAvatar ${compact ? "playerMapAvatar--compact" : ""}`.trim();
  return (
    <span className={`${classes} ${showHead ? "" : "playerMapAvatar--fallback"}`.trim()} aria-hidden="true">
      {showHead
        ? <img src={source} alt="" loading="lazy" decoding="async" onError={onHeadError} />
        : entry.player.trim().slice(0, 1).toLocaleUpperCase()}
    </span>
  );
}

export function PlayerGeographyMap({
  players,
  serverLocation,
  serverName,
  playerHeadsEnabled
}: {
  players: readonly PlayerInsightsEntry[];
  serverLocation: PlayerLocation | undefined;
  serverName: string;
  playerHeadsEnabled: boolean;
}) {
  const land = useMemo(landPath, []);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [renderedWidth, setRenderedWidth] = useState(mapWidth);
  const [hoveredClusterId, setHoveredClusterId] = useState<string>();
  const [pinnedClusterId, setPinnedClusterId] = useState<string>();
  const popupPrefix = useId().replace(/:/g, "");
  const headVersion = useMemo(() => playerHeadVersion(), []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => {
      const width = viewport.getBoundingClientRect().width;
      if (width > 0) setRenderedWidth((current) => Math.abs(current - width) < 0.5 ? current : width);
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const marks = useMemo(
    () => playerMapMarks(players, mapWidth, mapHeight, renderedWidth, markerCollisionPx),
    [players, renderedWidth]
  );
  useEffect(() => {
    const validIds = new Set(marks.filter((mark) => mark.entries.length > 1).map((mark) => mark.id));
    if (hoveredClusterId && !validIds.has(hoveredClusterId)) setHoveredClusterId(undefined);
    if (pinnedClusterId && !validIds.has(pinnedClusterId)) setPinnedClusterId(undefined);
  }, [hoveredClusterId, marks, pinnedClusterId]);

  useEffect(() => {
    if (!pinnedClusterId) return;
    const closeOutsidePopup = (event: PointerEvent) => {
      const popup = viewportRef.current?.querySelector(".playerMapClusterPopup");
      if (event.target instanceof Node && !popup?.contains(event.target)) {
        setHoveredClusterId(undefined);
        setPinnedClusterId(undefined);
      }
    };
    document.addEventListener("pointerdown", closeOutsidePopup, true);
    return () => document.removeEventListener("pointerdown", closeOutsidePopup, true);
  }, [pinnedClusterId]);

  const activeClusterId = pinnedClusterId ?? hoveredClusterId;

  const scale = renderedWidth > 0 ? renderedWidth / mapWidth : 1;
  const renderedHeight = renderedWidth * (mapHeight / mapWidth);
  const server = serverLocation?.latitude !== undefined && serverLocation.longitude !== undefined
    ? projectToMap(serverLocation.longitude, serverLocation.latitude, mapWidth, mapHeight)
    : undefined;
  const plottedMarks = marks.map((mark) => {
    const actualPoint = projectToMap(mark.longitude, mark.latitude, mapWidth, mapHeight);
    const point = separateFromServer(actualPoint, server, scale, mark.id);
    return {
      mark,
      actualPoint,
      point,
      accuracy: clusterAccuracyRadius(mark, actualPoint)
    };
  });
  const routes = server
    ? plottedMarks.map((plotted) => ({
        ...plotted,
        arc: playerMapArc(server, plotted.point),
        tone: latencyTone(plotted.mark.estimatedLatencyMs)
      }))
    : [];
  const labelLimit = renderedWidth < 420 ? 0 : renderedWidth < 560 ? 3 : 6;
  const routeLabels = routes
    .filter((route) => route.mark.estimatedLatencyMs !== undefined && route.arc.distance * scale >= 74)
    .sort((left, right) => right.arc.distance - left.arc.distance)
    .reduce<typeof routes>((accepted, route) => {
      if (accepted.length >= labelLimit) return accepted;
      const collides = accepted.some((candidate) => (
        Math.abs(candidate.arc.label.x - route.arc.label.x) * scale < 62
        && Math.abs(candidate.arc.label.y - route.arc.label.y) * scale < 20
      ));
      return collides ? accepted : [...accepted, route];
    }, []);

  return (
    <figure className="playerMap">
      <div className="playerMapViewport" ref={viewportRef}>
        <svg
          viewBox={`0 0 ${mapWidth} ${mapHeight}`}
          className="playerMapCanvas"
          role="img"
          aria-label={marks.length
            ? `World map showing ${marks.length} player ${marks.length === 1 ? "marker" : "markers"} for ${marks.reduce((total, mark) => total + mark.players.length, 0)} located players`
            : "World map with no located players yet"}
        >
          <rect className="playerMapOcean" x="0" y="0" width={mapWidth} height={mapHeight} />
          <path className="playerMapLand" d={land} />
          {plottedMarks.map(({ mark, actualPoint, accuracy }) => accuracy >= 2 && (
            <circle
              key={`accuracy-${mark.id}`}
              className={`playerMapAccuracy ${activeClusterId === mark.id ? "playerMapAccuracy--active" : ""}`.trim()}
              cx={actualPoint.x}
              cy={actualPoint.y}
              r={Math.min(60, accuracy)}
            />
          ))}
          {routes.map(({ mark, arc, tone }) => (
            <path
              key={`route-${mark.id}`}
              className={`playerMapRoute playerMapRoute--${tone} ${activeClusterId === mark.id ? "playerMapRoute--active" : ""}`.trim()}
              d={arc.path}
              data-player-count={mark.entries.length}
              data-estimated-ping={mark.estimatedLatencyMs}
            />
          ))}
          {server && (
            <g className="playerMapServer">
              <title>{`${serverName} · ${serverLocation?.label ?? "server location"}`}</title>
              <circle className="playerMapServerHalo" cx={server.x} cy={server.y} r={14} />
              <circle className="playerMapServerBadge" cx={server.x} cy={server.y} r={10} />
              <ServerIcon
                className="playerMapServerIcon"
                x={server.x - 7}
                y={server.y - 7}
                width={14}
                height={14}
                strokeWidth={2}
                aria-hidden="true"
              />
            </g>
          )}
        </svg>

        <div className="playerMapOverlay">
          {routeLabels.map(({ mark, arc, tone }) => (
            <span
              key={`label-${mark.id}`}
              className={`playerMapPingLabel playerMapPingLabel--${tone}`}
              style={{ left: `${(arc.label.x / mapWidth) * 100}%`, top: `${(arc.label.y / mapHeight) * 100}%` }}
              aria-hidden="true"
            >
              {formatEstimatedLatency(mark.estimatedLatencyMs)}
            </span>
          ))}

          {plottedMarks.map(({ mark, point }) => {
            const clustered = mark.entries.length > 1;
            const active = clustered && activeClusterId === mark.id;
            const popupId = `${popupPrefix}-player-map-cluster-${marks.indexOf(mark)}`;
            const popupWidth = Math.min(310, Math.max(180, renderedWidth - 16));
            const pointX = point.x * scale;
            const pointY = point.y * scale;
            const popupScreenLeft = Math.min(
              Math.max(8, renderedWidth - popupWidth - 8),
              Math.max(8, pointX - popupWidth / 2)
            );
            const spaceAbove = pointY - clusterMarkerSizePx / 2 - 10;
            const spaceBelow = renderedHeight - pointY - clusterMarkerSizePx / 2 - 10;
            const belowPopupTop = pointY + clusterMarkerSizePx / 2 + 10;
            const abovePopupTop = pointY - clusterMarkerSizePx / 2 - 10 - clusterPopupHeightPx;
            const popupScreenTop = renderedHeight < clusterPopupHeightPx + 16
              ? 8
              : spaceBelow >= clusterPopupHeightPx || spaceBelow >= spaceAbove
                ? belowPopupTop
                : abovePopupTop;
            const markerLabel = clustered
              ? `${mark.entries.length} players near ${mark.label}. Average estimated ping ${formatEstimatedLatency(mark.estimatedLatencyMs)}.`
              : `${markTitle(mark)}. ${mark.entries[0].online ? "Online now" : "Played before"}.`;
            return (
              <span
                key={mark.id}
                className={`playerMapMarkerWrap ${active ? "playerMapMarkerWrap--active" : ""}`.trim()}
                style={{ left: `${(point.x / mapWidth) * 100}%`, top: `${(point.y / mapHeight) * 100}%` }}
                onMouseEnter={clustered ? () => setHoveredClusterId(mark.id) : undefined}
                onMouseLeave={clustered ? () => setHoveredClusterId((current) => current === mark.id ? undefined : current) : undefined}
                onFocus={clustered ? () => setHoveredClusterId(mark.id) : undefined}
                onBlur={clustered ? (event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) {
                    setHoveredClusterId(undefined);
                  }
                } : undefined}
              >
                {clustered ? (
                  <button
                    type="button"
                    className={`playerMapMarker playerMapClusterMarker ${mark.online ? "playerMapMarker--online" : "playerMapMarker--known"}`}
                    aria-label={markerLabel}
                    aria-haspopup="dialog"
                    aria-expanded={active}
                    aria-controls={active ? popupId : undefined}
                    onClick={() => {
                      const next = pinnedClusterId === mark.id ? undefined : mark.id;
                      setPinnedClusterId(next);
                    }}
                  >
                    <span className="playerMapClusterHeads" aria-hidden="true">
                      {mark.entries.slice(0, 3).map((entry) => (
                        <MapPlayerAvatar key={`${entry.serverId}:${entry.player}`} entry={entry} version={headVersion} enabled={playerHeadsEnabled} compact />
                      ))}
                    </span>
                    <span className="playerMapClusterCount" aria-hidden="true">{mark.entries.length > 99 ? "99+" : mark.entries.length}</span>
                  </button>
                ) : (
                  <span
                    className={`playerMapMarker playerMapPlayerMarker ${mark.online ? "playerMapMarker--online" : "playerMapMarker--known"}`}
                    role="img"
                    aria-label={markerLabel}
                    title={markerLabel}
                  >
                    <MapPlayerAvatar entry={mark.entries[0]} version={headVersion} enabled={playerHeadsEnabled} />
                  </span>
                )}

                {active && (
                  <span
                    id={popupId}
                    className="playerMapClusterPopup"
                    style={{
                      width: popupWidth,
                      left: popupScreenLeft - pointX + clusterMarkerSizePx / 2,
                      top: popupScreenTop - pointY + clusterMarkerSizePx / 2
                    }}
                    role="dialog"
                    aria-label={`Players near ${mark.label}`}
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.currentTarget.parentElement?.querySelector<HTMLButtonElement>("button")?.focus();
                        setHoveredClusterId(undefined);
                        setPinnedClusterId(undefined);
                      }
                    }}
                  >
                    <span className="playerMapClusterPopupHeader">
                      <strong>{mark.label} cluster · {mark.entries.length} players</strong>
                      <span>Avg. ping <b className={`playerMapPingValue playerMapPingValue--${latencyTone(mark.estimatedLatencyMs)}`}>{formatEstimatedLatency(mark.estimatedLatencyMs)}</b></span>
                    </span>
                    <span className="playerMapClusterList">
                      {mark.entries.map((entry) => (
                        <span className="playerMapClusterRow" key={`${entry.serverId}:${entry.player}`}>
                          <MapPlayerAvatar entry={entry} version={headVersion} enabled={playerHeadsEnabled} compact />
                          <strong>{entry.player}</strong>
                          <span>{formatLocation(entry.location)}</span>
                          <b className={`playerMapPingValue playerMapPingValue--${latencyTone(entry.estimatedLatencyMs)}`}>{formatEstimatedLatency(entry.estimatedLatencyMs)}</b>
                        </span>
                      ))}
                    </span>
                  </span>
                )}
              </span>
            );
          })}
        </div>
      </div>
    </figure>
  );
}
