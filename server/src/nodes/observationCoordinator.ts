import type { ManagedNode, ManagedServer } from "../types.js";
import { compactNodeServerSpec, nodeAdvertisesCapability, nodeProtocolObservationBatchSize, normalizeServerObservationResponse } from "./protocol.js";
import type { ServerLogCursor, ServerObservationResultItem, ServerObservationSection } from "./protocol.js";
import type { PanelNodeConnections } from "./panelConnections.js";

type CachedSection = { value: unknown; observedAt: number };
type CachedServer = Partial<Record<ServerObservationSection, CachedSection>> & { logCursor?: ServerLogCursor; logText?: string };

type ObservationCoordinatorOptions = {
  readServers: () => Promise<ManagedServer[]>;
  lookupNode: (nodeId: string) => Promise<ManagedNode | undefined>;
  connections: PanelNodeConnections;
  pollMs?: number;
};

const recentLogCacheBytes = 128 * 1024;

export class RemoteObservationCoordinator {
  private readonly cache = new Map<string, CachedServer>();
  private readonly inFlightNodes = new Map<string, Promise<void>>();
  private readonly pollMs: number;
  private interval: NodeJS.Timeout | undefined;
  private tick = 0;

  constructor(private readonly options: ObservationCoordinatorOptions) {
    this.pollMs = options.pollMs ?? 5_000;
  }

  start() {
    if (this.interval) return;
    void this.collectAll();
    this.interval = setInterval(() => void this.collectAll(), this.pollMs);
    this.interval.unref?.();
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    this.cache.clear();
    this.inFlightNodes.clear();
  }

  invalidate(serverId: string, sections?: ServerObservationSection[]) {
    if (!sections) {
      this.cache.delete(serverId);
      return;
    }
    const cached = this.cache.get(serverId);
    if (!cached) return;
    for (const section of sections) delete cached[section];
    if (sections.includes("logs")) {
      cached.logCursor = undefined;
      cached.logText = undefined;
    }
  }

  async refreshNode(nodeId: string) {
    const servers = (await this.options.readServers()).filter((server) => server.nodeId === nodeId);
    for (const server of servers) this.invalidate(server.id);
    if (servers.length) await this.observeNode(servers, ["status", "stats", "players", "logs", "overviewFiles"]);
  }

  async read(server: ManagedServer, section: ServerObservationSection, maxAgeMs: number) {
    const cached = this.cache.get(server.id)?.[section];
    if (cached && Date.now() - cached.observedAt <= maxAgeMs) return cached.value;
    await this.observeNow(server, [section]);
    const refreshed = this.cache.get(server.id)?.[section];
    if (!refreshed) throw new Error(`Remote ${section} observation is unavailable`);
    return refreshed.value;
  }

  async readMany(server: ManagedServer, sections: ServerObservationSection[], maxAgeMs: number) {
    const missing = sections.filter((section) => {
      const cached = this.cache.get(server.id)?.[section];
      return !cached || Date.now() - cached.observedAt > maxAgeMs;
    });
    if (missing.length) await this.observeNow(server, missing);
    return Object.fromEntries(sections.map((section) => [section, this.cache.get(server.id)?.[section]?.value]));
  }

  private async collectAll() {
    const servers = await this.options.readServers().catch(() => []);
    const active = new Set(servers.map((server) => server.id));
    for (const serverId of this.cache.keys()) if (!active.has(serverId)) this.cache.delete(serverId);
    const sections: ServerObservationSection[] = this.tick % 2 === 0 ? ["status", "stats", "players", "logs"] : ["status", "stats"];
    this.tick += 1;
    const byNode = new Map<string, ManagedServer[]>();
    for (const server of servers) {
      const node = await this.options.lookupNode(server.nodeId);
      if (!node || !this.options.connections.isConnected(node.id) || !nodeAdvertisesCapability(node, "server.observe")) continue;
      const grouped = byNode.get(node.id) ?? [];
      grouped.push(server);
      byNode.set(node.id, grouped);
    }
    await Promise.allSettled(Array.from(byNode.entries()).map(async ([nodeId, grouped]) => {
      const existing = this.inFlightNodes.get(nodeId);
      if (existing) return existing;
      const request = this.observeNode(grouped, sections).finally(() => this.inFlightNodes.delete(nodeId));
      this.inFlightNodes.set(nodeId, request);
      return request;
    }));
  }

  private async observeNow(server: ManagedServer, sections: ServerObservationSection[]) {
    const node = await this.options.lookupNode(server.nodeId);
    if (!node || !this.options.connections.isConnected(node.id) || !nodeAdvertisesCapability(node, "server.observe")) {
      throw new Error(`Node ${server.nodeId} does not support optimized observations`);
    }
    await this.observeNode([server], sections);
  }

  private async observeNode(servers: ManagedServer[], sections: ServerObservationSection[]) {
    const node = await this.options.lookupNode(servers[0]?.nodeId);
    if (!node) throw new Error("Remote node was not found");
    for (let offset = 0; offset < servers.length; offset += nodeProtocolObservationBatchSize) {
      const chunk = servers.slice(offset, offset + nodeProtocolObservationBatchSize);
      const response = normalizeServerObservationResponse(await this.options.connections.request(node, "server.observe", {
        items: chunk.map((server) => ({
          server: compactNodeServerSpec(server),
          sections,
          logCursor: sections.includes("logs") ? this.cache.get(server.id)?.logCursor : undefined
        }))
      }, 15_000));
      const observedAt = Date.parse(response.observedAt) || Date.now();
      for (const item of response.items) this.store(item, observedAt);
    }
  }

  private store(item: ServerObservationResultItem, observedAt: number) {
    const cached = this.cache.get(item.serverId) ?? {};
    if (item.status !== undefined) cached.status = { value: item.status, observedAt };
    if (item.stats !== undefined) cached.stats = { value: item.stats, observedAt };
    if (item.players !== undefined) cached.players = { value: item.players, observedAt };
    if (item.overviewFiles !== undefined) cached.overviewFiles = { value: item.overviewFiles, observedAt };
    if (item.logs !== undefined) {
      const combined = item.logs.reset ? item.logs.text : `${cached.logText ?? ""}${item.logs.text}`;
      cached.logText = combined.length > recentLogCacheBytes ? combined.slice(-recentLogCacheBytes) : combined;
      cached.logCursor = item.logs.cursor;
      cached.logs = { value: { text: cached.logText, source: item.logs.source }, observedAt };
    }
    this.cache.set(item.serverId, cached);
  }
}
