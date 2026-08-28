import { isDemoServerId } from "../demoRuntime";

const playerHeadCacheWindowMs = 60 * 60 * 1000;

export const demoPlayerHeadNames = [
  "jeb_", "Dinnerbone", "slicedlime", "kingbdogz", "LadyAgnes", "Xilefian", "Cojomax99", "Grum", "Boq", "peterix", "Mega_Spud", "CornerHard", "Keso", "Gegy",
  "Sapnap", "Ranboo", "Technoblade", "CaptainSparklez", "DanTDM", "stampylonghead", "Ph1LzA", "BadBoyHalo", "Skeppy", "Quackity", "KarlJacobs", "Purpled", "Antfrost", "Punz", "Hannahxxrose", "awesamdude",
  "Grian", "MumboJumbo", "GoodTimeWithScar", "xisumavoid", "EthosLab", "Docm77", "BdoubleO100", "impulseSV", "Tango", "cubfan135", "falsesymmetry", "GeminiTay", "PearlescentMoon", "ZombieCleo", "iJevin", "Keralis", "VintageBeef", "hypnotizd", "Zedaph",
  "PhoenixSC", "AntVenom", "ibxtoycat", "wattles", "skipthetutorial", "aCookieGod", "camman18YT", "SB737", "Luke_TheNotable", "Smallishbeans", "LDShadowLady", "SolidarityGaming", "Smajor1995", "InTheLittleWood", "fruitberries", "PrestonPlayz"
] as const;

function demoPlayerHeadIndex(playerName: string) {
  let hash = 2_166_136_261;
  for (const character of playerName.trim().toLowerCase()) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return (hash >>> 0) % demoPlayerHeadNames.length;
}

/** Stable pseudo-random assignment: varied between demo players, unchanged across refreshes. */
export function demoPlayerHeadSource(playerName: string) {
  const sourceName = demoPlayerHeadNames[demoPlayerHeadIndex(playerName)];
  return `/demo-player-heads/${sourceName.toLowerCase()}.png`;
}

export function playerHeadSource(serverId: string, playerName: string, version: number) {
  if (isDemoServerId(serverId)) return demoPlayerHeadSource(playerName);
  return `/api/servers/${encodeURIComponent(serverId)}/player-head/${encodeURIComponent(playerName)}?v=${version}`;
}

/** Cache-busting stamp that only changes once per hour, so heads stay browser-cached in between. */
export function playerHeadVersion(atMs = Date.now()) {
  return Math.floor(atMs / playerHeadCacheWindowMs);
}
