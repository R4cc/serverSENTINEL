import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, RotateCcw, X, Server as ServerIcon } from "lucide-react";
import { Button } from "../../components/UiPrimitives";
import { TransformComponent, TransformWrapper, useTransformContext } from "react-zoom-pan-pinch";
import { usePlayerHead } from "../../components/PlayerHead";
import type { PlayerInsightsEntry, PlayerLocation } from "../../types";
import { playerHeadVersion } from "../../utils/playerHeads";
import {
  accuracyRadiusToMapUnits,
  layoutPlayerMapBadges,
  formatPing,
  formatLocation,
  latencyTone,
  playerMapArc,
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
 * fixed-size head badges use leader lines to those locations. Badge collision layout never moves
 * geographic anchors or the independent server marker.
 */

const mapWidth = 720;
const mapHeight = 360;
const desktopMarkerCollisionPx = 34;
const mobileMarkerCollisionPx = 32;
const clusterHoverCloseDelayMs = 160;
const serverMarkId = "server-location";

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
  const latency = mark.pingMs === undefined ? "" : ` · ${mark.pingMs} ms ping`;
  return `${players} near ${mark.label}${accuracy}${latency}`;
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

function MapPlayerPing({ entry }: { entry: PlayerInsightsEntry }) {
  const historical = !entry.online && entry.lastSessionAveragePingMs !== undefined;
  const pingMs = entry.online ? entry.pingMs : entry.lastSessionAveragePingMs;
  return (
    <b
      className={`playerMapPingValue playerMapPingValue--${historical ? "historical" : latencyTone(pingMs)}`}
      title={historical ? "Last session average; this player is offline" : undefined}
    >
      {formatPing(pingMs)}{historical ? " last avg" : ""}
    </b>
  );
}

function MapKeepScale(props: HTMLAttributes<HTMLDivElement>) {
  const elementRef = useRef<HTMLDivElement>(null);
  const transform = useTransformContext();

  useLayoutEffect(() => {
    const syncScale = (scale: number) => {
      if (!elementRef.current) return;
      elementRef.current.style.transform = transform.handleTransformStyles(0, 0, 1 / scale);
    };
    // Unlike the library's KeepScale helper, initialize before paint as well as on later map
    // transforms. Scope changes can mount a new marker while the map is already zoomed.
    syncScale(transform.state.scale);
    return transform.onChange((context) => syncScale(context.instance.state.scale));
  }, [transform]);

  return <div {...props} ref={elementRef} />;
}

function ContainedMapPopup({
  frameRef,
  anchorSelector = ".playerMapMarkerWrap--active .playerMapMarker",
  style,
  floating = false,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { frameRef: RefObject<HTMLDivElement | null>; anchorSelector?: string; floating?: boolean }) {
  const panelRef = useRef<HTMLSpanElement>(null);
  const transform = useTransformContext();

  useLayoutEffect(() => {
    let disposed = false;
    let positionQueued = false;
    const positionPanel = () => {
      positionQueued = false;
      const panel = panelRef.current;
      const frame = frameRef.current;
      const marker = frame?.querySelector<HTMLElement>(anchorSelector);
      if (disposed || !panel || !frame || !marker) return;

      panel.style.visibility = "hidden";
      panel.style.left = "0px";
      panel.style.top = "0px";
      panel.style.removeProperty("max-width");
      panel.style.removeProperty("max-height");

      const frameRect = frame.getBoundingClientRect();
      if (floating) {
        panel.style.maxWidth = `${frameRect.width - 24}px`;
        panel.style.maxHeight = `${frameRect.height - 24}px`;
        panel.style.left = `${Math.max(12, frameRect.width - panel.getBoundingClientRect().width - 12)}px`;
        panel.style.top = "12px";
        panel.style.visibility = "visible";
        return;
      }
      const markerRect = marker.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const placement = playerMapPopupPlacement({
        marker: {
          left: markerRect.left - frameRect.left,
          right: markerRect.right - frameRect.left,
          top: markerRect.top - frameRect.top,
          bottom: markerRect.bottom - frameRect.top
        },
        panel: { width: panelRect.width, height: panelRect.height },
        viewport: { width: frameRect.width, height: frameRect.height }
      });

      panel.style.maxWidth = `${placement.maxWidth}px`;
      panel.style.maxHeight = `${placement.maxHeight}px`;
      panel.style.left = `${placement.left}px`;
      panel.style.top = `${placement.top}px`;
      panel.dataset.placement = placement.placement;
      panel.style.visibility = "visible";
    };
    const queuePosition = () => {
      if (disposed || positionQueued) return;
      positionQueued = true;
      // MapKeepScale also reacts to the transform stream. Waiting for the current task's
      // microtask checkpoint guarantees its inverse scale is current before measuring.
      queueMicrotask(positionPanel);
    };

    queuePosition();
    const unsubscribe = transform.onChange(queuePosition);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(queuePosition);
    if (frameRef.current) observer?.observe(frameRef.current);
    if (!observer) window.addEventListener("resize", queuePosition);
    return () => {
      disposed = true;
      unsubscribe();
      observer?.disconnect();
      if (!observer) window.removeEventListener("resize", queuePosition);
    };
  }, [anchorSelector, frameRef, transform, floating]);

  return frameRef.current
    ? createPortal(<span {...props} ref={panelRef} style={style} />, frameRef.current)
    : null;
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
  const pinnedMarkRef = useRef<string | undefined>(undefined);
  const dismissedMarkRef = useRef<string | undefined>(undefined);
  const [expandedMarkId, setExpandedMarkId] = useState<string>();
  const [clusterZoom, setClusterZoom] = useState(1);
  useEffect(() => {
    // Recluster after the gesture settles, keeping the animated scene stable.
    const timer = window.setTimeout(() => setClusterZoom(zoomScale), 140);
    return () => window.clearTimeout(timer);
  }, [zoomScale]);
  const popupPrefix = useId().replace(/:/g, "");
  const headVersion = useMemo(() => playerHeadVersion(), []);
  const cancelScheduledClose = () => {
    if (closeTimerRef.current === undefined) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = undefined;
  };
  const openMark = (id: string) => {
    cancelScheduledClose();
    if (!pinnedMarkRef.current && dismissedMarkRef.current !== id) setHoveredMarkId(id);
  };
  const selectMark = (id: string) => {
    cancelScheduledClose();
    dismissedMarkRef.current = undefined;
    pinnedMarkRef.current = id;
    setHoveredMarkId(id);
    setExpandedMarkId(undefined);
  };
  const closeMark = () => {
    cancelScheduledClose();
    dismissedMarkRef.current = hoveredMarkId;
    pinnedMarkRef.current = undefined;
    setHoveredMarkId(undefined);
  };
  const scheduleMarkClose = (id: string) => {
    if (dismissedMarkRef.current === id) dismissedMarkRef.current = undefined;
    if (pinnedMarkRef.current === id) return;
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
      const width = viewport.clientWidth;
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

  // Measure screen spacing at the settled zoom level.
  const marks = useMemo(
    () => playerMapMarks(
      players,
      mapWidth,
      mapHeight,
      renderedWidth,
      renderedWidth < 560 ? mobileMarkerCollisionPx : desktopMarkerCollisionPx,
      clusterZoom
    ),
    [players, renderedWidth, clusterZoom]
  );
  useEffect(() => {
    const validIds = new Set([serverMarkId, ...marks.map((mark) => mark.id)]);
    if (pinnedMarkRef.current && !validIds.has(pinnedMarkRef.current)) pinnedMarkRef.current = undefined;
    setHoveredMarkId((current) => current !== undefined && !validIds.has(current) ? undefined : current);
  }, [marks]);

  useEffect(() => {
    if (!hoveredMarkId) return;
    const closeOutsidePopup = (event: PointerEvent) => {
      const activeMarker = frameRef.current?.querySelector(".playerMapMarkerWrap--active, .playerMapServerWrap--active");
      const activePopup = frameRef.current?.querySelector(".playerMapClusterPopup");
      if (event.target instanceof Node && !activeMarker?.contains(event.target) && !activePopup?.contains(event.target)) {
        if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = undefined;
        closeMark();
      }
    };
    document.addEventListener("pointerdown", closeOutsidePopup, true);
    return () => document.removeEventListener("pointerdown", closeOutsidePopup, true);
  }, [hoveredMarkId]);

  const layoutScale = renderedWidth / mapWidth;
  const scale = layoutScale * zoomScale;
  const server = useMemo(
    () => serverLocation?.latitude !== undefined && serverLocation.longitude !== undefined
      ? projectToMap(serverLocation.longitude, serverLocation.latitude, mapWidth, mapHeight)
      : undefined,
    [serverLocation?.latitude, serverLocation?.longitude]
  );
  const plottedMarks = useMemo(() => layoutPlayerMapBadges(marks, server, layoutScale * clusterZoom, mapWidth, mapHeight).map((badge) => ({
    ...badge,
    // Retain distinct reported locations even when they share a head badge.
    locations: [...new Map(badge.mark.entries.map((entry) => {
      const location = entry.location!;
      return [`${location.longitude}:${location.latitude}`, {
        ...projectToMap(location.longitude!, location.latitude!, mapWidth, mapHeight),
        radius: accuracyRadiusToMapUnits(location.accuracyRadiusKm ?? 0, mapWidth)
      }];
    })).values()]
  })), [marks, server, layoutScale, clusterZoom]);

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
          setZoomScale(state.scale);
        }}
      >
        {({ zoomIn, zoomOut, resetTransform }) => (
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
          preserveAspectRatio="none"
          role="img"
          aria-label={marks.length
            ? `World map showing ${marks.length} player ${marks.length === 1 ? "marker" : "markers"} for ${marks.reduce((total, mark) => total + mark.players.length, 0)} located players`
            : "World map with no located players yet"}
                  >
          <rect className="playerMapOcean" x="0" y="0" width={mapWidth} height={mapHeight} />
          <path className="playerMapLand" d={landPath} />
          <g className="playerMapLabels" aria-hidden="true">
            <text x="125" y="120">NORTH AMERICA</text><text x="220" y="260">SOUTH AMERICA</text>
            <text x="370" y="51">EUROPE</text><text x="550" y="100">ASIA</text>
            <text x="395" y="204">AFRICA</text><text x="605" y="280">OCEANIA</text>
            <text className="playerMapOceanLabel" x="285" y="170">Atlantic Ocean</text>
            <text className="playerMapOceanLabel" x="70" y="230">Pacific Ocean</text>
            <text className="playerMapOceanLabel" x="485" y="260">Indian Ocean</text>
          </g>
          {plottedMarks.map(({ mark, point, locations }) => (
            <g key={mark.id} className={`playerMapLocations ${mark.entries.length > 1 ? "playerMapLocations--group" : ""} ${hoveredMarkId === mark.id ? "playerMapLocations--active" : ""}`.trim()}>
              {server && Math.hypot(server.x - locations[0].x, server.y - locations[0].y) > 12 && (
                <path className={`playerMapRoute ${hoveredMarkId === mark.id ? "playerMapRoute--active" : ""}`} d={playerMapArc(server, locations[0]).path} />
              )}
              {locations.map((location, index) => (
                <g key={index}>
                  {hoveredMarkId === mark.id && location.radius > 0 && <circle className="playerMapAccuracy playerMapAccuracy--active" cx={location.x} cy={location.y} r={location.radius} />}
                  <line className="playerMapLeader" x1={location.x} y1={location.y} x2={point.x} y2={point.y} />
                  <circle className="playerMapLocationDot" cx={location.x} cy={location.y} r={3 / scale} />
                </g>
              ))}
            </g>
          ))}
        </svg>
        <div className="playerMapOverlay">
          {server && (
            <MapKeepScale
              className={`playerMapServerWrap ${hoveredMarkId === serverMarkId ? "playerMapServerWrap--active" : ""}`.trim()}
              style={{ left: `${server.x / mapWidth * 100}%`, top: `${server.y / mapHeight * 100}%` }}
              onMouseEnter={() => openMark(serverMarkId)}
              onMouseLeave={() => scheduleMarkClose(serverMarkId)}
              onFocus={() => openMark(serverMarkId)}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) scheduleMarkClose(serverMarkId);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  cancelScheduledClose();
                  closeMark();
                }
              }}
            >
              <button
                type="button"
                className={`playerMapServer playerMapServer--${serverRunning ? "running" : "stopped"}`}
                aria-label={`${serverName} server location`}
                aria-haspopup="dialog"
                aria-expanded={hoveredMarkId === serverMarkId}
                aria-controls={hoveredMarkId === serverMarkId ? `${popupPrefix}-server` : undefined}
                onClick={() => selectMark(serverMarkId)}
              >
                <ServerIcon aria-hidden="true" />
              </button>
              {hoveredMarkId === serverMarkId && (
                <ContainedMapPopup
                  id={`${popupPrefix}-server`}
                  className="playerMapClusterPopup playerMapServerPopup"
                  floating
                  frameRef={frameRef}
                  anchorSelector=".playerMapServer"
                  style={{ width: Math.min(270, renderedWidth - 16) }}
                  role="dialog"
                  aria-label="Server location"
                  tabIndex={0}
                  onMouseEnter={cancelScheduledClose}
                  onMouseLeave={() => scheduleMarkClose(serverMarkId)}
                  onFocus={cancelScheduledClose}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      frameRef.current?.querySelector<HTMLButtonElement>(".playerMapServer")?.focus();
                      cancelScheduledClose();
                      closeMark();
                    }
                  }}
                >
                  <span className="playerMapClusterPopupHeader">
                    <strong>{serverName}</strong>
                    <Button variant="ghost" compact className="playerMapPanelClose" aria-label="Close server location" onClick={closeMark}><X aria-hidden="true" /></Button>
                    <span>{serverRunning ? "Running" : "Stopped"}</span>
                  </span>
                  <span className="playerMapServerDetails">
                    <strong>{formatLocation(serverLocation)}</strong>
                    <span>{serverLocation?.latitude?.toFixed(4)}, {serverLocation?.longitude?.toFixed(4)}</span>
                    <span>IP location estimate{serverLocation?.accuracyRadiusKm ? ` · within about ${serverLocation.accuracyRadiusKm} km` : ""}</span>
                  </span>
                </ContainedMapPopup>
              )}
            </MapKeepScale>
          )}
          {plottedMarks.map(({ mark, point, hub }, index) => {
            const clustered = mark.entries.length > 1;
            const active = hoveredMarkId === mark.id;
            const popupId = `${popupPrefix}-player-map-${clustered ? "cluster" : "player"}-${index}`;
            const panelWidth = clustered
              ? Math.min(310, Math.max(180, renderedWidth - 16))
              : Math.min(220, Math.max(170, renderedWidth - 16));
            const markerLabel = clustered
              ? `${mark.entries.length} players near ${mark.label}. Average ping ${formatPing(mark.pingMs)}.`
              : markTitle(mark);
            return (
              <MapKeepScale
                key={mark.id}
                data-map-mark={mark.id}
                className={`playerMapMarkerWrap ${active ? "playerMapMarkerWrap--active" : ""}`.trim()}
                style={{ left: `${(point.x / mapWidth) * 100}%`, top: `${(point.y / mapHeight) * 100}%` }}
                onMouseEnter={() => { if (!clustered) openMark(mark.id); }}
                onMouseLeave={() => scheduleMarkClose(mark.id)}
                onFocus={() => { if (!clustered) openMark(mark.id); }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    cancelScheduledClose();
                    closeMark();
                  }
                }}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) {
                    scheduleMarkClose(mark.id);
                  }
                }}
              >
                <span className="playerMapMarkerScale">
                {clustered ? (
                  <button
                    onClick={() => selectMark(mark.id)}
                    type="button"
                    className={`playerMapMarker playerMapClusterMarker ${hub ? "playerMapClusterMarker--hub" : ""}`}
                    aria-label={markerLabel}
                    title={markerLabel}
                    aria-haspopup="dialog"
                    aria-expanded={active}
                    aria-controls={active ? popupId : undefined}
                  >
                    <span className="playerMapClusterHeads" aria-hidden="true">
                      {mark.entries.slice(0, 3).map((entry) => (
                        <MapPlayerAvatar key={`${entry.serverId}:${entry.player}`} entry={entry} version={headVersion} enabled={playerHeadsEnabled} compact />
                      ))}
                    </span>
                    <span className="playerMapClusterCount" aria-hidden="true">{mark.entries.length > 99 ? "99+" : mark.entries.length}</span>
                  </button>
                ) : (
                  <button
                    onClick={() => selectMark(mark.id)}
                    type="button"
                    className="playerMapMarker playerMapPlayerMarker"
                    aria-label={markerLabel}
                    aria-describedby={active ? popupId : undefined}
                  >
                    <MapPlayerAvatar entry={mark.entries[0]} version={headVersion} enabled={playerHeadsEnabled} />
                  </button>
                )}

                {active && clustered && (
                  <ContainedMapPopup
                    id={popupId}
                    className="playerMapClusterPopup playerMapRegionPanel"
                    floating
                    style={{ width: Math.min(320, renderedWidth - 24) }}
                    frameRef={frameRef}
                    role="dialog"
                    aria-label={`Players near ${mark.label}`}
                    tabIndex={0}
                    onMouseEnter={cancelScheduledClose}
                    onMouseLeave={() => scheduleMarkClose(mark.id)}
                    onFocus={cancelScheduledClose}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        cancelScheduledClose();
                        frameRef.current?.querySelector<HTMLButtonElement>(".playerMapMarkerWrap--active .playerMapMarker")?.focus();
                        closeMark();
                      }
                    }}
                  >
                    <span className="playerMapClusterPopupHeader">
                      <strong>{mark.label}</strong>
                      <Button variant="ghost" compact className="playerMapPanelClose" aria-label="Close region summary" onClick={closeMark}><X aria-hidden="true" /></Button>
                      <span>{mark.entries.length} players · <b className={`playerMapPingValue playerMapPingValue--${latencyTone(mark.pingMs)}`}>{formatPing(mark.pingMs)} avg. ping</b></span>
                    </span>
                    <span className="playerMapClusterList">
                      {(expandedMarkId === mark.id ? mark.entries : mark.entries.slice(0, 5)).map((entry) => (
                        <span className="playerMapClusterRow" key={`${entry.serverId}:${entry.player}`}>
                          <MapPlayerAvatar entry={entry} version={headVersion} enabled={playerHeadsEnabled} compact />
                          <strong>{entry.player}</strong>
                          <span>{formatLocation(entry.location)}</span>
                          <MapPlayerPing entry={entry} />
                        </span>
                      ))}
                    </span>
                    {mark.entries.length > 5 && expandedMarkId !== mark.id && (
                      <Button variant="secondary" compact onClick={() => setExpandedMarkId(mark.id)}>View all {mark.entries.length} players →</Button>
                    )}
                  </ContainedMapPopup>
                )}

                {active && !clustered && (
                  <ContainedMapPopup
                    id={popupId}
                    className="playerMapClusterPopup playerMapPlayerPopup"
                    style={{ width: panelWidth }}
                    frameRef={frameRef}
                    role="tooltip"
                    onMouseEnter={cancelScheduledClose}
                    onMouseLeave={() => scheduleMarkClose(mark.id)}
                    onFocus={cancelScheduledClose}
                  >
                    <span className="playerMapClusterPopupHeader">
                      <strong>{mark.entries[0].player}</strong>
                    </span>
                    <span className="playerMapClusterList playerMapSinglePlayerList">
                      <span className="playerMapClusterRow playerMapSinglePlayerRow">
                        <MapPlayerAvatar entry={mark.entries[0]} version={headVersion} enabled={playerHeadsEnabled} compact />
                        <span>{formatLocation(mark.entries[0].location)}</span>
                        <MapPlayerPing entry={mark.entries[0]} />
                      </span>
                    </span>
                  </ContainedMapPopup>
                )}
                </span>
              </MapKeepScale>
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
                  disabled={zoomScale >= 4}
                  onClick={() => zoomIn(0.5)}
                >
                  <Plus aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="playerMapControlButton"
                  aria-label="Zoom out"
                  title="Zoom out"
                  disabled={zoomScale <= 1}
                  onClick={() => zoomOut(0.5)}
                >
                  <Minus aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="playerMapControlButton"
                  aria-label="Reset map view"
                  title="Reset map view"
                  disabled={zoomScale <= 1}
                  onClick={() => resetTransform()}
                >
                  <RotateCcw aria-hidden="true" />
                </button>
            </div>
            <figcaption className="playerMapLegend">
              <span><i className="playerMapLegendServer" /> Server</span>
              <span><i className="playerMapLegendPlayer" /> Player locations</span>
              <span className="playerMapLegendHint">IP estimates · Select heads to highlight locations</span>
              <span role="status" aria-live="polite">{Math.round(zoomScale * 100)}%</span>
            </figcaption>
          </>
        )}
      </TransformWrapper>
    </figure>
  );
}
