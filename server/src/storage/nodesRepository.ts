import type { ManagedNode } from "../types.js";
import { asArray, asObject, optionalString, requiredString } from "./valueValidation.js";
import type { StorageDatabase } from "./database.js";

type NodeRow = {
  id: string;
  name: string;
  type: string;
  status: string;
  is_internal: number;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  connected_at: string | null;
  agent_version: string | null;
  build_id: string | null;
  protocol_version: string | null;
  capabilities_json: string | null;
  docker_status: string | null;
  data_path_status: string | null;
  total_memory: number | null;
  compatibility: string | null;
  secret_hash: string | null;
  join_token_hash: string | null;
  join_token_expires_at: string | null;
};

function optionalNodeTotalMemory(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function normalizeNode(value: unknown): ManagedNode {
  const node = asObject(value, "managed node");
  if (node.type !== "local" && node.type !== "remote") throw new Error("managed node type must be local or remote");
  if (node.status !== "online" && node.status !== "offline" && node.status !== "unknown") {
    throw new Error("managed node status must be online, offline, or unknown");
  }
  if (typeof node.isInternal !== "boolean") throw new Error("node.isInternal must be a boolean");
  const totalMemory = optionalNodeTotalMemory(node.totalMemory);
  if (node.totalMemory !== undefined && totalMemory === undefined) throw new Error("node.totalMemory must be a positive number");
  return {
    id: requiredString(node.id, "node.id"),
    name: requiredString(node.name, "node.name"),
    type: node.type,
    status: node.status,
    isInternal: node.isInternal,
    createdAt: requiredString(node.createdAt, "node.createdAt"),
    updatedAt: requiredString(node.updatedAt, "node.updatedAt"),
    lastSeenAt: optionalString(node.lastSeenAt, "node.lastSeenAt"),
    connectedAt: optionalString(node.connectedAt, "node.connectedAt"),
    agentVersion: optionalString(node.agentVersion, "node.agentVersion"),
    buildId: optionalString(node.buildId, "node.buildId"),
    protocolVersion: optionalString(node.protocolVersion, "node.protocolVersion"),
    capabilities: node.capabilities === undefined ? undefined : asArray(node.capabilities, "node.capabilities").map((item) => requiredString(item, "node.capabilities[]")),
    dockerStatus: optionalString(node.dockerStatus, "node.dockerStatus"),
    dataPathStatus: optionalString(node.dataPathStatus, "node.dataPathStatus"),
    totalMemory,
    compatibility: node.compatibility === "compatible" || node.compatibility === "incompatible" || node.compatibility === "unknown" ? node.compatibility : undefined,
    secretHash: optionalString(node.secretHash, "node.secretHash"),
    joinTokenHash: optionalString(node.joinTokenHash, "node.joinTokenHash"),
    joinTokenExpiresAt: optionalString(node.joinTokenExpiresAt, "node.joinTokenExpiresAt")
  };
}

function nodeFromRow(row: NodeRow) {
  return normalizeNode({
    id: row.id, name: row.name, type: row.type, status: row.status, isInternal: row.is_internal === 1,
    createdAt: row.created_at, updatedAt: row.updated_at, lastSeenAt: row.last_seen_at ?? undefined,
    connectedAt: row.connected_at ?? undefined, agentVersion: row.agent_version ?? undefined,
    buildId: row.build_id ?? undefined,
    protocolVersion: row.protocol_version ?? undefined,
    capabilities: row.capabilities_json ? JSON.parse(row.capabilities_json) as unknown : undefined,
    dockerStatus: row.docker_status ?? undefined, dataPathStatus: row.data_path_status ?? undefined,
    totalMemory: row.total_memory ?? undefined, compatibility: row.compatibility ?? undefined,
    secretHash: row.secret_hash ?? undefined, joinTokenHash: row.join_token_hash ?? undefined,
    joinTokenExpiresAt: row.join_token_expires_at ?? undefined
  });
}

export class NodesRepository {
  constructor(private readonly storage: StorageDatabase) {}

  list(): ManagedNode[] {
    return this.storage.connection.prepare<[], NodeRow>("SELECT * FROM nodes ORDER BY created_at, id").all().map(nodeFromRow);
  }

  create(node: ManagedNode) {
    this.storage.transaction((database) => {
      const normalized = normalizeNode(node);
      if (this.findById(normalized.id)) throw new Error(`Node ${normalized.id} already exists`);
      this.save(database, normalized);
    });
  }

  updateById(id: string, updater: (node: ManagedNode) => ManagedNode): ManagedNode {
    return this.storage.transaction((database) => {
      const current = this.findById(id);
      if (!current) this.notFound(id);
      const updated = normalizeNode(updater(current));
      if (updated.id !== id) throw new Error("Node id cannot be changed");
      this.save(database, updated);
      return updated;
    });
  }

  deleteWithServers(id: string, deleteServers: boolean) {
    return this.storage.transaction((database) => {
      const node = this.findById(id);
      if (!node) this.notFound(id);
      if (node.isInternal) throw new Error("Internal node cannot be deleted");
      const serverCount = database.prepare<[string], { count: number }>(
        "SELECT COUNT(*) AS count FROM servers WHERE node_id = ?"
      ).get(id)?.count ?? 0;
      if (serverCount > 0 && !deleteServers) throw new Error("Cannot delete a node while servers are assigned to it");
      if (deleteServers) database.prepare("DELETE FROM servers WHERE node_id = ?").run(id);
      database.prepare("DELETE FROM nodes WHERE id = ?").run(id);
      return { node, deletedServers: deleteServers ? serverCount : 0 };
    });
  }

  update(updater: (nodes: ManagedNode[]) => void) {
    this.storage.transaction((database) => {
      const nodes = this.list();
      updater(nodes);
      const normalized = nodes.map(normalizeNode);
      const existingIds = new Set(database.prepare<[], { id: string }>("SELECT id FROM nodes").all().map((row) => row.id));
      for (const node of normalized) {
        this.save(database, node);
        existingIds.delete(node.id);
      }
      const remove = database.prepare("DELETE FROM nodes WHERE id = ?");
      for (const id of existingIds) remove.run(id);
    });
  }

  private findById(id: string) {
    const row = this.storage.connection.prepare<[string], NodeRow>("SELECT * FROM nodes WHERE id = ?").get(id);
    return row ? nodeFromRow(row) : undefined;
  }

  private save(database: Database.Database, node: ManagedNode) {
    database.prepare(`
      INSERT INTO nodes (
        id, name, type, status, is_internal, created_at, updated_at, last_seen_at,
        connected_at, agent_version, build_id, protocol_version, capabilities_json, docker_status,
        data_path_status, total_memory, compatibility, secret_hash, join_token_hash,
        join_token_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, type=excluded.type, status=excluded.status,
        is_internal=excluded.is_internal, created_at=excluded.created_at,
        updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at,
        connected_at=excluded.connected_at, agent_version=excluded.agent_version,
        build_id=excluded.build_id, protocol_version=excluded.protocol_version,
        capabilities_json=excluded.capabilities_json,
        docker_status=excluded.docker_status, data_path_status=excluded.data_path_status,
        total_memory=excluded.total_memory, compatibility=excluded.compatibility,
        secret_hash=excluded.secret_hash, join_token_hash=excluded.join_token_hash,
        join_token_expires_at=excluded.join_token_expires_at
    `).run(
      node.id, node.name, node.type, node.status, node.isInternal ? 1 : 0,
      node.createdAt, node.updatedAt, node.lastSeenAt ?? null, node.connectedAt ?? null,
      node.agentVersion ?? null, node.buildId ?? null, node.protocolVersion ?? null,
      node.capabilities ? JSON.stringify(node.capabilities) : null, node.dockerStatus ?? null,
      node.dataPathStatus ?? null, node.totalMemory ?? null, node.compatibility ?? null,
      node.secretHash ?? null, node.joinTokenHash ?? null, node.joinTokenExpiresAt ?? null
    );
  }

  private notFound(id: string): never {
    const error = new Error(`Node ${id} not found`) as Error & { statusCode?: number; code?: string };
    error.statusCode = 404;
    error.code = "node_not_found";
    throw error;
  }
}
import type Database from "better-sqlite3";
