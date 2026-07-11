import { describe, expect, it } from "vitest";
import { diffModSnapshots, snapshotMods } from "./modRestartState.js";

function mod(filename: string, sha1: string, options: { enabled?: boolean; projectId?: string; displayName?: string } = {}) {
  return {
    filename,
    displayName: options.displayName ?? filename.replace(/\.jar\.disabled$/, ".jar"),
    enabled: options.enabled ?? filename.endsWith(".jar"),
    sha1,
    modrinth: options.projectId ? { projectId: options.projectId } : undefined
  };
}

describe("mod restart state", () => {
  it("classifies added and removed mods", () => {
    const baseline = snapshotMods({ mods: [mod("old.jar", "a")] });
    const current = snapshotMods({ mods: [mod("new.jar", "b")] });
    expect(diffModSnapshots(baseline, current)).toEqual([
      expect.objectContaining({ displayName: "new.jar", action: "added" }),
      expect.objectContaining({ displayName: "old.jar", action: "removed" })
    ]);
  });

  it("treats enable and disable renames as state changes", () => {
    const baseline = snapshotMods({ mods: [mod("example.jar", "a", { enabled: true })] });
    const current = snapshotMods({ mods: [mod("example.jar.disabled", "a", { enabled: false })] });
    expect(diffModSnapshots(baseline, current)).toEqual([
      expect.objectContaining({ identity: "file:example.jar", action: "disabled" })
    ]);
  });

  it("uses Modrinth identity across update filename changes", () => {
    const baseline = snapshotMods({ mods: [mod("example-1.jar", "a", { projectId: "example", displayName: "Example" })] });
    const current = snapshotMods({ mods: [mod("example-2.jar", "b", { projectId: "example", displayName: "Example" })] });
    expect(diffModSnapshots(baseline, current)).toEqual([
      expect.objectContaining({ identity: "modrinth:example", filename: "example-2.jar", action: "updated" })
    ]);
  });

  it("clears inverse changes when the inventory returns to baseline", () => {
    const baseline = snapshotMods({ mods: [mod("example.jar", "a")] });
    expect(diffModSnapshots(baseline, snapshotMods({ mods: [mod("example.jar", "a")] }))).toEqual([]);
  });
});
