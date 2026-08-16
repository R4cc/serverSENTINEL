import { useEffect, useState } from "react";
import { playerHeadSource } from "../utils/playerHeads";

/**
 * One player's avatar, served by the panel's own cache rather than by the browser reaching a third
 * party. Heads are an opt-in integration, so `enabled` is false for most installations, and a head
 * that fails to load falls back rather than leaving a broken image where the player's name is.
 */
export function usePlayerHead(serverId: string, playerName: string | undefined, version: number, enabled: boolean) {
  const source = playerName && serverId ? playerHeadSource(serverId, playerName, version) : "";
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source, enabled]);
  return { source, showHead: enabled && Boolean(source) && !failed, onHeadError: () => setFailed(true) };
}

export function PlayerHead({
  serverId,
  playerName,
  version,
  enabled,
  className = "playerHead"
}: {
  serverId: string;
  playerName: string;
  version: number;
  enabled: boolean;
  className?: string;
}) {
  const { source, showHead, onHeadError } = usePlayerHead(serverId, playerName, version, enabled);
  if (!showHead) return <span className={`${className} ${className}--placeholder`} aria-hidden="true" />;
  return (
    <span className={className} aria-hidden="true">
      <img src={source} alt="" loading="lazy" decoding="async" onError={onHeadError} />
    </span>
  );
}
