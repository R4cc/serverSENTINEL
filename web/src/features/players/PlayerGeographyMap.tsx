import { useMemo } from "react";
import { Server as ServerIcon } from "lucide-react";
import type { PlayerLocation } from "../../types";
import { accuracyRadiusToMapUnits, playerMapMarks, projectToMap, type PlayerMapMark } from "./playerInsightsView";
import { worldLandRings } from "./worldOutline";
import type { PlayerInsightsEntry } from "../../types";

/**
 * Where this server's players connect from.
 *
 * Deliberately plain: a coastline, a mark per place, and a ring showing how far the estimate could
 * be out. The ring is the point of the drawing — GeoLite2 answers with an area, and a map that drew
 * only a dot would claim a precision that does not exist. The server's own position is drawn
 * differently again, because it is the one location on the map that is configuration rather than
 * inference.
 */

const mapWidth = 720;
const mapHeight = 360;

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

export function PlayerGeographyMap({
  players,
  serverLocation,
  serverName
}: {
  players: readonly PlayerInsightsEntry[];
  serverLocation: PlayerLocation | undefined;
  serverName: string;
}) {
  const land = useMemo(landPath, []);
  const marks = useMemo(() => playerMapMarks(players), [players]);
  const server = serverLocation?.latitude !== undefined && serverLocation.longitude !== undefined
    ? projectToMap(serverLocation.longitude, serverLocation.latitude, mapWidth, mapHeight)
    : undefined;

  return (
    <figure className="playerMap">
      <svg
        viewBox={`0 0 ${mapWidth} ${mapHeight}`}
        className="playerMapCanvas"
        role="img"
        aria-label={marks.length
          ? `World map showing ${marks.length} ${marks.length === 1 ? "place" : "places"} players connect from`
          : "World map with no located players yet"}
      >
        <rect className="playerMapOcean" x="0" y="0" width={mapWidth} height={mapHeight} />
        <path className="playerMapLand" d={land} />
        {server && marks.map((mark) => {
          const point = projectToMap(mark.longitude, mark.latitude, mapWidth, mapHeight);
          return (
            <line
              key={`link-${mark.id}`}
              className="playerMapLink"
              x1={server.x}
              y1={server.y}
              x2={point.x}
              y2={point.y}
            />
          );
        })}
        {marks.map((mark) => {
          const point = projectToMap(mark.longitude, mark.latitude, mapWidth, mapHeight);
          const accuracy = mark.accuracyRadiusKm ? accuracyRadiusToMapUnits(mark.accuracyRadiusKm, mapWidth) : 0;
          return (
            <g key={mark.id} className={`playerMapMark ${mark.online ? "playerMapMark--online" : ""}`.trim()}>
              <title>{markTitle(mark)}</title>
              {accuracy >= 2 && <circle className="playerMapAccuracy" cx={point.x} cy={point.y} r={Math.min(60, accuracy)} />}
              <circle className="playerMapDot" cx={point.x} cy={point.y} r={mark.players.length > 1 ? 4.5 : 3} />
            </g>
          );
        })}
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
    </figure>
  );
}
