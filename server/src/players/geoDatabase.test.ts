import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeoDatabase, geoDatabaseFilename } from "./geoDatabase.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "serversentinel-geo-"));
  temporaryDirectories.push(directory);
  return directory;
}

const blockSize = 512;

function tarHeader(name: string, size: number) {
  const header = Buffer.alloc(blockSize);
  header.write(name, 0, 100, "utf8");
  header.write("000644 \0", 100, 8, "utf8");
  header.write(`${size.toString(8).padStart(11, "0")} `, 124, 12, "utf8");
  header.write("0", 156, 1, "utf8");
  header.write("        ", 148, 8, "utf8");
  return header;
}

/** A stand-in for MaxMind's archive: a licence file, then the database, then trailing padding. */
function geoArchive(databaseBytes: Buffer) {
  const licence = Buffer.from("GeoLite2 licence", "utf8");
  const pad = (length: number) => Buffer.alloc(length % blockSize === 0 ? 0 : blockSize - (length % blockSize));
  return gzipSync(Buffer.concat([
    tarHeader("GeoLite2-City_20260810/LICENSE.txt", licence.length),
    licence,
    pad(licence.length),
    tarHeader(`GeoLite2-City_20260810/${geoDatabaseFilename}`, databaseBytes.length),
    databaseBytes,
    pad(databaseBytes.length),
    Buffer.alloc(blockSize * 2)
  ]));
}

const cityDatabase = { city: () => ({}) };

/** Stands in for a readable GeoLite2 City database, so the verify-then-install path can be driven. */
function opensAs(kind: "city" | "country" | "unreadable") {
  return async () => kind === "unreadable"
    ? undefined
    : {
      reader: cityDatabase,
      metadata: {
        databaseType: kind === "city" ? "GeoLite2-City" : "GeoLite2-Country",
        buildEpoch: new Date("2026-08-10T00:00:00.000Z")
      }
    };
}

function archiveResponse(body: Buffer) {
  return new Response(Readable.toWeb(Readable.from([body])) as ReadableStream<Uint8Array>, { status: 200 });
}

describe("the local GeoLite2 database", () => {
  it("makes no request at all without credentials, and says why it has nothing", async () => {
    const fetchImpl = vi.fn();
    const database = new GeoDatabase({ directory: await temporaryDirectory(), credentials: () => undefined, fetch: fetchImpl as unknown as typeof fetch });

    expect(await database.refresh()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(database.state()).toMatchObject({ available: false, configured: false, updating: false });
    expect(database.state().error).toContain("No MaxMind credentials");
    expect(database.cityReader).toBeUndefined();
  });

  it("downloads with basic auth and installs the verified database where lookups will find it", async () => {
    const directory = await temporaryDirectory();
    const fetchImpl = vi.fn(async () => archiveResponse(geoArchive(Buffer.from("the database member"))));
    const database = new GeoDatabase({
      directory,
      credentials: () => ({ accountId: "123456", licenseKey: "secret-key" }),
      fetch: fetchImpl as unknown as typeof fetch,
      openDatabase: opensAs("city")
    });

    expect(await database.refresh()).toBe(true);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("download.maxmind.com");
    expect(url).toContain("GeoLite2-City");
    const authorization = (init.headers as Record<string, string>).authorization;
    expect(Buffer.from(authorization.replace("Basic ", ""), "base64").toString()).toBe("123456:secret-key");

    expect(await readFile(join(directory, geoDatabaseFilename), "utf8")).toBe("the database member");
    expect(database.state()).toMatchObject({ available: true, configured: true, buildDate: "2026-08-10T00:00:00.000Z" });
    expect(database.cityReader).toBeDefined();
    expect((await readdir(directory)).filter((name) => name.endsWith(".download"))).toEqual([]);
  });

  it("refuses a download that opens as the wrong edition", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, geoDatabaseFilename), "the good database");
    const database = new GeoDatabase({
      directory,
      credentials: () => ({ accountId: "1", licenseKey: "k" }),
      fetch: (async () => archiveResponse(geoArchive(Buffer.from("a country database")))) as unknown as typeof fetch,
      openDatabase: opensAs("country")
    });

    expect(await database.refresh({ force: true })).toBe(false);
    expect(database.state().error).toContain("not GeoLite2-City");
    expect(await readFile(join(directory, geoDatabaseFilename), "utf8")).toBe("the good database");
  });

  it("names the credentials when MaxMind rejects them, and leaves the previous database in place", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, geoDatabaseFilename), "the database from last week");
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 }));
    const database = new GeoDatabase({
      directory,
      credentials: () => ({ accountId: "123456", licenseKey: "wrong" }),
      fetch: fetchImpl as unknown as typeof fetch
    });

    expect(await database.refresh({ force: true })).toBe(false);
    expect(database.state().error).toContain("rejected the account ID");
    expect(await readFile(join(directory, geoDatabaseFilename), "utf8")).toBe("the database from last week");
  });

  it("reports an archive with no database in it rather than replacing the file with rubbish", async () => {
    const directory = await temporaryDirectory();
    const licenceOnly = gzipSync(Buffer.concat([
      tarHeader("GeoLite2-City_20260810/LICENSE.txt", 6),
      Buffer.from("licence".slice(0, 6)),
      Buffer.alloc(blockSize - 6),
      Buffer.alloc(blockSize * 2)
    ]));
    const database = new GeoDatabase({
      directory,
      credentials: () => ({ accountId: "1", licenseKey: "k" }),
      fetch: (async () => archiveResponse(licenceOnly)) as unknown as typeof fetch
    });

    await database.refresh({ force: true });
    expect(database.state().error).toContain("did not contain a database file");
    expect(existsSync(join(directory, geoDatabaseFilename))).toBe(false);
  });

  it("downloads when nothing is loaded, however recent the file on disk is", async () => {
    const directory = await temporaryDirectory();
    // Present, but not a database anything can read — which is exactly the state a half-finished
    // first run leaves behind, and the one case where waiting for the file to age would strand the
    // installation without geography for three days.
    await writeFile(join(directory, geoDatabaseFilename), "recent but unreadable");
    const fetchImpl = vi.fn(async () => archiveResponse(geoArchive(Buffer.from("replacement"))));
    const database = new GeoDatabase({
      directory,
      credentials: () => ({ accountId: "1", licenseKey: "k" }),
      fetch: fetchImpl as unknown as typeof fetch,
      openDatabase: opensAs("city")
    });

    expect(await database.refresh()).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readFile(join(directory, geoDatabaseFilename), "utf8")).toBe("replacement");
  });

  it("installs nothing once the module has switched it off", async () => {
    const directory = await temporaryDirectory();
    const fetchImpl = vi.fn(async () => archiveResponse(geoArchive(Buffer.from("payload"))));
    const database = new GeoDatabase({
      directory,
      credentials: () => ({ accountId: "1", licenseKey: "k" }),
      fetch: fetchImpl as unknown as typeof fetch
    });

    database.stop();
    expect(await database.refresh({ force: true })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(join(directory, geoDatabaseFilename))).toBe(false);
  });
});

describe("a download that outlives the switch that started it", () => {
  /** A fetch that hands back its response only when the test says so. */
  function heldFetch(body: Buffer) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = { value: false };
    let aborted = false;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      started.value = true;
      init.signal?.addEventListener("abort", () => { aborted = true; });
      await held;
      if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return archiveResponse(body);
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, release, started, get aborted() { return aborted; } };
  }

  it("aborts the transfer and installs nothing when the module is disabled mid-download", async () => {
    const directory = await temporaryDirectory();
    const held = heldFetch(geoArchive(Buffer.from("a database that arrived too late")));
    const database = new GeoDatabase({
      directory,
      credentials: () => ({ accountId: "1", licenseKey: "k" }),
      fetch: held.fetchImpl
    });

    const refresh = database.refresh({ force: true });
    await vi.waitFor(() => expect(held.started.value).toBe(true));

    database.stop();
    expect(held.aborted).toBe(true);
    held.release();
    expect(await refresh).toBe(false);

    // Nothing installed, nothing loaded, and no temporary file left lying about.
    expect(existsSync(join(directory, geoDatabaseFilename))).toBe(false);
    expect(database.cityReader).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it("leaves the database a restarted module loaded alone when the orphan finally lands", async () => {
    const directory = await temporaryDirectory();
    const held = heldFetch(geoArchive(Buffer.from("the orphan's payload")));
    const database = new GeoDatabase({
      directory,
      credentials: () => ({ accountId: "1", licenseKey: "k" }),
      fetch: held.fetchImpl
    });

    const orphan = database.refresh({ force: true });
    await vi.waitFor(() => expect(held.started.value).toBe(true));
    database.stop();

    // The module comes back while the previous download is still unwinding.
    await writeFile(join(directory, geoDatabaseFilename), "installed by the new lifecycle");
    await database.start();

    held.release();
    expect(await orphan).toBe(false);
    expect(await readFile(join(directory, geoDatabaseFilename), "utf8")).toBe("installed by the new lifecycle");
    database.stop();
  });

  it("does not hand a new lifecycle the refresh promise of the one it replaced", async () => {
    const directory = await temporaryDirectory();
    const held = heldFetch(geoArchive(Buffer.from("payload")));
    const database = new GeoDatabase({
      directory,
      credentials: () => ({ accountId: "1", licenseKey: "k" }),
      fetch: held.fetchImpl
    });

    const orphan = database.refresh({ force: true });
    await vi.waitFor(() => expect(held.started.value).toBe(true));
    database.stop();
    database.start();

    const fresh = database.refresh({ force: true });
    expect(fresh).not.toBe(orphan);
    held.release();
    await Promise.allSettled([orphan, fresh]);
    database.stop();
  });

  it("survives being switched on and off repeatedly", async () => {
    const directory = await temporaryDirectory();
    const fetchImpl = vi.fn(async () => archiveResponse(geoArchive(Buffer.from("payload"))));
    const database = new GeoDatabase({
      directory,
      credentials: () => ({ accountId: "1", licenseKey: "k" }),
      fetch: fetchImpl as unknown as typeof fetch
    });

    for (let cycle = 0; cycle < 5; cycle += 1) {
      await database.start();
      database.stop();
    }

    expect(database.cityReader).toBeUndefined();
    expect(database.state()).toMatchObject({ available: false });
    // Every attempt cleans up after itself, however many were cut short — including the one still
    // unwinding from the last stop.
    await vi.waitFor(async () => expect((await readdir(directory)).filter((name) => name.endsWith(".download"))).toEqual([]));
  });
});

describe("replacing a database that is already working", () => {
  it("keeps the database in use when the replacement cannot be opened", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, geoDatabaseFilename), "the good database");
    const database = new GeoDatabase({
      directory,
      credentials: () => ({ accountId: "1", licenseKey: "k" }),
      fetch: (async () => archiveResponse(geoArchive(Buffer.from("truncated rubbish")))) as unknown as typeof fetch
    });
    // Stand in for a loaded database, which a real MMDB would have given us.
    const loaded = { city: () => ({}) };
    Object.assign(database as unknown as { reader: unknown }, { reader: loaded });

    expect(await database.refresh({ force: true })).toBe(false);

    // The file on disk and the reader in memory are both the ones that were working.
    expect(await readFile(join(directory, geoDatabaseFilename), "utf8")).toBe("the good database");
    expect(database.cityReader).toBe(loaded);
    expect(database.state()).toMatchObject({ available: true });
    expect(database.state().error).toContain("could not be opened as a database");
    expect((await readdir(directory)).filter((name) => name.endsWith(".download"))).toEqual([]);
  });

  it("keeps the database in use when the transfer fails part way through", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, geoDatabaseFilename), "the good database");
    const truncated = geoArchive(Buffer.from("x".repeat(4_000))).subarray(0, 200);
    const database = new GeoDatabase({
      directory,
      credentials: () => ({ accountId: "1", licenseKey: "k" }),
      fetch: (async () => archiveResponse(truncated)) as unknown as typeof fetch
    });

    expect(await database.refresh({ force: true })).toBe(false);
    expect(await readFile(join(directory, geoDatabaseFilename), "utf8")).toBe("the good database");
    expect(database.state().error).toBeTruthy();
    expect((await readdir(directory)).filter((name) => name.endsWith(".download"))).toEqual([]);
  });
});

describe("concurrency", () => {
  it("serializes overlapping refreshes so the daily timer and an operator cannot download twice", async () => {
    const directory = await temporaryDirectory();
    let inFlight = 0;
    let overlapped = false;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return archiveResponse(geoArchive(Buffer.from("payload")));
    });
    const database = new GeoDatabase({
      directory,
      credentials: () => ({ accountId: "1", licenseKey: "k" }),
      fetch: fetchImpl as unknown as typeof fetch
    });

    await Promise.all([database.refresh({ force: true }), database.refresh({ force: true }), database.refresh({ force: true })]);
    expect(overlapped).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
