import type { Session } from "../types.js";
import type { StorageDatabase } from "./database.js";

type SessionRow = { id: string; user_id: string; created_at: string };

export class SessionsRepository {
  constructor(private readonly storage: StorageDatabase) {}

  find(id: string): Session | undefined {
    const row = this.storage.connection.prepare<[string], SessionRow>(
      "SELECT id, user_id, created_at FROM sessions WHERE id = ?"
    ).get(id);
    return row ? { id: row.id, userId: row.user_id, createdAt: row.created_at } : undefined;
  }

  create(session: Session) {
    this.storage.connection.prepare("INSERT INTO sessions (id, user_id, created_at) VALUES (?, ?, ?)")
      .run(session.id, session.userId, session.createdAt);
  }

  delete(id: string) {
    this.storage.connection.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }
}
