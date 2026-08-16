import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Reader } from "@maxmind/geoip2-node";
import type { PlayerGeoDatabaseState } from "@serversentinel/contracts";
import type { GeoCityReader } from "./geoLocation.js";
import { extractFirstTarMember } from "./tarEntries.js";

/**
 * The local GeoLite2 City database: where it lives, how it is refreshed, and who may read it.
 *
 * Two rules shape this file. Nothing about a player ever leaves the host — lookups run against the
 * MMDB in memory, and the only outbound request here is for the database itself. And the image
 * ships no database at all, because a GeoLite2 copy baked into a container image is stale the week
 * after it is built and its licence expects installations to keep it current. An installation with
 * no MaxMind credentials simply has no geography, which the module reports rather than guesses at.
 */

export const geoLite2Edition = "GeoLite2-City";
export const geoDatabaseFilename = `${geoLite2Edition}.mmdb`;
/** MaxMind publishes twice a week; checking daily is courteous and still never more than a day behind. */
export const geoDatabaseRefreshIntervalMs = 24 * 60 * 60 * 1000;
/** Below this age the file on disk is considered current and no request is made at all. */
export const geoDatabaseFreshMs = 3 * 24 * 60 * 60 * 1000;
const downloadTimeoutMs = 10 * 60 * 1000;
/** GeoLite2-City is around 60 MB expanded; anything far past that is not the archive we asked for. */
const maxDatabaseBytes = 512 * 1024 * 1024;

export type GeoDatabaseCredentials = {
  accountId: string;
  licenseKey: string;
};

type GeoDatabaseOptions = {
  directory: string;
  credentials(): GeoDatabaseCredentials | undefined;
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
  now?: () => number;
  onInfo?(fields: Record<string, unknown>, message: string): void;
  onWarn?(fields: Record<string, unknown>, message: string): void;
};

type ReaderMetadata = {
  buildEpoch?: Date | number;
  databaseType?: string;
  nodeCount?: number;
};

/**
 * The database's own build date, which is what tells an operator whether their copy is current.
 *
 * `ReaderModel` wraps the MMDB reader and does not re-expose its metadata, so this reads it off the
 * wrapped reader and falls back to reporting nothing at all if a later release stops carrying it
 * there. An unknown build date costs one line in the UI; guessing one would be worse.
 */
function metadataOf(reader: unknown): ReaderMetadata {
  const wrapped = (reader as { mmdbReader?: { metadata?: ReaderMetadata } }).mmdbReader;
  return wrapped?.metadata ?? (reader as { metadata?: ReaderMetadata }).metadata ?? {};
}

function buildDate(metadata: ReaderMetadata) {
  const epoch = metadata.buildEpoch;
  if (epoch === undefined) return undefined;
  const date = epoch instanceof Date ? epoch : new Date(epoch * 1000);
  return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date.toISOString() : undefined;
}

export class GeoDatabase {
  private reader: GeoCityReader | undefined;
  private metadata: ReaderMetadata = {};
  private downloadedAt: string | undefined;
  private lastCheckedAt: string | undefined;
  private lastError: string | undefined;
  private refreshing: Promise<boolean> | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** Set by `stop`, and checked before a refresh writes: a download in flight when the module is
   * switched off must not install its result into a panel that no longer wants it. */
  private stopped = false;

  constructor(private readonly options: GeoDatabaseOptions) {}

  get path() {
    return join(this.options.directory, geoDatabaseFilename);
  }

  /** The reader, or undefined while no database is loaded. Lookups treat that as "unknown". */
  get cityReader() {
    return this.reader;
  }

  configured() {
    return Boolean(this.options.credentials());
  }

  state(): PlayerGeoDatabaseState {
    return {
      available: Boolean(this.reader),
      configured: this.configured(),
      ...(buildDate(this.metadata) ? { buildDate: buildDate(this.metadata) } : {}),
      ...(this.metadata.databaseType ? { databaseType: this.metadata.databaseType } : {}),
      ...(typeof this.metadata.nodeCount === "number" ? { nodeCount: this.metadata.nodeCount } : {}),
      ...(this.downloadedAt ? { downloadedAt: this.downloadedAt } : {}),
      ...(this.lastCheckedAt ? { lastCheckedAt: this.lastCheckedAt } : {}),
      updating: Boolean(this.refreshing),
      ...(this.lastError ? { error: this.lastError } : {})
    };
  }

  /**
   * Loads whatever is already on disk and starts the refresh poll.
   *
   * Loading and refreshing are deliberately independent: a panel that starts without a network, or
   * without credentials, still answers from the database it downloaded last week.
   */
  async start() {
    this.stopped = false;
    await this.load();
    void this.refresh().catch(() => undefined);
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), geoDatabaseRefreshIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.reader = undefined;
    this.metadata = {};
  }

  /** Opens the database currently on disk, if any. Safe to call repeatedly. */
  async load() {
    try {
      const reader = await Reader.open(this.path);
      this.reader = reader as unknown as GeoCityReader;
      this.metadata = metadataOf(reader);
      const stats = await stat(this.path).catch(() => undefined);
      if (stats) this.downloadedAt = new Date(stats.mtimeMs).toISOString();
      this.lastError = undefined;
      return true;
    } catch {
      this.reader = undefined;
      this.metadata = {};
      return false;
    }
  }

  /**
   * Downloads a fresh database when one is due. Serialized, so the daily timer and an operator's
   * manual request cannot download twice at once.
   */
  refresh(options: { force?: boolean } = {}) {
    if (this.refreshing) return this.refreshing;
    const attempt = this.refreshOnce(options.force === true).finally(() => { this.refreshing = undefined; });
    this.refreshing = attempt;
    return attempt;
  }

  private async refreshOnce(force: boolean) {
    if (this.stopped) return false;
    const credentials = this.options.credentials();
    if (!credentials) {
      this.lastError = this.reader
        ? undefined
        : "No MaxMind credentials are configured, so no GeoLite2 database can be downloaded.";
      return false;
    }
    if (!force && this.reader && !(await this.stale())) return false;
    this.lastCheckedAt = new Date(this.now()).toISOString();
    try {
      const bytes = await this.download(credentials);
      this.options.onInfo?.({ action: "update_geo_database", edition: geoLite2Edition, bytes, category: "player_insights" }, "Downloaded a fresh GeoLite2 database");
      await this.load();
      this.downloadedAt = new Date(this.now()).toISOString();
      this.lastError = undefined;
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A failed refresh must never take a working database away: the old file is still on disk and
      // still loaded, so the module keeps answering from it while the reason is surfaced.
      this.lastError = message;
      this.options.onWarn?.({ action: "update_geo_database", edition: geoLite2Edition, errorDetails: message, category: "player_insights" }, "GeoLite2 database refresh failed; the existing database is still in use");
      return false;
    }
  }

  private async stale() {
    const stats = await stat(this.path).catch(() => undefined);
    if (!stats) return true;
    return this.now() - stats.mtimeMs > geoDatabaseFreshMs;
  }

  private async download(credentials: GeoDatabaseCredentials) {
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const url = `https://download.maxmind.com/geoip/databases/${geoLite2Edition}/download?suffix=tar.gz`;
    const authorization = Buffer.from(`${credentials.accountId}:${credentials.licenseKey}`).toString("base64");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), downloadTimeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchImpl(url, {
        headers: {
          authorization: `Basic ${authorization}`,
          "user-agent": this.options.userAgent ?? "serverSENTINEL",
          accept: "application/gzip"
        },
        redirect: "follow",
        signal: controller.signal
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("MaxMind rejected the account ID and license key for the GeoLite2 download.");
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`MaxMind returned HTTP ${response.status} for the GeoLite2 download.`);
      }
      await mkdir(this.options.directory, { recursive: true });
      const temporaryPath = `${this.path}.download`;
      await rm(temporaryPath, { force: true });
      let written = 0;
      const gunzip = createGunzip();
      const archive = pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), gunzip);
      const extraction = extractFirstTarMember(
        gunzip,
        (name) => name.toLowerCase().endsWith(".mmdb"),
        () => {
          const target = createWriteStream(temporaryPath);
          return {
            async write(chunk) {
              written += chunk.length;
              if (written > maxDatabaseBytes) throw new Error("The GeoLite2 download is larger than this panel accepts.");
              if (!target.write(chunk)) await new Promise<void>((resolve) => { target.once("drain", () => resolve()); });
            },
            finish() {
              return new Promise<void>((resolve, reject) => target.end((error?: Error) => error ? reject(error) : resolve()));
            }
          };
        }
      );
      const [member] = await Promise.all([extraction, archive.catch(() => undefined)]);
      if (!member) {
        await rm(temporaryPath, { force: true });
        throw new Error("The GeoLite2 archive did not contain a database file.");
      }
      // Renaming last is what makes an interrupted download harmless: the panel either has the old
      // database or the new one, never half of either.
      await mkdir(dirname(this.path), { recursive: true });
      await rename(temporaryPath, this.path);
      return written;
    } finally {
      clearTimeout(timeout);
    }
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }
}
