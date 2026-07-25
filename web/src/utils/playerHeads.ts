export function playerHeadSource(serverId: string, playerName: string, version: number) {
  return `/api/servers/${encodeURIComponent(serverId)}/player-head/${encodeURIComponent(playerName)}?v=${version}`;
}
