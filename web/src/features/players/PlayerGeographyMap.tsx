import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, RotateCcw, Server as ServerIcon } from "lucide-react";
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
  style,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { frameRef: RefObject<HTMLDivElement | null> }) {
  const panelRef = useRef<HTMLSpanElement>(null);
  const transform = useTransformContext();

  useLayoutEffect(() => {
    let disposed = false;
    let positionQueued = false;
    const positionPanel = () => {
      positionQueued = false;
      const panel = panelRef.current;
      const frame = frameRef.current;
      const marker = frame?.querySelector<HTMLElement>(".playerMapMarkerWrap--active .playerMapMarker");
      if (disposed || !panel || !frame || !marker) return;

      panel.style.visibility = "hidden";
      panel.style.left = "0px";
      panel.style.top = "0px";
      panel.style.removeProperty("max-width");
      panel.style.removeProperty("max-height");

      const frameRect = frame.getBoundingClientRect();
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
  }, [frameRef, transform]);

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
      const activePopup = frameRef.current?.querySelector(".playerMapClusterPopup");
      if (event.target instanceof Node && !activeMarker?.contains(event.target) && !activePopup?.contains(event.target)) {
        if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = undefined;
        setHoveredMarkId(undefined);
      }
    };
    document.addEventListener("pointerdown", closeOutsidePopup, true);
    return () => document.removeEventListener("pointerdown", closeOutsidePopup, true);
  }, [hoveredMarkId]);

  const scale = (renderedWidth / mapWidth) * zoomScale;
  const server = useMemo(
    () => serverLocation?.latitude !== undefined && serverLocation.longitude !== undefined
      ? projectToMap(serverLocation.longitude, serverLocation.latitude, mapWidth, mapHeight)
      : undefined,
    [serverLocation?.latitude, serverLocation?.longitude]
  );
  const plottedMarks = useMemo(() => layoutPlayerMapBadges(marks, server, scale, mapWidth, mapHeight).map((badge) => ({
    ...badge,
    // Retain distinct reported locations even when they share a head badge.
    locations: [...new Map(badge.mark.entries.map((entry) => {
      const location = entry.location!;
      return [`${location.longitude}:${location.latitude}`, {
        ...projectToMap(location.longitude!, location.latitude!, mapWidth, mapHeight),
        radius: accuracyRadiusToMapUnits(location.accuracyRadiusKm ?? 0, mapWidth)
      }];
    })).values()]
  })), [marks, server, scale]);

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
          role="img"
          aria-label={marks.length
            ? `World map showing ${marks.length} player ${marks.length === 1 ? "marker" : "markers"} for ${marks.reduce((total, mark) => total + mark.players.length, 0)} located players`
            : "World map with no located players yet"}
                  >
          <rect className="playerMapOcean" x="0" y="0" width={mapWidth} height={mapHeight} />
          <path className="playerMapLand" d={landPath} />
          <path className="playerMapGrid" d="M0 60H720 M0 120H720 M0 180H720 M0 240H720 M0 300H720 M120 0V360 M240 0V360 M360 0V360 M480 0V360 M600 0V360" />
          {plottedMarks.map(({ mark, point, locations }) => (
            <g key={mark.id} className={`playerMapLocations ${mark.entries.length > 1 ? "playerMapLocations--group" : ""} ${hoveredMarkId === mark.id ? "playerMapLocations--active" : ""}`.trim()}>
              {locations.map((location, index) => (
                <g key={index}>
                  {hoveredMarkId === mark.id && location.radius > 0 && <circle className="playerMapAccuracy playerMapAccuracy--active" cx={location.x} cy={location.y} r={location.radius} />}
                  {server && hoveredMarkId === mark.id && Math.hypot(server.x - location.x, server.y - location.y) > 0.01 && <path className={`playerMapRoute playerMapRoute--active playerMapRoute--${latencyTone(mark.pingMs)}`} d={playerMapArc(server, location).path} />}
                  <line className="playerMapLeader" x1={location.x} y1={location.y} x2={point.x} y2={point.y} />
                  <circle className="playerMapLocationDot" cx={location.x} cy={location.y} r={3 / scale} />
                </g>
              ))}
            </g>
          ))}
        </svg>
        <div className="playerMapOverlay">
          {server && <MapKeepScale className="playerMapServerWrap" style={{ left: `${server.x / mapWidth * 100}%`, top: `${server.y / mapHeight * 100}%` }}>
            <span className={`playerMapServer playerMapServer--${serverRunning ? "running" : "stopped"}`} tabIndex={0} role="img" aria-label={`${serverName} · ${serverLocation?.label ?? "server location"} · ${serverRunning ? "Running" : "Stopped"}`} title={`${serverName} · ${serverLocation?.label ?? "server location"}`}>
              <ServerIcon aria-hidden="true" />
            </span>
          </MapKeepScale>}
          {plottedMarks.map(({ mark, point }, index) => {
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
                className={`playerMapMarkerWrap ${active ? "playerMapMarkerWrap--active" : ""}`.trim()}
                style={{ left: `${(point.x / mapWidth) * 100}%`, top: `${(point.y / mapHeight) * 100}%` }}
                onMouseEnter={() => openMark(mark.id)}
                onMouseLeave={() => scheduleMarkClose(mark.id)}
                onFocus={() => openMark(mark.id)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    cancelScheduledClose();
                    setHoveredMarkId(undefined);
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
                    onClick={() => openMark(mark.id)}
                    type="button"
                    className="playerMapMarker playerMapClusterMarker"
                    aria-label={markerLabel}
                    aria-haspopup="dialog"
                    aria-expanded={active}
                    aria-controls={active ? popupId : undefined}
                  >
                    <span className="playerMapClusterHeads" aria-hidden="true">
                      {mark.entries.slice(0, 1).map((entry) => (
                        <MapPlayerAvatar key={`${entry.serverId}:${entry.player}`} entry={entry} version={headVersion} enabled={playerHeadsEnabled} compact />
                      ))}
                    </span>
                    <span className="playerMapClusterCount" aria-hidden="true">{mark.entries.length > 99 ? "99+" : mark.entries.length}</span>
                  </button>
                ) : (
                  <button
                    onClick={() => openMark(mark.id)}
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
                    className="playerMapClusterPopup"
                    style={{ width: panelWidth }}
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
                        setHoveredMarkId(undefined);
                      }
                    }}
                  >
                    <span className="playerMapClusterPopupHeader">
                      <strong>{mark.label}</strong>
                      <span>{mark.entries.length} players · <b className={`playerMapPingValue playerMapPingValue--${latencyTone(mark.pingMs)}`}>{formatPing(mark.pingMs)} avg.</b></span>
                    </span>
                    <span className="playerMapClusterList">
                      {mark.entries.map((entry) => (
                        <span className="playerMapClusterRow" key={`${entry.serverId}:${entry.player}`}>
                          <MapPlayerAvatar entry={entry} version={headVersion} enabled={playerHeadsEnabled} compact />
                          <strong>{entry.player}</strong>
                          <span>{formatLocation(entry.location)}</span>
                          <MapPlayerPing entry={entry} />
                        </span>
                      ))}
                    </span>
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
