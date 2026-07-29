import { randomUUID } from "node:crypto";
import { badRequest } from "../http/validation.js";
import { notFound } from "../http/errors.js";
import { createHash } from "node:crypto";
import { extname, join } from "node:path";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { fetch } from "undici";
import { config } from "../config.js";
import { appUserAgentFor } from "../buildInfo.js";
import { logWarn, errorLogFields } from "../logging.js";
import { serverLogFields } from "../runtime/local/dockerContainers.js";
import { assertModrinthUrl } from "../http/outboundUrls.js";
import { managedContentRuntime } from "../servers/versions.js";
import { cachedIconFilenames, findCachedIconFile } from "../iconFileCache.js";
import { ensureInsideServer, ensureWritableResolvedInsideServer, validateExistingInsideServer, validateExistingResolvedInsideServer } from "../core.js";
import { modrinthFetch } from "../modrinth/modrinthClient.js";
import { fetchProject } from "../modrinth/compatibility.js";
import type { InstalledModMetadata, ManagedServer } from "../types.js";

export const modrinthIconCacheMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
export const modrinthAssetTimeoutMs = 10_000;
export const modrinthIconRequests = new Map<string, Promise<{ bytes: Buffer; contentType: string }>>();
export const modrinthIconRefreshRequests = new Map<string, Promise<void>>();

export function modIconKey(filename: string) {
  return Buffer.from(filename.replace(/\.jar\.disabled$/, ".jar"), "utf8").toString("base64url");
}

export function isMissingPathError(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function modIconUrl(server: ManagedServer, filename: string) {
  const { directory } = managedContentRuntime(server);
  let iconsDir: string;
  try {
    iconsDir = await validateExistingInsideServer(server, `${directory}/.serversentinel-icons`);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return undefined;
  }
  const icon = await findCachedIconFile(iconsDir, modIconKey(filename));
  if (!icon) return undefined;
  await validateExistingResolvedInsideServer(server, icon.path);
  const version = Math.trunc(icon.mtimeMs).toString(36);
  return `/api/servers/${encodeURIComponent(server.id)}/mods/icon?filename=${encodeURIComponent(filename)}&v=${encodeURIComponent(version)}`;
}

export async function deleteModIcon(server: ManagedServer, filename: string) {
  const { directory } = managedContentRuntime(server);
  let iconsDir: string;
  try {
    iconsDir = await validateExistingInsideServer(server, `${directory}/.serversentinel-icons`);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return;
  }
  await Promise.all(cachedIconFilenames(modIconKey(filename)).map(async (entry) => {
    try {
      const iconPath = await validateExistingResolvedInsideServer(server, join(iconsDir, entry));
      await rm(iconPath, { force: true });
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }));
}

export function iconExtension(iconUrl: string, contentType: string | null) {
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("jpeg")) return ".jpg";
  if (contentType?.includes("png")) return ".png";
  const extension = extname(new URL(iconUrl).pathname).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension) ? extension : ".png";
}

export function iconContentType(filename: string) {
  const extension = extname(filename).toLowerCase();
  if (extension === ".webp") return "image/webp";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  return "image/png";
}

export async function persistModIcon(server: ManagedServer, filename: string, iconUrl?: string | null) {
  const { directory, plural } = managedContentRuntime(server);
  if (!iconUrl) return;
  let safeIconUrl: string;
  try {
    safeIconUrl = assertModrinthUrl(iconUrl);
  } catch {
    return;
  }
  const response = await fetch(safeIconUrl, {
    headers: { "User-Agent": appUserAgentFor(`${plural} manager`) },
    signal: AbortSignal.timeout(modrinthAssetTimeoutMs),
    redirect: "error"
  });
  if (!response.ok || !response.body) return;
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^image\/(png|jpeg|webp|gif)(?:;|$)/i.test(contentType)) return;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 1024 * 1024) return;
  await validateExistingInsideServer(server, directory);
  const iconsDir = ensureInsideServer(server, `${directory}/.serversentinel-icons`);
  await mkdir(iconsDir, { recursive: true });
  await validateExistingInsideServer(server, `${directory}/.serversentinel-icons`);
  await deleteModIcon(server, filename);
  const iconPath = await ensureWritableResolvedInsideServer(server, join(iconsDir, `${modIconKey(filename)}${iconExtension(safeIconUrl, response.headers.get("content-type"))}`));
  await writeFile(iconPath, bytes);
}

export async function saveModIcon(server: ManagedServer, filename: string, iconUrl?: string | null) {
  try {
    await persistModIcon(server, filename, iconUrl);
  } catch (error) {
    logWarn({ ...serverLogFields(server), filename, action: "save_mod_icon", ...errorLogFields(error) }, "Mod icon cache write failed; continuing without an icon");
  }
}

export function modrinthIconProxyUrl(iconUrl?: string | null) {
  if (!iconUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(iconUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.hostname !== "cdn.modrinth.com" && !parsed.hostname.endsWith(".modrinth.com")) return undefined;
  return `/api/modrinth/icon?url=${encodeURIComponent(parsed.toString())}`;
}

export function modrinthIconNotFound(): never {
  notFound("Icon not found");
}

export async function readCachedModrinthIcon(url: string, options: { allowStale?: boolean } = {}) {
  const cacheDir = join(config.dataDir, "modrinth-icon-cache");
  const key = createHash("sha256").update(url).digest("hex");
  const entry = await findCachedIconFile(cacheDir, key);
  if (!entry) return null;
  if (!options.allowStale && Date.now() - entry.mtimeMs > modrinthIconCacheMaxAgeMs) return null;
  return { bytes: await readFile(entry.path), contentType: iconContentType(entry.filename) };
}

/**
 * Each distinct proxied URL hashes to its own cache file and nothing ever removes them, so an
 * authenticated mods.view caller can grow the data directory indefinitely by varying the URL. Evict the
 * least recently modified entries once the cache is full; a re-fetch is cheap, unbounded disk is not.
 */
async function evictExcessCachedIcons(cacheDir: string) {
  let filenames: string[];
  try {
    filenames = await readdir(cacheDir);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  const cached = filenames.filter((name) => !name.endsWith(".tmp"));
  if (cached.length <= config.modrinthIconCacheMaxEntries) return;
  const stats = await Promise.all(cached.map(async (name) => {
    const path = join(cacheDir, name);
    try {
      return { path, mtimeMs: (await stat(path)).mtimeMs };
    } catch {
      return undefined;
    }
  }));
  const present = stats.filter((entry): entry is { path: string; mtimeMs: number } => entry !== undefined);
  present.sort((left, right) => left.mtimeMs - right.mtimeMs);
  const excess = present.slice(0, Math.max(0, present.length - config.modrinthIconCacheMaxEntries));
  await Promise.all(excess.map((entry) => rm(entry.path, { force: true })));
}

export async function writeCachedModrinthIcon(url: string, bytes: Buffer, iconUrl: string, contentType: string) {
  const cacheDir = join(config.dataDir, "modrinth-icon-cache");
  await mkdir(cacheDir, { recursive: true });
  const key = createHash("sha256").update(url).digest("hex");
  const extension = iconExtension(iconUrl, contentType);
  await Promise.all(cachedIconFilenames(key).map((entry) => rm(join(cacheDir, entry), { force: true })));
  const destination = join(cacheDir, `${key}${extension}`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
  await evictExcessCachedIcons(cacheDir);
}

export async function loadModrinthIcon(normalizedUrl: string) {
  const cached = await readCachedModrinthIcon(normalizedUrl);
  if (cached) return cached;

  const stale = await readCachedModrinthIcon(normalizedUrl, { allowStale: true });
  if (stale) {
    if (!modrinthIconRefreshRequests.has(normalizedUrl)) {
      const refresh = downloadModrinthIcon(normalizedUrl)
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => modrinthIconRefreshRequests.delete(normalizedUrl));
      modrinthIconRefreshRequests.set(normalizedUrl, refresh);
    }
    return stale;
  }

  return downloadModrinthIcon(normalizedUrl);
}

export async function downloadModrinthIcon(normalizedUrl: string) {

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(normalizedUrl, {
      headers: { "User-Agent": appUserAgentFor("managed content catalog") },
      signal: AbortSignal.timeout(modrinthAssetTimeoutMs),
      redirect: "error"
    });
  } catch {
    const stale = await readCachedModrinthIcon(normalizedUrl, { allowStale: true });
    if (stale) return stale;
    modrinthIconNotFound();
  }
  if (!response.ok || !response.body) {
    const stale = await readCachedModrinthIcon(normalizedUrl, { allowStale: true });
    if (stale) return stale;
    modrinthIconNotFound();
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^image\/(png|jpeg|webp|gif)(?:;|$)/i.test(contentType)) modrinthIconNotFound();
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 1024 * 1024) badRequest("Icon is larger than the 1 MiB limit");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 1024 * 1024) badRequest("Icon is larger than the 1 MiB limit");
  const safeContentType = contentType.includes("webp")
    ? "image/webp"
    : contentType.includes("jpeg")
      ? "image/jpeg"
      : contentType.includes("gif")
        ? "image/gif"
        : "image/png";
  await writeCachedModrinthIcon(normalizedUrl, bytes, normalizedUrl, safeContentType);
  return { bytes, contentType: safeContentType };
}

export async function fetchModrinthIcon(iconUrl: unknown) {
  const url = typeof iconUrl === "string" ? iconUrl : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    badRequest("A valid Modrinth icon URL is required");
  }
  if (parsed.protocol !== "https:" || (parsed.hostname !== "cdn.modrinth.com" && !parsed.hostname.endsWith(".modrinth.com"))) {
    badRequest("Only Modrinth icon URLs can be proxied");
  }
  const normalizedUrl = parsed.toString();
  const pending = modrinthIconRequests.get(normalizedUrl);
  if (pending) return pending;
  const request = loadModrinthIcon(normalizedUrl).finally(() => modrinthIconRequests.delete(normalizedUrl));
  modrinthIconRequests.set(normalizedUrl, request);
  return request;
}

export async function ensureModrinthIconForFile(server: ManagedServer, filename: string, filePath: string, metadata?: InstalledModMetadata) {
  if (await modIconUrl(server, filename)) return;
  try {
    if (metadata?.projectId) {
      const project = await fetchProject(metadata.projectId);
      await saveModIcon(server, filename, project.icon_url);
      return;
    }
    const safeFilePath = await validateExistingResolvedInsideServer(server, filePath);
    const hash = createHash("sha1").update(await readFile(safeFilePath)).digest("hex");
    const versionResponse = await modrinthFetch(`https://api.modrinth.com/v2/version_file/${hash}?algorithm=sha1`);
    const version = await versionResponse.json() as { project_id?: string };
    if (!version.project_id) return;
    const project = await fetchProject(version.project_id);
    await saveModIcon(server, filename, project.icon_url);
  } catch {
    // Non-Modrinth/manual mods simply keep the generic JAR icon.
  }
}

