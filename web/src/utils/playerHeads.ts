const playerHeadCacheWindowMs = 60 * 60 * 1000;

export function playerHeadSource(serverId: string, playerName: string, version: number) {
  return `/api/servers/${encodeURIComponent(serverId)}/player-head/${encodeURIComponent(playerName)}?v=${version}`;
}

/** Cache-busting stamp that only changes once per hour, so heads stay browser-cached in between. */
export function playerHeadVersion(atMs = Date.now()) {
  return Math.floor(atMs / playerHeadCacheWindowMs);
}
