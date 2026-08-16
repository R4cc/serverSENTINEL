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
 * Three rules shape this file.
 *
 * No player address is ever sent anywhere to be looked up. Every lookup is a read of the MMDB this
 * class holds, and the only outbound request it makes is for the database itself — MaxMind is asked
 * for a file, never about a player.
 *
 * The image ships no database, because a GeoLite2 copy baked into a container image is stale the
 * week after it is built and its licence expects installations to keep theirs current. An
 * installation with no MaxMind credentials simply has no geography, which the module reports
 * rather than guesses at.
 *
 * And a database that is working keeps working. A refresh is only allowed to replace it once the
 * downloaded file has been opened and found to be a usable City database, so a truncated, corrupt,
 * or unexpected download costs an installation an error message rather than its geography.
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

type ReaderMetadata = {
  buildEpoch?: Date | number;
  databaseType?: string;
  nodeCount?: number;
};

export type OpenedGeoDatabase = {
  reader: GeoCityReader;
  metadata: ReaderMetadata;
};

type GeoDatabaseOptions = {
  directory: string;
  credentials(): GeoDatabaseCredentials | undefined;
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
  now?: () => number;
  /**
   * Opens an MMDB file, or reports that it is not one. Injectable for the same reason `fetch` is:
   * the install-and-verify path is the part that must not lose a working database, and exercising
   * it should not require a 60 MB fixture in the repository.
   */
  openDatabase?(path: string): Promise<OpenedGeoDatabase | undefined>;
  onInfo?(fields: Record<string, unknown>, message: string): void;
  onWarn?(fields: Record<string, unknown>, message: string): void;
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
  private refreshingGeneration = -1;
  private timer: NodeJS.Timeout | undefined;
  /**
   * Which lifecycle the work in flight belongs to. `stop` bumps it, so everything started before
   * that point is orphaned: it may still be unwinding, but nothing it produces may be adopted.
   * Switching a module off has to actually stop it, and a download that outlives the switch and
   * then installs itself would be the module quietly coming back to life.
   */
  private generation = 0;
  /** A freshly built instance has not been stopped; only `stop` sets this, and only `start` clears it. */
  private stopped = false;
  /** The fetch in flight, so `stop` can cut it off rather than wait out a 60 MB download. */
  private downloadController: AbortController | undefined;
  /** Distinct per attempt, so an orphaned download cannot write into or delete a live one's file. */
  private temporaryFileCounter = 0;

  constructor(private readonly options: GeoDatabaseOptions) {}

  /** Whether the lifecycle that started this work has since been stopped or replaced. */
  private abandoned(generation: number) {
    return this.stopped || this.generation !== generation;
  }

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
    if (this.timer) return;
    this.stopped = false;
    const generation = this.generation;
    await this.load(generation);
    if (this.abandoned(generation)) return;
    void this.refresh().catch(() => undefined);
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), geoDatabaseRefreshIntervalMs);
    this.timer.unref?.();
  }

  /**
   * Stops everything this class is doing, immediately.
   *
   * The generation bump is what makes that true of work already in flight: a download started
   * before this call may still be unwinding, but it can no longer install a database, adopt a
   * reader, or write any state. The abort is the courtesy that stops it wasting a download.
   */
  stop() {
    this.stopped = true;
    this.generation += 1;
    this.downloadController?.abort();
    this.downloadController = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.reader = undefined;
    this.metadata = {};
  }

  /** Opens the database currently on disk, if any. Safe to call repeatedly. */
  async load(generation = this.generation) {
    const opened = await this.open(this.path);
    if (this.abandoned(generation)) return false;
    if (!opened) {
      this.reader = undefined;
      this.metadata = {};
      return false;
    }
    this.reader = opened.reader;
    this.metadata = opened.metadata;
    const stats = await stat(this.path).catch(() => undefined);
    if (this.abandoned(generation)) return false;
    if (stats) this.downloadedAt = new Date(stats.mtimeMs).toISOString();
    this.lastError = undefined;
    return true;
  }

  /**
   * Downloads a fresh database when one is due. Serialized within a lifecycle, so the daily timer
   * and an operator's manual request cannot download twice at once — but a refresh orphaned by
   * `stop` never stands in for one the current lifecycle asked for.
   */
  refresh(options: { force?: boolean } = {}) {
    if (this.refreshing && this.refreshingGeneration === this.generation) return this.refreshing;
    const generation = this.generation;
    const attempt = this.refreshOnce(options.force === true, generation).finally(() => {
      if (this.refreshingGeneration === generation) {
        this.refreshing = undefined;
        this.refreshingGeneration = -1;
      }
    });
    this.refreshing = attempt;
    this.refreshingGeneration = generation;
    return attempt;
  }

  private async refreshOnce(force: boolean, generation: number) {
    if (this.abandoned(generation)) return false;
    const credentials = this.options.credentials();
    if (!credentials) {
      this.lastError = this.reader
        ? undefined
        : "No MaxMind credentials are configured, so no GeoLite2 database can be downloaded.";
      return false;
    }
    if (!force && this.reader && !(await this.stale())) return false;
    if (this.abandoned(generation)) return false;
    this.lastCheckedAt = new Date(this.now()).toISOString();
    this.temporaryFileCounter += 1;
    const temporaryPath = `${this.path}.${this.temporaryFileCounter}.download`;
    let installed = false;
    try {
      const bytes = await this.download(credentials, temporaryPath);
      if (this.abandoned(generation)) return false;

      // Verified before it is allowed anywhere near the database in use. A download that is
      // truncated, corrupt, or simply not a City database has to cost the installation an error
      // message, not the geography it already had.
      const candidate = await this.open(temporaryPath);
      if (!candidate) throw new Error("The downloaded GeoLite2 file could not be opened as a database.");
      if (candidate.metadata.databaseType && !/city/i.test(candidate.metadata.databaseType)) {
        throw new Error(`The download is a ${candidate.metadata.databaseType} database, not ${geoLite2Edition}.`);
      }
      if (this.abandoned(generation)) return false;

      await rename(temporaryPath, this.path);
      installed = true;
      // Checked once more: `stop` may have landed while the rename was in flight, and adopting the
      // reader then would leave a switched-off module holding an open database.
      if (this.abandoned(generation)) return false;
      this.reader = candidate.reader;
      this.metadata = candidate.metadata;
      this.downloadedAt = new Date(this.now()).toISOString();
      this.lastError = undefined;
      this.options.onInfo?.({ action: "update_geo_database", edition: geoLite2Edition, bytes, buildDate: buildDate(candidate.metadata), category: "player_insights" }, "Installed a fresh GeoLite2 database");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.abandoned(generation)) return false;
      // A failed refresh must never take a working database away: the old file is still on disk and
      // still loaded, so the module keeps answering from it while the reason is surfaced.
      this.lastError = message;
      this.options.onWarn?.({ action: "update_geo_database", edition: geoLite2Edition, errorDetails: message, category: "player_insights" }, "GeoLite2 database refresh failed; the existing database is still in use");
      return false;
    } finally {
      // Covers every way out that did not install: an abort, a throw, and an abandoned lifecycle.
      if (!installed) await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  /** Opens an MMDB file, or reports that it is not one. Never touches this instance's state. */
  private async open(path: string): Promise<OpenedGeoDatabase | undefined> {
    if (this.options.openDatabase) return this.options.openDatabase(path).catch(() => undefined);
    try {
      const reader = await Reader.open(path);
      return { reader: reader as unknown as GeoCityReader, metadata: metadataOf(reader) };
    } catch {
      return undefined;
    }
  }

  private async stale() {
    const stats = await stat(this.path).catch(() => undefined);
    if (!stats) return true;
    return this.now() - stats.mtimeMs > geoDatabaseFreshMs;
  }

  private async download(credentials: GeoDatabaseCredentials, temporaryPath: string) {
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const url = `https://download.maxmind.com/geoip/databases/${geoLite2Edition}/download?suffix=tar.gz`;
    const authorization = Buffer.from(`${credentials.accountId}:${credentials.licenseKey}`).toString("base64");
    const controller = new AbortController();
    // Published on the instance so `stop` can abort it. A switched-off module should not hold a
    // 60 MB transfer open for however long it has left to run.
    this.downloadController = controller;
    const timeout = setTimeout(() => controller.abort(), downloadTimeoutMs);
    timeout.unref?.();
    let target: ReturnType<typeof createWriteStream> | undefined;
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
      await mkdir(dirname(this.path), { recursive: true });
      let written = 0;
      const gunzip = createGunzip();
      const archive = pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), gunzip);
      const extraction = extractFirstTarMember(
        gunzip,
        (name) => name.toLowerCase().endsWith(".mmdb"),
        () => {
          target = createWriteStream(temporaryPath);
          const sink = target;
          return {
            async write(chunk) {
              written += chunk.length;
              if (written > maxDatabaseBytes) throw new Error("The GeoLite2 download is larger than this panel accepts.");
              if (!sink.write(chunk)) await new Promise<void>((resolve) => { sink.once("drain", () => resolve()); });
            },
            finish() {
              return new Promise<void>((resolve, reject) => sink.end((error?: Error) => error ? reject(error) : resolve()));
            }
          };
        }
      );
      const [member] = await Promise.all([extraction, archive.catch(() => undefined)]);
      if (!member) throw new Error("The GeoLite2 archive did not contain a database file.");
      // The caller verifies this file and only then moves it into place, so an interrupted or
      // unusable download leaves the database already in use untouched.
      return written;
    } finally {
      clearTimeout(timeout);
      if (this.downloadController === controller) this.downloadController = undefined;
      // An aborted transfer leaves the sink open, and on Windows an open handle blocks the cleanup
      // that removes the partial file.
      if (target && !target.closed) target.destroy();
    }
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }
}
