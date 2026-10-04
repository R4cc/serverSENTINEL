import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadModrinthJarStream } from "./jarDownload.js";
import { modrinthFetch } from "./modrinthClient.js";
import { writeRuntimeUpload } from "../runtime/local/fileService.js";

vi.mock("./modrinthClient.js", () => ({ modrinthFetch: vi.fn() }));
const jar = Buffer.from("PK\u0003\u0004 pretend jar");
const file = { url: "https://cdn.modrinth.com/file.jar" };
const digest = (algorithm: string) => createHash(algorithm).update(jar).digest("hex");
const roots: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function read(hashes?: Record<string, string>) {
  const chunks: Buffer[] = [];
  for await (const chunk of await downloadModrinthJarStream({ ...file, hashes })) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function respond(bytes = jar) {
  vi.mocked(modrinthFetch).mockResolvedValue(new Response(new Uint8Array(bytes)));
}

describe("streamed Modrinth JAR downloads", () => {
  it("verifies both hashes across a header split into individual bytes", async () => {
    vi.mocked(modrinthFetch).mockResolvedValue(new Response(new ReadableStream({
      start(stream) { for (const byte of jar) stream.enqueue(Uint8Array.of(byte)); stream.close(); }
    })));
    await expect(read({ sha1: digest("sha1"), sha512: digest("sha512") })).resolves.toEqual(jar);
  });
  it.each<Record<string, string>>([{ sha1: "invalid" }, { sha512: "invalid" }, { sha1: digest("sha1"), sha512: "invalid" }])("rejects mismatched published hashes: %j", async (hashes) => {
    respond();
    await expect(read(hashes)).rejects.toThrow("hash did not match");
  });
  it("allows missing metadata hashes", async () => {
    respond();
    await expect(read()).resolves.toEqual(jar);
  });
  it.each([Buffer.alloc(0), Buffer.from("PK"), Buffer.from("not a jar")])("rejects an empty or invalid JAR: %j", async (bytes) => {
    respond(bytes);
    await expect(read()).rejects.toThrow("valid .jar");
  });
  it("refuses oversized advertised metadata before fetching", async () => {
    await expect(downloadModrinthJarStream({ ...file, size: 11 }, { maximumBytes: 10 })).rejects.toThrow("larger than");
    expect(modrinthFetch).not.toHaveBeenCalled();
  });
  it("cancels a body rejected by its content-length", async () => {
    const cancel = vi.fn();
    vi.mocked(modrinthFetch).mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { "content-length": "11" } }));
    await expect(downloadModrinthJarStream(file, { maximumBytes: 10 })).rejects.toThrow("larger than");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("stops an unbounded body at the byte ceiling and cancels its producer", async () => {
    const cancel = vi.fn();
    let chunks = 0;
    vi.mocked(modrinthFetch).mockResolvedValue(new Response(new ReadableStream({
      pull(stream) { chunks++; stream.enqueue(new Uint8Array(jar)); }, cancel
    })));
    const stream = await downloadModrinthJarStream(file, { maximumBytes: jar.length });
    await expect((async () => { for await (const _chunk of stream) { /* consume */ } })()).rejects.toThrow("larger than");
    expect(cancel).toHaveBeenCalledOnce();
    expect(chunks).toBeLessThanOrEqual(4);
  });
  it("cleans up a staged file after a late hash failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "serversentinel-jar-"));
    roots.push(root);
    respond();
    const stream = await downloadModrinthJarStream({ ...file, hashes: { sha512: "invalid" } });
    await expect(writeRuntimeUpload(join(root, "mod.jar"), { stream }, { maximumBytes: 100, allowEmpty: false, label: "Mod" })).rejects.toThrow("hash did not match");
    expect(await readdir(root)).toEqual([]);
  });
});
