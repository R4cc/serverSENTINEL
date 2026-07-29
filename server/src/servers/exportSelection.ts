import { EXPORT_CATEGORIES, serverRuntimeDefinition, type ExportCategory, type ExportContentStrategy, type ExportSelection } from "@serversentinel/contracts";
import { config } from "../config.js";
import { runtimeTarget } from "../runtime/profile.js";
import { parseFileListing } from "../files/fileService.js";
import type { FileArchiveEntry } from "../downloadArchive.js";
import type { NodeRuntime } from "../nodes/types.js";
import type { ManagedServer } from "../types.js";

/**
 * Every category except `content` and `panelSettings` is a plain set of paths under the server root.
 * `content` resolves against the runtime catalog because Fabric keeps mods in `mods/` and Paper keeps
 * plugins in `plugins/`; `panelSettings` is database rows and never touches the filesystem.
 */
type CategoryTargets = { files: readonly string[]; directories: readonly string[] };

const staticCategoryTargets: Record<Exclude<ExportCategory, "content" | "panelSettings">, CategoryTargets> = {
  serverConfig: {
    files: ["server.properties", "eula.txt", ".serversentinel-version.json", "bukkit.yml", "spigot.yml", "paper.yml"],
    directories: []
  },
  accessControl: {
    files: ["whitelist.json", "ops.json", "banned-players.json", "banned-ips.json", "usercache.json"],
    directories: []
  },
  modConfig: { files: [], directories: ["config", "defaultconfigs"] },
  // Datapacks live in world/datapacks, so they travel with the world rather than as their own toggle.
  world: { files: [], directories: ["world", "world_nether", "world_the_end", "worlds"] },
  logs: { files: [], directories: ["logs", "crash-reports"] }
};

/**
 * Regenerable or re-downloadable, and large enough that including them would dominate an artifact
 * without ever being worth restoring. The server jar is covered by the runtime profile's artifact
 * metadata, so it is re-downloaded on import exactly the way provisioning downloads it.
 */
const neverExported = new Set(["backups", "cache", "libraries", "versions"]);

export const exportMaxEntries = config.fileDownloadMaxEntries;
export const exportMaxDepth = 64;

export function categoryTargets(server: ManagedServer, category: ExportCategory): CategoryTargets {
  if (category === "panelSettings") return { files: [], directories: [] };
  if (category === "content") {
    return { files: [], directories: [serverRuntimeDefinition(runtimeTarget(server).runtimeType).contentDirectory] };
  }
  return staticCategoryTargets[category];
}

export function isExportCategory(value: unknown): value is ExportCategory {
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

export type CollectedFile = {
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
  } catch {
    // A server that never had a config/ or crash-reports/ folder is not an error; nothing to take.
    return;
  }
  let listing;
  try {
    listing = parseFileListing(await runtime.listFiles(server, resolved));
  } catch {
    return;
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
    } catch {
      continue;
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
  } catch {
    // An unreachable root listing yields an empty selection rather than failing the whole export.
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
  } catch {
    return;
  }
  collected.push({ relativePath: name, sourcePath: resolved, size: match.size, modifiedAt: match.modifiedAt });
  assertWithinEntryBudget(collected.length);
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
  for (const category of categories) {
    if (category === "panelSettings") continue;
    const targets = categoryTargets(server, category);
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

export function archiveEntriesForFiles(prefix: string, files: readonly CollectedFile[]): FileArchiveEntry[] {
  return files.map((file) => ({
    sourcePath: file.sourcePath,
    archivePath: `${prefix}/${file.relativePath}`,
    type: "file" as const,
    size: file.size,
    modifiedAt: file.modifiedAt
  }));
}
