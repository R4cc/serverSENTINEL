import { EXPORT_CATEGORIES, serverRuntimeDefinition, type ExportCategory, type ExportContentStrategy, type ExportSelection } from "@serversentinel/contracts";
import { config } from "../config.js";
import { missingParentMessage, missingPathMessage } from "../core.js";
import { runtimeTarget } from "../runtime/profile.js";
import { parseServerProperties } from "../runtime/serverProperties.js";
import { parseFileListing } from "../files/fileService.js";
import type { FileArchiveEntry } from "../downloadArchive.js";
import type { NodeRuntime } from "../nodes/types.js";
import type { ManagedServer } from "../types.js";

const defaultLevelName = "world";

/**
 * A path that is simply absent is not an export failure -- a server that never had a `config/` or
 * `crash-reports/` folder has nothing to contribute. Every other error is real and must surface,
 * because swallowing it turns a disconnected node or an unreadable directory into a green export
 * with files silently missing.
 *
 * A remote node flattens filesystem errors into `command_failed` with the original message, so the
 * message is the only signal available for a node-side ENOENT. That covers two shapes: a raw errno
 * from the node's own filesystem, and the path-safety refusal the node raises before it ever calls
 * the filesystem -- which reports a missing path in the panel's own words and carries no errno once
 * it crosses the wire. Missing the second one failed the whole export over an absent `world_nether`,
 * which is simply how Fabric and vanilla lay out their dimensions.
 */
export function isMissingPathError(error: unknown) {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return true;
  const message = error instanceof Error ? error.message : "";
  if (message === missingPathMessage || message === missingParentMessage) return true;
  return /ENOENT|no such file or directory/i.test(message);
}

/**
 * Most categories are a fixed set of paths under the server root. Three are resolved per server:
 * `content` against the runtime catalog, because Fabric keeps mods in `mods/` and Paper keeps plugins
 * in `plugins/`; `world` against `level-name`; and `panelSettings`, which is database rows and never
 * touches the filesystem.
 */
type CategoryTargets = { files: readonly string[]; directories: readonly string[] };

const staticCategoryTargets: Record<Exclude<ExportCategory, "content" | "panelSettings" | "world">, CategoryTargets> = {
  serverConfig: {
    files: ["server.properties", "eula.txt", ".serversentinel-version.json", "bukkit.yml", "spigot.yml", "paper.yml"],
    directories: []
  },
  accessControl: {
    files: ["whitelist.json", "ops.json", "banned-players.json", "banned-ips.json", "usercache.json"],
    directories: []
  },
  modConfig: { files: [], directories: ["config", "defaultconfigs"] },
  logs: { files: [], directories: ["logs", "crash-reports"] }
};

/**
 * Which folders hold this server's world.
 *
 * `level-name` renames the level folder, so a server configured with `level-name=survival` keeps
 * none of its data in `world/`. Paper and Spigot put the other dimensions in sibling `_nether` and
 * `_the_end` folders; Fabric and vanilla nest them inside the level folder, where the level entry
 * already covers them. The defaults stay in the list so a server whose properties cannot be read
 * still exports a conventional layout, and `worlds/` covers the Paper multi-world plugin convention.
 */
export function worldDirectories(levelName: string | undefined) {
  const level = levelName?.trim() || defaultLevelName;
  const directories = [level, `${level}_nether`, `${level}_the_end`, defaultLevelName, `${defaultLevelName}_nether`, `${defaultLevelName}_the_end`, "worlds"];
  return [...new Set(directories)];
}

/**
 * Regenerable or re-downloadable, and large enough that including them would dominate an artifact
 * without ever being worth restoring. The server jar is covered by the runtime profile's artifact
 * metadata, so it is re-downloaded on import exactly the way provisioning downloads it.
 */
const neverExported = new Set(["backups", "cache", "libraries", "versions"]);

const exportMaxEntries = config.fileDownloadMaxEntries;
const exportMaxDepth = 64;

export function categoryTargets(server: ManagedServer, category: ExportCategory, levelName?: string): CategoryTargets {
  if (category === "panelSettings") return { files: [], directories: [] };
  if (category === "content") {
    return { files: [], directories: [serverRuntimeDefinition(runtimeTarget(server).runtimeType).contentDirectory] };
  }
  if (category === "world") return { files: [], directories: worldDirectories(levelName) };
  return staticCategoryTargets[category];
}

function isExportCategory(value: unknown): value is ExportCategory {
  return typeof value === "string" && (EXPORT_CATEGORIES as readonly string[]).includes(value);
}

export function normalizeExportSelection(value: unknown): ExportSelection {
  const raw = (value ?? {}) as { categories?: unknown; contentStrategy?: unknown };
  if (!Array.isArray(raw.categories)) {
    throw new Error("categories must be an array");
  }
  const categories: ExportCategory[] = [];
  for (const entry of raw.categories) {
    if (!isExportCategory(entry)) throw new Error(`Unknown export category ${String(entry)}`);
    if (!categories.includes(entry)) categories.push(entry);
  }
  if (!categories.length) throw new Error("Select at least one category to export");
  const contentStrategy = raw.contentStrategy === undefined ? "lockfile" : raw.contentStrategy;
  if (contentStrategy !== "lockfile" && contentStrategy !== "jars") {
    throw new Error("contentStrategy must be lockfile or jars");
  }
  // Order by the canonical list so a manifest reads the same regardless of how the client sent it.
  return {
    categories: EXPORT_CATEGORIES.filter((category) => categories.includes(category)),
    contentStrategy: contentStrategy as ExportContentStrategy
  };
}

type CollectedFile = {
  /** Path relative to the server root, always forward-slashed. */
  relativePath: string;
  /** Node-resolved absolute path, opened lazily when the archive streams. */
  sourcePath: string;
  size: number;
  modifiedAt?: string;
};

export type CollectedCategory = {
  category: ExportCategory;
  files: CollectedFile[];
  totalBytes: number;
};

function assertWithinEntryBudget(count: number) {
  if (count > exportMaxEntries) {
    throw new Error(`Export selection contains more than ${exportMaxEntries} files`);
  }
}

async function collectDirectory(
  runtime: NodeRuntime,
  server: ManagedServer,
  publicPath: string,
  relativePath: string,
  collected: CollectedFile[],
  depth: number
) {
  if (depth > exportMaxDepth) {
    throw new Error(`Export selection is nested deeper than ${exportMaxDepth} directories`);
  }
  let resolved: string;
  try {
    resolved = await runtime.resolveExistingPath(server, publicPath);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  let listing;
  try {
    listing = parseFileListing(await runtime.listFiles(server, resolved));
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  for (const entry of listing.entries) {
    const childRelative = `${relativePath}/${entry.name}`;
    if (entry.type === "directory") {
      await collectDirectory(runtime, server, entry.path, childRelative, collected, depth + 1);
      continue;
    }
    let childResolved: string;
    try {
      childResolved = await runtime.resolveExistingPath(server, entry.path);
    } catch (error) {
      // The listing is a snapshot; a file deleted between listing and resolution is genuinely gone.
      if (isMissingPathError(error)) continue;
      throw error;
    }
    collected.push({ relativePath: childRelative, sourcePath: childResolved, size: entry.size, modifiedAt: entry.modifiedAt });
    assertWithinEntryBudget(collected.length);
  }
}

type RootEntry = { size: number; modifiedAt?: string };

/**
 * Root-level files are looked up against a single listing rather than one call each: size and mtime
 * are the only things needed, and the parent listing is the one shape both runtimes already agree on.
 */
async function readRootEntries(runtime: NodeRuntime, server: ManagedServer) {
  const entries = new Map<string, RootEntry>();
  try {
    const listing = parseFileListing(await runtime.listFiles(server, await runtime.resolveExistingPath(server, "/")));
    for (const entry of listing.entries) {
      if (entry.type === "file") entries.set(entry.name, { size: entry.size, modifiedAt: entry.modifiedAt });
    }
  } catch (error) {
    // A server directory that does not exist yet has nothing to export; anything else -- an offline
    // node, an unreadable root -- would silently drop every root-level file, so it must surface.
    if (!isMissingPathError(error)) throw error;
  }
  return entries;
}

async function collectFile(
  runtime: NodeRuntime,
  server: ManagedServer,
  name: string,
  rootEntries: Map<string, RootEntry>,
  collected: CollectedFile[]
) {
  const match = rootEntries.get(name);
  if (!match) return;
  let resolved: string;
  try {
    resolved = await runtime.resolveExistingPath(server, name);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  collected.push({ relativePath: name, sourcePath: resolved, size: match.size, modifiedAt: match.modifiedAt });
  assertWithinEntryBudget(collected.length);
}

/**
 * Reads `level-name` so the world category can find a renamed level folder. A server without a
 * readable server.properties falls back to the conventional layout rather than failing the export --
 * the same file is also exported by the serverConfig category, so the name travels with the archive.
 */
async function readLevelName(runtime: NodeRuntime, server: ManagedServer) {
  try {
    const target = await runtime.resolveExistingPath(server, "server.properties");
    const file = await runtime.readFile(server, target) as { content?: unknown };
    if (typeof file?.content !== "string") return undefined;
    return parseServerProperties(file.content)["level-name"];
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

/**
 * Walks one server for the selected categories. `content` is collected here too so that a jars-mode
 * export and the size estimate both see the same files; lockfile mode drops the jars afterwards,
 * keeping only the ones Modrinth could not identify.
 */
export async function collectServerCategories(
  runtime: NodeRuntime,
  server: ManagedServer,
  categories: readonly ExportCategory[]
): Promise<CollectedCategory[]> {
  const results: CollectedCategory[] = [];
  const needsRootEntries = categories.some((category) => categoryTargets(server, category).files.length > 0);
  const rootEntries = needsRootEntries ? await readRootEntries(runtime, server) : new Map<string, RootEntry>();
  const levelName = categories.includes("world") ? await readLevelName(runtime, server) : undefined;
  for (const category of categories) {
    if (category === "panelSettings") continue;
    const targets = categoryTargets(server, category, levelName);
    const files: CollectedFile[] = [];
    for (const name of targets.files) {
      await collectFile(runtime, server, name, rootEntries, files);
    }
    for (const directory of targets.directories) {
      if (neverExported.has(directory.toLowerCase())) continue;
      await collectDirectory(runtime, server, `/${directory}`, directory, files, 0);
    }
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    results.push({ category, files, totalBytes: files.reduce((total, file) => total + file.size, 0) });
  }
  return results;
}

export async function measureWorldSize(runtime: NodeRuntime, server: ManagedServer) {
  const [world] = await collectServerCategories(runtime, server, ["world"]);
  return world?.totalBytes ?? 0;
}

export function archiveEntriesForFiles(prefix: string, files: readonly CollectedFile[]): FileArchiveEntry[] {
  return files.map((file) => ({
    sourcePath: file.sourcePath,
    archivePath: `${prefix}/${file.relativePath}`,
    type: "file" as const,
    size: file.size,
    modifiedAt: file.modifiedAt
  }));
}
