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

/**
 * How long a server keeps `overviewFiles` on the background tick after an overview consumer asked
 * for it. The overview endpoint is event-driven rather than polled, so collecting the section for
 * the whole fleet would be waste; collecting it for nobody meant every overview refresh paid for an
 * unbatched single-server RPC.
 */
const overviewInterestMs = 2 * 60 * 1000;

export class RemoteObservationCoordinator {
  private readonly cache = new Map<string, CachedServer>();
  private readonly inFlightNodes = new Map<string, Promise<void>>();
  private readonly overviewInterest = new Map<string, number>();
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
    this.overviewInterest.clear();
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
    if (servers.length) await this.observeNode(servers, () => ["status", "stats", "players", "logs", "overviewFiles"]);
  }

  async read(server: ManagedServer, section: ServerObservationSection, maxAgeMs: number) {
    this.noteOverviewInterest(server.id, [section]);
    const cached = this.cache.get(server.id)?.[section];
    if (cached && Date.now() - cached.observedAt <= maxAgeMs) return cached.value;
    await this.observeNow(server, [section]);
    const refreshed = this.cache.get(server.id)?.[section];
    if (!refreshed) throw new Error(`Remote ${section} observation is unavailable`);
    return refreshed.value;
  }

  async readMany(server: ManagedServer, sections: ServerObservationSection[], maxAgeMs: number) {
    this.noteOverviewInterest(server.id, sections);
    const missing = sections.filter((section) => {
      const cached = this.cache.get(server.id)?.[section];
      return !cached || Date.now() - cached.observedAt > maxAgeMs;
    });
    if (missing.length) await this.observeNow(server, missing);
    return Object.fromEntries(sections.map((section) => [section, this.cache.get(server.id)?.[section]?.value]));
  }

  /**
   * Records that an overview consumer is watching this server, so the background tick starts
   * carrying `overviewFiles` for it and later refreshes come from cache instead of their own RPC.
   */
  private noteOverviewInterest(serverId: string, sections: ServerObservationSection[]) {
    if (sections.includes("overviewFiles")) this.overviewInterest.set(serverId, Date.now() + overviewInterestMs);
  }

  private async collectAll() {
    const servers = await this.options.readServers().catch(() => []);
    const active = new Set(servers.map((server) => server.id));
    for (const serverId of this.cache.keys()) if (!active.has(serverId)) this.cache.delete(serverId);
    const now = Date.now();
    for (const [serverId, expiresAt] of this.overviewInterest) {
      if (!active.has(serverId) || expiresAt <= now) this.overviewInterest.delete(serverId);
    }
    const sections: ServerObservationSection[] = this.tick % 2 === 0 ? ["status", "stats", "players", "logs"] : ["status", "stats"];
    const slowTick = this.tick % 2 === 0;
    this.tick += 1;
    const sectionsFor = (server: ManagedServer): ServerObservationSection[] =>
      slowTick && this.overviewInterest.has(server.id) ? [...sections, "overviewFiles"] : sections;
    // One lookup per distinct node instead of one per server: `lookupNode` reads and normalizes the
    // whole node table, and this loop runs every poll.
    const nodes = new Map<string, ManagedNode | undefined>();
    const byNode = new Map<string, ManagedServer[]>();
    for (const server of servers) {
      if (!nodes.has(server.nodeId)) nodes.set(server.nodeId, await this.options.lookupNode(server.nodeId));
      const node = nodes.get(server.nodeId);
      if (!node || !this.options.connections.isConnected(node.id) || !nodeAdvertisesCapability(node, "server.observe")) continue;
      const grouped = byNode.get(node.id) ?? [];
      grouped.push(server);
      byNode.set(node.id, grouped);
    }
    await Promise.allSettled(Array.from(byNode.entries()).map(async ([nodeId, grouped]) => {
      const existing = this.inFlightNodes.get(nodeId);
      if (existing) return existing;
      const request = this.observeNode(grouped, sectionsFor).finally(() => this.inFlightNodes.delete(nodeId));
      this.inFlightNodes.set(nodeId, request);
      return request;
    }));
  }

  private async observeNow(server: ManagedServer, sections: ServerObservationSection[]) {
    const node = await this.options.lookupNode(server.nodeId);
    if (!node || !this.options.connections.isConnected(node.id) || !nodeAdvertisesCapability(node, "server.observe")) {
      throw new Error(`Node ${server.nodeId} does not support optimized observations`);
    }
    await this.observeNode([server], () => sections);
  }

  private async observeNode(servers: ManagedServer[], sectionsFor: (server: ManagedServer) => ServerObservationSection[]) {
    const node = await this.options.lookupNode(servers[0]?.nodeId);
    if (!node) throw new Error("Remote node was not found");
    for (let offset = 0; offset < servers.length; offset += nodeProtocolObservationBatchSize) {
      const chunk = servers.slice(offset, offset + nodeProtocolObservationBatchSize);
      const response = normalizeServerObservationResponse(await this.options.connections.request(node, "server.observe", {
        items: chunk.map((server) => {
          const sections = sectionsFor(server);
          return {
            server: compactNodeServerSpec(server),
            sections,
            logCursor: sections.includes("logs") ? this.cache.get(server.id)?.logCursor : undefined
          };
        })
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
