import { setMaxListeners } from "node:events";
import type { ManagedNode, ManagedServer } from "../types.js";
import { compactNodeServerSpec, nodeAdvertisesCapability, nodeProtocolObservationBatchSize, normalizeServerObservationResponse, structuredNodeProtocolError } from "./protocol.js";
import type { ServerLogCursor, ServerObservationResultItem, ServerObservationSection } from "./protocol.js";
import type { PanelNodeConnections } from "./panelConnections.js";

type CachedSection = { value: unknown; observedAt: number; sequence: number };
type ObservationFailure = NonNullable<NonNullable<ServerObservationResultItem["errors"]>[ServerObservationSection]>;
type CachedFailure = { error: ObservationFailure; observedAt: number; sequence: number };
type CachedServer = Partial<Record<ServerObservationSection, CachedSection>> & {
  failures?: Partial<Record<ServerObservationSection, CachedFailure>>;
  logCursor?: ServerLogCursor;
  logText?: string;
};

type ObservationCoordinatorOptions = {
  readServers: () => Promise<ManagedServer[]>;
  isServerActive?: (serverId: string) => boolean;
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
const observationSections: ServerObservationSection[] = ["status", "stats", "players", "logs", "overviewFiles"];

export class RemoteObservationCoordinator {
  private readonly shutdown = new AbortController();
  private readonly cache = new Map<string, CachedServer>();
  private readonly inFlightNodes = new Map<string, Promise<void>>();
  private readonly inFlightForeground = new Map<string, Promise<void>>();
  private readonly overviewInterest = new Map<string, number>();
  private readonly pollMs: number;
  private interval: NodeJS.Timeout | undefined;
  private tick = 0;
  private sequence = 0;
  private closed = false;
  private readonly generations = new Map<string, Partial<Record<ServerObservationSection, number>>>();

  constructor(private readonly options: ObservationCoordinatorOptions) {
    this.pollMs = options.pollMs ?? 5_000;
    // This owned signal broadcasts to the whole fleet; each RPC removes its listener on completion.
    setMaxListeners(0, this.shutdown.signal);
  }

  start() {
    if (this.interval || this.closed) return;
    void this.collectAll().catch(() => undefined);
    this.interval = setInterval(() => void this.collectAll().catch(() => undefined), this.pollMs);
    this.interval.unref?.();
  }

  stop() {
    this.closed = true;
    this.shutdown.abort();
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    this.cache.clear();
    this.inFlightNodes.clear();
    this.inFlightForeground.clear();
    this.overviewInterest.clear();
  }

  invalidate(serverId: string, sections?: ServerObservationSection[]) {
    const generations = this.generations.get(serverId) ?? {};
    for (const section of sections ?? observationSections) generations[section] = (generations[section] ?? 0) + 1;
    this.generations.set(serverId, generations);
    if (!sections) {
      this.cache.delete(serverId);
      return;
    }
    const cached = this.cache.get(serverId);
    if (!cached) return;
    for (const section of sections) {
      delete cached[section];
      if (cached.failures) delete cached.failures[section];
    }
    if (sections.includes("logs")) {
      cached.logCursor = undefined;
      cached.logText = undefined;
    }
  }

  async refreshNode(nodeId: string) {
    if (this.closed) return;
    const existing = this.inFlightNodes.get(nodeId);
    if (existing) return existing;
    const servers = (await this.options.readServers()).filter((server) => server.nodeId === nodeId);
    if (this.closed) return;
    for (const server of servers) this.invalidate(server.id);
    if (servers.length) await this.observeNodeOnce(nodeId, () => this.observeNode(servers, () => ["status", "stats", "players", "logs", "overviewFiles"]));
  }

  async read(server: ManagedServer, section: ServerObservationSection, maxAgeMs: number) {
    this.assertActive(server.id);
    this.noteOverviewInterest(server.id, [section]);
    const cached = this.cache.get(server.id)?.[section];
    if (cached && Date.now() - cached.observedAt <= maxAgeMs) return cached.value;
    await this.observeNow(server, [section], maxAgeMs);
    const refreshed = this.cache.get(server.id)?.[section];
    if (!refreshed || Date.now() - refreshed.observedAt > maxAgeMs) this.throwObservationFailure(server.id, section);
    return refreshed.value;
  }

  async readMany(server: ManagedServer, sections: ServerObservationSection[], maxAgeMs: number) {
    this.assertActive(server.id);
    this.noteOverviewInterest(server.id, sections);
    const missing = sections.filter((section) => {
      const cached = this.cache.get(server.id)?.[section];
      return !cached || Date.now() - cached.observedAt > maxAgeMs;
    });
    if (missing.length) await this.observeNow(server, missing, maxAgeMs);
    const now = Date.now();
    return Object.fromEntries(sections.map((section) => {
      const cached = this.cache.get(server.id)?.[section];
      return [section, cached && now - cached.observedAt <= maxAgeMs ? cached.value : undefined];
    }));
  }

  /**
   * Records that an overview consumer is watching this server, so the background tick starts
   * carrying `overviewFiles` for it and later refreshes come from cache instead of their own RPC.
   */
  private noteOverviewInterest(serverId: string, sections: ServerObservationSection[]) {
    if (sections.includes("overviewFiles")) this.overviewInterest.set(serverId, Date.now() + overviewInterestMs);
  }

  private async collectAll() {
    if (this.closed) return;
    const servers = await this.options.readServers().catch(() => []);
    if (this.closed) return;
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
      if (this.closed) return;
      const node = nodes.get(server.nodeId);
      if (!node || !this.options.connections.isConnected(node.id) || !nodeAdvertisesCapability(node, "server.observe")) continue;
      const grouped = byNode.get(node.id) ?? [];
      grouped.push(server);
      byNode.set(node.id, grouped);
    }
    await Promise.allSettled(Array.from(byNode.entries()).map(async ([nodeId, grouped]) => {
      return this.observeNodeOnce(nodeId, () => this.observeNode(grouped, sectionsFor, nodes.get(nodeId)));
    }));
  }

  private async observeNow(server: ManagedServer, sections: ServerObservationSection[], maxAgeMs: number) {
    const node = await this.options.lookupNode(server.nodeId);
    this.assertActive(server.id);
    if (!node || !this.options.connections.isConnected(node.id) || !nodeAdvertisesCapability(node, "server.observe")) {
      throw new Error(`Node ${server.nodeId} does not support optimized observations`);
    }
    const now = Date.now();
    const stillMissing = sections.filter((section) => {
      const cached = this.cache.get(server.id)?.[section];
      return !cached || now - cached.observedAt > maxAgeMs;
    });
    if (!stillMissing.length) return;
    // A visible server must not queue behind a fleet-wide background batch. The node protocol
    // permits concurrent requests, and sequence-aware storage below prevents an older background
    // response from replacing the newer foreground result when it eventually arrives.
    const key = `${server.id}:${[...stillMissing].sort().map((section) => `${section}:${this.generations.get(server.id)?.[section] ?? 0}`).join(",")}`;
    await this.observeForegroundOnce(key, () => this.observeNode([server], () => stillMissing, node));
  }

  private observeNodeOnce(nodeId: string, operation: () => Promise<void>) {
    const existing = this.inFlightNodes.get(nodeId);
    if (existing) return existing;
    const request = operation().finally(() => {
      if (this.inFlightNodes.get(nodeId) === request) this.inFlightNodes.delete(nodeId);
    });
    this.inFlightNodes.set(nodeId, request);
    return request;
  }

  private observeForegroundOnce(key: string, operation: () => Promise<void>) {
    const existing = this.inFlightForeground.get(key);
    if (existing) return existing;
    const request = operation().finally(() => {
      if (this.inFlightForeground.get(key) === request) this.inFlightForeground.delete(key);
    });
    this.inFlightForeground.set(key, request);
    return request;
  }

  private async observeNode(servers: ManagedServer[], sectionsFor: (server: ManagedServer) => ServerObservationSection[], resolvedNode?: ManagedNode) {
    const node = resolvedNode ?? await this.options.lookupNode(servers[0]?.nodeId);
    if (this.closed) return;
    if (!node) throw new Error("Remote node was not found");
    for (let offset = 0; offset < servers.length; offset += nodeProtocolObservationBatchSize) {
      const chunk = servers.slice(offset, offset + nodeProtocolObservationBatchSize);
      this.sequence += 1;
      const sequence = this.sequence;
      if (this.closed) return;
      const logBases = new Map<string, string>();
      const requestGenerations = new Map<string, Partial<Record<ServerObservationSection, number>>>();
      const requested = chunk.map((server) => {
        const sections = sectionsFor(server);
        requestGenerations.set(server.id, Object.fromEntries(sections.map((section) => [section, this.generations.get(server.id)?.[section] ?? 0])));
        if (sections.includes("logs")) logBases.set(server.id, this.cache.get(server.id)?.logText ?? "");
        return {
          server: compactNodeServerSpec(server),
          sections,
          logCursor: sections.includes("logs") ? this.cache.get(server.id)?.logCursor : undefined
        };
      });
      const response = normalizeServerObservationResponse(await this.options.connections.request(node, "server.observe", {
        items: requested
      }, 15_000, this.shutdown.signal));
      if (this.closed) return;
      try {
        this.validateResponse(requested.map((item) => ({ serverId: item.server.id, sections: item.sections })), response.items);
      } catch (error) {
        for (const item of requested) this.invalidate(item.server.id, item.sections.filter((section) =>
          (this.generations.get(item.server.id)?.[section] ?? 0) === requestGenerations.get(item.server.id)?.[section]
          && Math.max(this.cache.get(item.server.id)?.[section]?.sequence ?? 0,
            this.cache.get(item.server.id)?.failures?.[section]?.sequence ?? 0) <= sequence));
        throw error;
      }
      // `response.observedAt` comes off the node's wall clock while every reader ages the cache
      // against the panel's. A node running even a second behind made every observation look stale
      // on arrival, so each read forced its own round trip alongside the background tick.
      const observedAt = Date.now();
      for (const item of response.items) this.store(item, observedAt, sequence, requestGenerations.get(item.serverId) ?? {}, logBases.get(item.serverId));
    }
  }

  private store(item: ServerObservationResultItem, observedAt: number, sequence: number, generations: Partial<Record<ServerObservationSection, number>>, logBase = "") {
    if (this.closed || this.options.isServerActive?.(item.serverId) === false) return;
    const cached = this.cache.get(item.serverId) ?? {};
    // A background tick and an on-demand read can be in flight together, and the older request can
    // answer last. Counter-backed sections such as `stats` read as a reset when that happens, so
    // the later-issued observation wins regardless of arrival order.
    const superseded = (section: ServerObservationSection) => (this.generations.get(item.serverId)?.[section] ?? 0) !== generations[section] || Math.max(cached[section]?.sequence ?? 0, cached.failures?.[section]?.sequence ?? 0) > sequence;
    const entry = (value: unknown) => ({ value, observedAt, sequence });
    const success = (section: ServerObservationSection, value: unknown) => {
      if (value === undefined || superseded(section)) return;
      cached[section] = entry(value);
      if (cached.failures) delete cached.failures[section];
    };
    success("status", item.status);
    success("stats", item.stats);
    success("players", item.players);
    success("overviewFiles", item.overviewFiles);
    if (item.logs !== undefined && !superseded("logs")) {
      // The delta belongs to the cursor sent with this request. Another in-flight observation
      // may already have appended overlapping bytes to the cache before this response arrives.
      const combined = item.logs.reset ? item.logs.text : `${logBase}${item.logs.text}`;
      cached.logText = combined.length > recentLogCacheBytes ? combined.slice(-recentLogCacheBytes) : combined;
      cached.logCursor = item.logs.cursor;
      cached.logs = entry({ text: cached.logText, source: item.logs.source });
      if (cached.failures) delete cached.failures.logs;
    }
    for (const [section, error] of Object.entries(item.errors ?? {}) as Array<[ServerObservationSection, ObservationFailure]>) {
      if (superseded(section)) continue;
      delete cached[section];
      if (section === "logs") {
        cached.logCursor = undefined;
        cached.logText = undefined;
      }
      cached.failures ??= {};
      cached.failures[section] = { error, observedAt, sequence };
    }
    this.cache.set(item.serverId, cached);
  }

  private assertActive(serverId: string) {
    if (this.closed || this.options.isServerActive?.(serverId) === false) {
      throw structuredNodeProtocolError("observation_unavailable", "Observation collection stopped or server was deleted");
    }
  }

  private validateResponse(
    requested: Array<{ serverId: string; sections: ServerObservationSection[] }>,
    items: ServerObservationResultItem[]
  ) {
    const expected = new Map(requested.map((item) => [item.serverId, new Set(item.sections)]));
    const seen = new Set<string>();
    if (expected.size !== requested.length || items.length !== requested.length) {
      throw structuredNodeProtocolError("invalid_observation_response", "Node observation response did not match the requested servers");
    }
    for (const item of items) {
      const sections = expected.get(item.serverId);
      if (!sections || seen.has(item.serverId)) {
        throw structuredNodeProtocolError("invalid_observation_response", "Node observation response contained an unexpected or duplicate server");
      }
      seen.add(item.serverId);
      for (const section of observationSections) {
        const hasValue = this.sectionValue(item, section) !== undefined;
        const hasError = item.errors?.[section] !== undefined;
        if (hasValue && hasError) {
          throw structuredNodeProtocolError("invalid_observation_response", `Node observation returned both a value and an error for ${section}`);
        }
        if (!sections.has(section) && (hasValue || hasError)) {
          throw structuredNodeProtocolError("invalid_observation_response", `Node observation returned an unrequested ${section} section`);
        }
      }
    }
  }

  private sectionValue(item: ServerObservationResultItem, section: ServerObservationSection) {
    if (section === "status") return item.status;
    if (section === "stats") return item.stats;
    if (section === "players") return item.players;
    if (section === "logs") return item.logs;
    return item.overviewFiles;
  }

  private throwObservationFailure(serverId: string, section: ServerObservationSection): never {
    const failure = this.cache.get(serverId)?.failures?.[section]?.error;
    if (failure) throw structuredNodeProtocolError(failure.code, failure.message, failure.details, failure.retryable);
    throw structuredNodeProtocolError("observation_unavailable", `Remote ${section} observation is unavailable`);
  }
}
