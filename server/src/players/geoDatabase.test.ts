import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("downloads with basic auth and puts the database member where lookups will find it", async () => {
    const directory = await temporaryDirectory();
    const fetchImpl = vi.fn(async () => archiveResponse(geoArchive(Buffer.from("not a real mmdb, but the right member"))));
    const database = new GeoDatabase({
      directory,
      credentials: () => ({ accountId: "123456", licenseKey: "secret-key" }),
      fetch: fetchImpl as unknown as typeof fetch
    });

    await database.refresh();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("download.maxmind.com");
    expect(url).toContain("GeoLite2-City");
    const authorization = (init.headers as Record<string, string>).authorization;
    expect(Buffer.from(authorization.replace("Basic ", ""), "base64").toString()).toBe("123456:secret-key");

    expect(await readFile(join(directory, geoDatabaseFilename), "utf8")).toBe("not a real mmdb, but the right member");
    // The bytes are not a database, so no reader opens — reported rather than pretended away.
    expect(database.state()).toMatchObject({ available: false, configured: true });
    // Nothing half-written is left behind either way.
    expect(existsSync(join(directory, `${geoDatabaseFilename}.download`))).toBe(false);
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
      fetch: fetchImpl as unknown as typeof fetch
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
