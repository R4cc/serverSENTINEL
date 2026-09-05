import type { PlayerActivityHour } from "@serversentinel/contracts";
import type { ResourceStatsRepository } from "../storage/resourceStatsRepository.js";
import { playerActivityHours } from "./playerInsights.js";

/** Finished aggregates only: bounded across server selections, with at most one minute of lag. */
export class PlayerActivityCache {
  private readonly entries = new Map<string, { at: number; hours: PlayerActivityHour[] }>();

  constructor(private readonly repository: Pick<ResourceStatsRepository, "activitySamples">) {}

  hours(serverIds: string[], timeZone: string, windowMs: number, now: number) {
    const ids = [...new Set(serverIds)].sort();
    const key = JSON.stringify([ids, timeZone, windowMs]);
    const cached = this.entries.get(key);
    if (cached && now >= cached.at && now - cached.at < 60_000) return cached.hours;
    const from = now - windowMs;
    const hours = playerActivityHours({
      resourceSamples: Object.fromEntries(ids.map((id) => [id, this.repository.activitySamples(id, from, now)])),
      timeZone,
      from
    });
    this.entries.delete(key);
    if (this.entries.size >= 32) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { at: now, hours });
    return hours;
  }
}
