import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Minus, Plus, RotateCcw, Server as ServerIcon } from "lucide-react";
import { KeepScale, TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";
import { usePlayerHead } from "../../components/PlayerHead";
import type { PlayerInsightsEntry, PlayerLocation } from "../../types";
import { playerHeadVersion } from "../../utils/playerHeads";
import {
  accuracyRadiusToMapUnits,
  clampPlayerMapPoint,
  formatEstimatedLatency,
  formatLocation,
  latencyTone,
  playerMapArc,
  playerMapLabelPoint,
  playerMapMarks,
  playerMapPopupPlacement,
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
const desktopMarkerCollisionPx = 34;
const mobileMarkerCollisionPx = 24;
const serverMergeDistancePx = 42;
const desktopClusterMarkerSizePx = 44;
const clusterPopupHeightPx = 240;
const playerTooltipHeightPx = 96;
const clusterHoverCloseDelayMs = 160;

type MapPoint = { x: number; y: number };

function buildLandPath() {
  return worldLandRings.map((ring) => {
    const points = ring.split(",").map((pair) => {
      const [longitude, latitude] = pair.split(" ").map(Number);
      const { x, y } = projectToMap(longitude, latitude, mapWidth, mapHeight);
      return `${x.toFixed(1)} ${y.toFixed(1)}`;
    });
    return `M${points.join("L")}Z`;
  }).join(" ");
}

/** The coastline never moves, so it is projected once for the module rather than once per map. */
const landPath = buildLandPath();

function markTitle(mark: PlayerMapMark) {
  const players = mark.players.length === 1 ? mark.players[0] : `${mark.players.length} players`;
  const accuracy = mark.accuracyRadiusKm ? `, accurate to about ${mark.accuracyRadiusKm} km` : "";
  const latency = mark.estimatedLatencyMs === undefined ? "" : ` · ~${mark.estimatedLatencyMs} ms estimated`;
  return `${players} near ${mark.label}${accuracy}${latency}`;
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
  serverRunning,
  playerHeadsEnabled
}: {
  players: readonly PlayerInsightsEntry[];
  serverLocation: PlayerLocation | undefined;
  serverName: string;
  serverRunning: boolean;
  playerHeadsEnabled: boolean;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const [renderedWidth, setRenderedWidth] = useState(mapWidth);
  const [zoomScale, setZoomScale] = useState(1);
  const [hoveredMarkId, setHoveredMarkId] = useState<string>();
  const popupPrefix = useId().replace(/:/g, "");
  const headVersion = useMemo(() => playerHeadVersion(), []);
  const cancelScheduledClose = () => {
    if (closeTimerRef.current === undefined) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = undefined;
  };
  const openMark = (id: string) => {
    cancelScheduledClose();
    setHoveredMarkId(id);
  };
  const scheduleMarkClose = (id: string) => {
    cancelScheduledClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = undefined;
      setHoveredMarkId((current) => current === id ? undefined : current);
    }, clusterHoverCloseDelayMs);
  };

  useEffect(() => () => {
    if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    const viewport = frameRef.current;
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
    () => playerMapMarks(
      players,
      mapWidth,
      mapHeight,
      renderedWidth * zoomScale,
      renderedWidth < 560 ? mobileMarkerCollisionPx : desktopMarkerCollisionPx
    ),
    [players, renderedWidth, zoomScale]
  );
  useEffect(() => {
    const validIds = new Set(marks.map((mark) => mark.id));
    setHoveredMarkId((current) => current !== undefined && !validIds.has(current) ? undefined : current);
  }, [marks]);

  useEffect(() => {
    if (!hoveredMarkId) return;
    const closeOutsidePopup = (event: PointerEvent) => {
      const activeMarker = frameRef.current?.querySelector(".playerMapMarkerWrap--active");
      if (event.target instanceof Node && !activeMarker?.contains(event.target)) {
        if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = undefined;
        setHoveredMarkId(undefined);
      }
    };
    document.addEventListener("pointerdown", closeOutsidePopup, true);
    return () => document.removeEventListener("pointerdown", closeOutsidePopup, true);
  }, [hoveredMarkId]);

  const scale = renderedWidth > 0 ? renderedWidth / mapWidth : 1;
  const clusterMarkerSizePx = renderedWidth < 560 ? 32 : desktopClusterMarkerSizePx;
  const renderedHeight = renderedWidth * (mapHeight / mapWidth);
  const server = serverLocation?.latitude !== undefined && serverLocation.longitude !== undefined
    ? projectToMap(serverLocation.longitude, serverLocation.latitude, mapWidth, mapHeight)
    : undefined;
  // Projected once and shared: the server-merge search and the marker placement below both want
  // the same point, and every hover re-runs all of this.
  const markPoints = marks.map((mark) => projectToMap(mark.longitude, mark.latitude, mapWidth, mapHeight));
  let nearestServerMark: { id: string; distancePx: number } | undefined;
  if (server) {
    marks.forEach((mark, index) => {
      const distancePx = Math.hypot(markPoints[index].x - server.x, markPoints[index].y - server.y) * scale;
      if (distancePx > serverMergeDistancePx) return;
      if (!nearestServerMark || distancePx < nearestServerMark.distancePx) nearestServerMark = { id: mark.id, distancePx };
    });
  }
  const serverMarkId = nearestServerMark?.id;
  const plottedMarks = marks.map((mark, index) => {
    const actualPoint = markPoints[index];
    const sharesServer = mark.id === serverMarkId;
    const originPoint = sharesServer && server ? server : actualPoint;
    const clustered = mark.entries.length > 1;
    const markerExtents = {
      left: clustered ? clusterMarkerSizePx / 2 + 7 : 19,
      right: clustered ? clusterMarkerSizePx / 2 + 7 : 19,
      top: (sharesServer ? 48 : clustered ? 20 : 15) + 4,
      bottom: (clustered ? 20 : 15) + 4
    };
    const point = clampPlayerMapPoint(originPoint, scale, markerExtents, mapWidth, mapHeight);
    return {
      mark,
      point,
      sharesServer,
      markerExtents,
      accuracy: clusterAccuracyRadius(mark, point)
    };
  });
  const horizontalLabelInset = 28 / Math.max(scale, 0.01);
  const routes = server
    ? plottedMarks.filter(({ sharesServer }) => !sharesServer).map((plotted) => {
        const label = playerMapLabelPoint(plotted.point, scale, plotted.mark.entries.length > 1 ? 34 : 27);
        return {
          ...plotted,
          arc: playerMapArc(server, plotted.point),
          tone: latencyTone(plotted.mark.estimatedLatencyMs),
          label: {
            x: Math.min(mapWidth - horizontalLabelInset, Math.max(horizontalLabelInset, label.x)),
            y: label.y
          }
        };
      })
    : [];
  const labelLimit = renderedWidth < 420 ? 0 : renderedWidth < 560 ? 4 : renderedWidth < 900 ? 10 : 14;
  const routeLabels = routes
    .filter((route) => route.mark.estimatedLatencyMs !== undefined && route.arc.distance * scale >= 56)
    .sort((left, right) => right.arc.distance - left.arc.distance)
    .reduce<typeof routes>((accepted, route) => {
      if (accepted.length >= labelLimit) return accepted;
      const overlapsMarker = plottedMarks.some((candidate) => (
        candidate.mark.id !== route.mark.id
        && Math.abs(candidate.point.x - route.label.x) * scale < 34
        && Math.abs(candidate.point.y - route.label.y) * scale < 22
      ));
      const collides = accepted.some((candidate) => (
        Math.abs(candidate.label.x - route.label.x) * scale < 56
        && Math.abs(candidate.label.y - route.label.y) * scale < 18
      ));
      if (!overlapsMarker && !collides) accepted.push(route);
      return accepted;
    }, []);

  return (
    <figure className="playerMap">
      <TransformWrapper
        initialScale={1}
        minScale={1}
        maxScale={4}
        centerOnInit
        centerZoomedOut
        limitToBounds
        wheel={{ step: 0.12, excluded: ["playerMapControlButton", "playerMapMarker", "playerMapClusterPopup"] }}
        panning={{ velocityDisabled: true, excluded: ["playerMapControlButton", "playerMapMarker", "playerMapClusterPopup"] }}
        pinch={{ step: 4, excluded: ["playerMapControlButton", "playerMapClusterPopup"] }}
        doubleClick={{ mode: "zoomIn", step: 0.7, excluded: ["playerMapControlButton", "playerMapMarker", "playerMapClusterPopup"] }}
        onTransform={(_, state) => {
          setZoomScale((current) => Math.abs(current - state.scale) < 0.01 ? current : state.scale);
        }}
      >
        {({ zoomIn, zoomOut, resetTransform, state }) => (
          <>
            <div className="playerMapFrame" ref={frameRef}>
              <TransformComponent
                wrapperClass="playerMapViewport"
                contentClass="playerMapTransformContent"
                wrapperStyle={{ width: "100%", height: "100%" }}
                contentStyle={{ width: "100%", height: "100%" }}
                wrapperProps={{
                  role: "region",
                  "aria-label": "Interactive player world map. Pinch or scroll to zoom and drag to move."
                }}
              >
                <div className="playerMapScene">
                  <svg
          viewBox={`0 0 ${mapWidth} ${mapHeight}`}
          className="playerMapCanvas"
          role="img"
          aria-label={marks.length
            ? `World map showing ${marks.length} player ${marks.length === 1 ? "marker" : "markers"} for ${marks.reduce((total, mark) => total + mark.players.length, 0)} located players`
            : "World map with no located players yet"}
                  >
          <rect className="playerMapOcean" x="0" y="0" width={mapWidth} height={mapHeight} />
          <path className="playerMapLand" d={landPath} />
          {plottedMarks.map(({ mark, point, accuracy }) => accuracy >= 2 && (
            <circle
              key={`accuracy-${mark.id}`}
              className={`playerMapAccuracy ${hoveredMarkId === mark.id ? "playerMapAccuracy--active" : ""}`.trim()}
              cx={point.x}
              cy={point.y}
              r={Math.min(60, accuracy)}
            />
          ))}
          {routes.map(({ mark, arc, tone }) => (
            <path
              key={`route-${mark.id}`}
              className={`playerMapRoute playerMapRoute--${tone} ${hoveredMarkId === mark.id ? "playerMapRoute--active" : ""}`.trim()}
              d={arc.path}
              data-player-count={mark.entries.length}
              data-estimated-ping={mark.estimatedLatencyMs}
            />
          ))}
          {server && !serverMarkId && (
            <g className={`playerMapServer playerMapServer--${serverRunning ? "running" : "stopped"}`}>
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
          {routeLabels.map(({ mark, label, tone }) => (
            <span
              key={`label-${mark.id}`}
              className={`playerMapPingLabel playerMapPingLabel--${tone}`}
              style={{ left: `${(label.x / mapWidth) * 100}%`, top: `${(label.y / mapHeight) * 100}%` }}
              aria-hidden="true"
            >
              {formatEstimatedLatency(mark.estimatedLatencyMs)}
            </span>
          ))}

          {plottedMarks.map(({ mark, point, sharesServer, markerExtents }, index) => {
            const clustered = mark.entries.length > 1;
            const active = hoveredMarkId === mark.id;
            const popupId = `${popupPrefix}-player-map-${clustered ? "cluster" : "player"}-${index}`;
            const panelWidth = clustered
              ? Math.min(310, Math.max(180, renderedWidth - 16))
              : Math.min(220, Math.max(170, renderedWidth - 16));
            const pointX = point.x * scale;
            const pointY = point.y * scale;
            const popupScreenLeft = Math.min(
              Math.max(8, renderedWidth - panelWidth - 8),
              Math.max(8, pointX - panelWidth / 2)
            );
            const panelPlacement = playerMapPopupPlacement({
              pointY,
              renderedHeight,
              markerTopExtent: markerExtents.top - 4,
              markerBottomExtent: markerExtents.bottom - 4,
              panelMaxHeight: clustered ? clusterPopupHeightPx : playerTooltipHeightPx
            });
            const popupStyle = {
              width: panelWidth,
              left: popupScreenLeft - pointX + clusterMarkerSizePx / 2,
              top: panelPlacement.anchorY - pointY + clusterMarkerSizePx / 2
            };
            const markerLabel = clustered
              ? `${sharesServer ? `${serverName} server and ` : ""}${mark.entries.length} players near ${mark.label}. Average estimated ping ${formatEstimatedLatency(mark.estimatedLatencyMs)}.`
              : markTitle(mark);
            return (
              <KeepScale
                key={mark.id}
                className={`playerMapMarkerWrap ${active ? "playerMapMarkerWrap--active" : ""} ${sharesServer ? "playerMapMarkerWrap--server" : ""}`.trim()}
                style={{ left: `${(point.x / mapWidth) * 100}%`, top: `${(point.y / mapHeight) * 100}%` }}
                onMouseEnter={() => openMark(mark.id)}
                onMouseLeave={() => scheduleMarkClose(mark.id)}
                onFocus={() => openMark(mark.id)}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) {
                    scheduleMarkClose(mark.id);
                  }
                }}
              >
                <span className="playerMapMarkerScale">
                {clustered ? (
                  <button
                    type="button"
                    className={`playerMapMarker playerMapClusterMarker ${sharesServer ? "playerMapClusterMarker--server" : ""}`.trim()}
                    aria-label={markerLabel}
                    aria-haspopup="dialog"
                    aria-expanded={active}
                    aria-controls={active ? popupId : undefined}
                  >
                    <span className={`playerMapClusterHeads ${sharesServer ? "playerMapClusterHeads--server" : ""}`.trim()} aria-hidden="true">
                      {mark.entries.slice(0, 3).map((entry) => (
                        <MapPlayerAvatar key={`${entry.serverId}:${entry.player}`} entry={entry} version={headVersion} enabled={playerHeadsEnabled} compact />
                      ))}
                      {sharesServer && (
                        <span className={`playerMapSharedServer playerMapSharedServer--${serverRunning ? "running" : "stopped"}`}>
                          <ServerIcon className="playerMapSharedServerIcon" aria-hidden="true" />
                        </span>
                      )}
                    </span>
                    <span className="playerMapClusterCount" aria-hidden="true">{mark.entries.length > 99 ? "99+" : mark.entries.length}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`playerMapMarker playerMapPlayerMarker ${sharesServer ? "playerMapPlayerMarker--server" : ""}`.trim()}
                    aria-label={markerLabel}
                    aria-describedby={active ? popupId : undefined}
                  >
                    <MapPlayerAvatar entry={mark.entries[0]} version={headVersion} enabled={playerHeadsEnabled} />
                    {sharesServer && (
                      <span className={`playerMapSharedServer playerMapSharedServer--${serverRunning ? "running" : "stopped"}`} aria-hidden="true">
                        <ServerIcon className="playerMapSharedServerIcon" />
                      </span>
                    )}
                  </button>
                )}

                {active && clustered && (
                  <span
                    id={popupId}
                    className={`playerMapClusterPopup playerMapFloatingPanel--${panelPlacement.placement}`}
                    style={popupStyle}
                    role="dialog"
                    aria-label={`Players near ${mark.label}`}
                    tabIndex={0}
                    onMouseEnter={cancelScheduledClose}
                    onMouseLeave={() => scheduleMarkClose(mark.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        cancelScheduledClose();
                        event.currentTarget.parentElement?.querySelector<HTMLButtonElement>("button")?.focus();
                        setHoveredMarkId(undefined);
                      }
                    }}
                  >
                    <span className="playerMapClusterPopupHeader">
                      <strong>{mark.label}</strong>
                      <span>{mark.entries.length} players · <b className={`playerMapPingValue playerMapPingValue--${latencyTone(mark.estimatedLatencyMs)}`}>{formatEstimatedLatency(mark.estimatedLatencyMs)} avg.</b></span>
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

                {active && !clustered && (
                  <span
                    id={popupId}
                    className={`playerMapClusterPopup playerMapPlayerPopup playerMapFloatingPanel--${panelPlacement.placement}`}
                    style={popupStyle}
                    role="tooltip"
                    onMouseEnter={cancelScheduledClose}
                    onMouseLeave={() => scheduleMarkClose(mark.id)}
                  >
                    <span className="playerMapClusterPopupHeader">
                      <strong>{mark.entries[0].player}</strong>
                    </span>
                    <span className="playerMapClusterList playerMapSinglePlayerList">
                      <span className="playerMapClusterRow playerMapSinglePlayerRow">
                        <MapPlayerAvatar entry={mark.entries[0]} version={headVersion} enabled={playerHeadsEnabled} compact />
                        <span>{formatLocation(mark.entries[0].location)}</span>
                        <b className={`playerMapPingValue playerMapPingValue--${latencyTone(mark.entries[0].estimatedLatencyMs)}`}>{formatEstimatedLatency(mark.entries[0].estimatedLatencyMs)}</b>
                      </span>
                    </span>
                  </span>
                )}
                </span>
              </KeepScale>
            );
          })}
                  </div>
                </div>
              </TransformComponent>
            </div>
            <div className="playerMapControls" aria-label="Map zoom controls">
                <button
                  type="button"
                  className="playerMapControlButton"
                  aria-label="Zoom in"
                  title="Zoom in"
                  disabled={state.scale >= 4}
                  onClick={() => zoomIn(0.5)}
                >
                  <Plus aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="playerMapControlButton"
                  aria-label="Zoom out"
                  title="Zoom out"
                  disabled={state.scale <= 1}
                  onClick={() => zoomOut(0.5)}
                >
                  <Minus aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="playerMapControlButton"
                  aria-label="Reset map view"
                  title="Reset map view"
                  disabled={state.scale <= 1}
                  onClick={() => resetTransform()}
                >
                  <RotateCcw aria-hidden="true" />
                </button>
            </div>
            <span className="visuallyHidden" role="status" aria-live="polite">Map zoom {Math.round(state.scale * 100)}%</span>
          </>
        )}
      </TransformWrapper>
    </figure>
  );
}
