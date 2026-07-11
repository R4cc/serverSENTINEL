import type { RestartRequiredChange, RestartRequiredModSnapshot } from "./types.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function canonicalFilename(filename: string) {
  return filename.replace(/\.jar\.disabled$/i, ".jar").toLowerCase();
}

export function modIdentity(mod: Record<string, unknown>) {
  const metadata = record(mod.modrinth);
  const projectId = stringValue(metadata.projectId);
  if (projectId) return `modrinth:${projectId}`;
  return `file:${canonicalFilename(stringValue(mod.filename))}`;
}

export function snapshotMods(result: unknown): RestartRequiredModSnapshot[] {
  const mods = record(result).mods;
  if (!Array.isArray(mods)) return [];
  return mods.map((value) => {
    const mod = record(value);
    const metadata = record(mod.modrinth);
    const hashes = record(metadata.hashes);
    const filename = stringValue(mod.filename);
    return {
      identity: modIdentity(mod),
      displayName: stringValue(mod.displayName) || canonicalFilename(filename),
      filename,
      enabled: mod.enabled === true,
      sha1: stringValue(mod.sha1) || stringValue(hashes.sha1)
    };
  }).filter((mod) => mod.identity !== "file:");
}

export function diffModSnapshots(baseline: RestartRequiredModSnapshot[], current: RestartRequiredModSnapshot[]): RestartRequiredChange[] {
  const before = new Map(baseline.map((mod) => [mod.identity, mod]));
  const after = new Map(current.map((mod) => [mod.identity, mod]));
  const changes: RestartRequiredChange[] = [];

  for (const [identity, original] of before) {
    const next = after.get(identity);
    if (!next) {
      changes.push({ type: "mod", identity, displayName: original.displayName, filename: original.filename, action: "removed" });
      continue;
    }
    if (original.sha1 !== next.sha1 || canonicalFilename(original.filename) !== canonicalFilename(next.filename)) {
      changes.push({ type: "mod", identity, displayName: next.displayName, filename: next.filename, action: "updated" });
    } else if (original.enabled !== next.enabled) {
      changes.push({ type: "mod", identity, displayName: next.displayName, filename: next.filename, action: next.enabled ? "enabled" : "disabled" });
    }
  }

  for (const [identity, next] of after) {
    if (!before.has(identity)) {
      changes.push({ type: "mod", identity, displayName: next.displayName, filename: next.filename, action: "added" });
    }
  }

  return changes.sort((left, right) => left.displayName.localeCompare(right.displayName) || left.action.localeCompare(right.action));
}
