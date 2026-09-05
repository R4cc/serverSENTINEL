import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ModHistoryEntry } from "@serversentinel/contracts";
import type { InstalledMod } from "../../types";
import { modVersion } from "./modHealth";
import type { ModHistorySource } from "./ModHistoryPage";

type DemoEntry = { entry: ModHistoryEntry; before: InstalledMod | null; after: InstalledMod | null };
const identity = (mod: InstalledMod) => mod.modrinth?.projectId || mod.filename.replace(/\.disabled$/, "");
const same = (left: InstalledMod | null | undefined, right: InstalledMod | null | undefined) => !left || !right ? !left && !right
  : left.filename === right.filename && left.enabled === right.enabled && modVersion(left) === modVersion(right);

export function useDemoModHistory(serverId: string | undefined, enabled: boolean, mods: InstalledMod[], setMods: Dispatch<SetStateAction<InstalledMod[]>>): ModHistorySource | undefined {
  const stores = useRef(new Map<string, { mods: InstalledMod[]; entries: DemoEntry[] }>());
  const scope = useRef({ serverId, enabled });
  function store() {
    const key = serverId || "demo";
    let value = stores.current.get(key);
    if (!value) { value = { mods, entries: [] }; stores.current.set(key, value); }
    return value;
  }
  function record(next: InstalledMod[], revertsEntryId: string | null = null) {
    const state = store();
    const remaining = [...next];
    const pairs: Array<[InstalledMod | null, InstalledMod | null]> = state.mods.map((before) => {
      const index = remaining.findIndex((after) => identity(after) === identity(before));
      return [before, index < 0 ? null : remaining.splice(index, 1)[0]];
    });
    pairs.push(...remaining.map((after): [null, InstalledMod] => [null, after]));
    for (const [before, after] of pairs) {
      if (same(before, after)) continue;
      const version = (mod: InstalledMod | null) => mod ? { filename: mod.filename, version: modVersion(mod) === "Unknown" ? null : modVersion(mod), enabled: mod.enabled } : null;
      state.entries.unshift({ before, after, entry: {
        id: crypto.randomUUID(), modName: (after || before)!.displayName, iconUrl: after?.iconUrl || before?.iconUrl,
        action: !before ? "installed" : !after ? "removed" : modVersion(before) !== modVersion(after) ? "updated" : after.enabled ? "enabled" : "disabled",
        before: version(before), after: version(after), occurredAt: new Date().toISOString(), user: { id: "demo", username: "demo" },
        revertsEntryId, revertedAt: null, canRevert: true, revertBlockedReason: null
      } });
    }
    state.entries = state.entries.slice(0, 500);
    state.mods = next;
  }
  useEffect(() => {
    if (enabled) {
      if (scope.current.serverId !== serverId || !scope.current.enabled) store().mods = mods;
      else record(mods);
    }
    scope.current = { serverId, enabled };
  }, [enabled, serverId, mods]);
  if (!enabled) return undefined;
  // Initialize before the first change, and keep the fixtures scoped to this demo session.
  store();
  function blocked(item: DemoEntry) {
    if (item.entry.revertedAt) return "This action has already been reverted.";
    const target = item.after || item.before!;
    const current = store().mods.find((mod) => identity(mod) === identity(target));
    return same(current, item.after) ? null : "This mod has changed since this action. Revert its newer changes first.";
  }
  return {
    async list(offset) {
      const entries = store().entries;
      return { total: entries.length, limit: 50, offset, entries: entries.slice(offset, offset + 50).map((item) => {
        const reason = blocked(item);
        return { ...item.entry, canRevert: !reason, revertBlockedReason: reason };
      }) };
    },
    async revert(id) {
      const item = store().entries.find((candidate) => candidate.entry.id === id);
      if (!item) throw new Error("History entry not found.");
      const reason = blocked(item);
      if (reason) throw new Error(reason);
      const next = store().mods.filter((mod) => identity(mod) !== identity((item.after || item.before)!));
      if (item.before) next.push(item.before);
      item.entry.revertedAt = new Date().toISOString();
      record(next, id);
      setMods(next);
    }
  };
}
