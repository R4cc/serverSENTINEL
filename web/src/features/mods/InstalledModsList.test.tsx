import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InstalledMod, ModUpdatePlan, RestartRequiredChange } from "../../types";
import { InstalledModsList } from "./InstalledModsList";
import { createDemoUpdatePlan } from "./modUpdatePlan";

const noop = vi.fn();

function mod(overrides: Partial<InstalledMod> = {}): InstalledMod {
  return {
    filename: "fabric-api.jar",
    displayName: "Fabric API",
    enabled: true,
    size: 1,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    compatibility: { status: "compatible", compatible: true, reason: "Compatible", serverSide: "required" },
    modrinth: { projectId: "fabric-api", versionId: "v1", filename: "fabric-api.jar", versionNumber: "0.154.0+26.2", gameVersions: ["1.21.4"], loaders: ["fabric"], installedAt: "2026-01-01T00:00:00.000Z", installedWithForceIncompatible: false },
    versionInfo: { currentVersion: "0.154.0+26.2", latestVersion: "0.155.0+26.2", upToDate: false },
    ...overrides
  };
}

function renderInstalledMods(installed: InstalledMod[], updatePlan: ModUpdatePlan | null = createDemoUpdatePlan("demo", installed), restartRequiredChanges?: RestartRequiredChange[]) {
  return renderToStaticMarkup(
    <InstalledModsList
      mods={installed}
      restartRequiredChanges={restartRequiredChanges}
      query=""
      busy={false}
      locked={false}
      onQueryChange={noop}
      onToggle={noop}
      onUpdate={noop}
      onSwitchVersion={noop}
      onDetails={noop}
      updatePlan={updatePlan}
    />
  );
}

describe("InstalledModsList", () => {
  it("renders current and target versions in the update column", () => {
    const html = renderInstalledMods([mod()]);

    expect(html).toContain("0.154.0+26.2");
    expect(html).toContain("update to");
    expect(html).toContain("0.155.0+26.2");
    expect(html).toContain("Update");
  });

  it("falls back when the target update version is missing", () => {
    const installed = mod({ versionInfo: { currentVersion: "0.154.0+26.2", upToDate: false } });
    const updatePlan: ModUpdatePlan = {
      serverId: "demo",
      generatedAt: "2026-01-01T00:00:00.000Z",
      counts: { totalInstalled: 1, safeUpdates: 1, reviewUpdates: 0, blockedUpdates: 0, upToDate: 0, unknown: 0 },
      updates: [{
        filename: installed.filename,
        displayName: installed.displayName,
        currentVersion: "0.154.0+26.2",
        currentFilename: installed.filename,
        channel: "release",
        status: "safe_update",
        reason: "A safe update is available.",
        safeBatchEligible: true,
        acknowledgementRequired: false,
        enabled: true
      }]
    };
    const html = renderInstalledMods([installed], updatePlan);

    expect(html).toContain("0.154.0+26.2");
    expect(html).toContain("Update available");
  });

  it("renders a switch version button for Modrinth-managed mods", () => {
    const html = renderInstalledMods([mod()]);

    expect(html).toContain("Switch version for Fabric API");
  });

  it("disables switch version for manual mods", () => {
    const html = renderInstalledMods([mod({ modrinth: undefined })], null);

    expect(html).toContain("Only Modrinth-managed mods can switch versions");
    expect(html).toContain("disabled");
  });

  it("keeps health status and adds a restart chip for affected installed mods", () => {
    const healthyMod = mod({ versionInfo: { currentVersion: "0.154.0+26.2", latestVersion: "0.154.0+26.2", upToDate: true } });
    const html = renderInstalledMods([healthyMod], null, [{
      type: "mod", identity: "modrinth:fabric-api", displayName: "Fabric API", filename: "fabric-api.jar", action: "updated"
    }]);
    expect(html).toContain("Healthy");
    expect(html).toContain("Requires restart");
  });
});
