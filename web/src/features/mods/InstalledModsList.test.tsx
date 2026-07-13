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

function renderInstalledMods(installed: InstalledMod[], updatePlan: ModUpdatePlan | null = createDemoUpdatePlan("demo", installed), restartRequiredChanges?: RestartRequiredChange[], busy = false) {
  return renderToStaticMarkup(
    <InstalledModsList
      mods={installed}
      restartRequiredChanges={restartRequiredChanges}
      query=""
      busy={busy}
      locked={false}
      onQueryChange={noop}
      onToggle={noop}
      onUpdate={noop}
      onSwitchVersion={noop}
      onDetails={noop}
      onDropFiles={noop}
      updatePlan={updatePlan}
    />
  );
}

describe("InstalledModsList", () => {
  it("renders the installed version once and the target inside an integrated update action", () => {
    const html = renderInstalledMods([mod()]);
    const updateAction = html.match(/<button[^>]*modsUpdateAction[^>]*>[\s\S]*?<\/button>/)?.[0];

    expect(html.match(/0\.154\.0\+26\.2/g)).toHaveLength(1);
    expect(html).toContain("→");
    expect(html).toContain("0.155.0+26.2");
    expect(html).toContain('aria-label="Update Fabric API to 0.155.0+26.2"');
    expect(html).toContain("modsUpdateAction");
    expect(html).toContain("modsUpdateActionLabel");
    expect(html).toContain(">Update<");
    expect(updateAction).not.toContain("<svg");
    expect(html).not.toContain("update to");
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
    expect(html).toContain(">Available<");
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

  it("exposes the installed mods table as a file drop target", () => {
    const html = renderInstalledMods([mod()]);

    expect(html).toContain("modsWorkspaceTable");
  });

  it("renders five table-shaped skeleton rows without the empty state during initial loading", () => {
    const html = renderInstalledMods([], null, undefined, true);

    expect((html.match(/modsWorkspaceSkeletonRow/g) ?? []).length).toBe(5);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading installed mods");
    expect(html).not.toContain("No mods installed yet");
  });

  it("keeps populated rows visible during background refreshes", () => {
    const html = renderInstalledMods([mod()], null, undefined, true);

    expect(html).toContain("Fabric API");
    expect(html).not.toContain("modsWorkspaceSkeletonRow");
  });
});
