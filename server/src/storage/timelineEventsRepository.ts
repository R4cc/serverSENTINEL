import type { ServerTimelineEvent } from "../types.js";
import type { StorageDatabase } from "./database.js";

type TimelineEventRow = { event_json: string };

export class TimelineEventsRepository {
  constructor(private readonly storage: StorageDatabase) {}

  list(serverId: string, from: number, to: number): ServerTimelineEvent[] {
    return this.storage.connection.prepare<[string, number, number], TimelineEventRow>(`
      SELECT event_json FROM timeline_events
      WHERE server_id = ? AND occurred_at >= ? AND occurred_at <= ?
      ORDER BY occurred_at, event_key
    `).all(serverId, from, to).map((row) => JSON.parse(row.event_json) as ServerTimelineEvent);
  }

  append(serverId: string, eventKey: string, event: ServerTimelineEvent) {
    this.storage.connection.prepare(`
      INSERT INTO timeline_events (server_id, event_key, occurred_at, event_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(server_id, event_key) DO UPDATE SET
        occurred_at = excluded.occurred_at,
        event_json = excluded.event_json
    `).run(serverId, eventKey, event.occurredAt, JSON.stringify(event));
  }

  prune(cutoff: number) {
    return this.storage.connection.prepare("DELETE FROM timeline_events WHERE occurred_at < ?").run(cutoff).changes;
  }
}
