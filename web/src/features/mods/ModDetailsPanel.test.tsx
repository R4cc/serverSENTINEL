import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InstalledMod } from "../../types";
import { ModDetailsPanel } from "./ModDetailsPanel";
import { buildModDependencyGraph, type ModDependencyLinks } from "./modDependencyGraph";

const noop = vi.fn();

function mod(overrides: Partial<InstalledMod> = {}): InstalledMod {
  return {
    filename: "example.jar",
    displayName: "Example",
    enabled: true,
    size: 1024,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    compatibility: { status: "unknown", compatible: false, reason: "Server-side support could not be verified", serverSide: "unknown", clientSide: "optional" },
    modrinth: {
      projectId: "example",
      versionId: "v1",
      filename: "example.jar",
      versionNumber: "1.0.0",
      gameVersions: ["1.21.4"],
      loaders: ["fabric"],
      installedAt: "2026-01-01T00:00:00.000Z",
      installedWithForceIncompatible: false,
      serverSide: "unknown",
      clientSide: "optional"
    },
    versionInfo: { currentVersion: "1.0.0", upToDate: true },
    ...overrides
  };
}

function renderPanel(installed: InstalledMod, dependencyLinks?: ModDependencyLinks) {
  return renderToStaticMarkup(
    <ModDetailsPanel
      mod={installed}
      locked={false}
      reviewAcknowledgementLocked={false}
      formatDate={() => "Jan 1, 2026"}
      onClose={noop}
      onToggle={noop}
      onUpdate={noop}
      onRemove={noop}
      onAcknowledgeReview={noop}
      dependencyLinks={dependencyLinks}
      onOpenMod={noop}
      updatePlanEntry={null}
    />
  );
}

describe("ModDetailsPanel", () => {
  it("shows acknowledgement for Modrinth mods that need review", () => {
    const html = renderPanel(mod());

    expect(html).toContain("Needs review");
    expect(html).toContain("Acknowledge review");
  });

  it("hides acknowledgement after the current version is acknowledged", () => {
    const html = renderPanel(mod({
      modrinth: {
        ...mod().modrinth!,
        reviewAcknowledgedVersionId: "v1",
        reviewAcknowledgedAt: "2026-01-02T00:00:00.000Z"
      }
    }));

    expect(html).toContain("Healthy");
    expect(html).not.toContain("Acknowledge review");
  });

  it("lists missing and disabled dependencies with a repair action", () => {
    const html = renderPanel(mod({
      dependencyHealth: {
        status: "missing",
        requiredCount: 2,
        missing: [
          { projectId: "fabric-api", title: "Fabric API" },
          { projectId: "cloth-config", title: "Cloth Config", disabled: true }
        ]
      }
    }));

    expect(html).toContain("Dependencies");
    expect(html).toContain("Requires");
    expect(html).toContain("Fabric API");
    expect(html).toContain("Not installed");
    expect(html).toContain("Cloth Config");
    expect(html).toContain("Disabled");
    expect(html).toContain("Install dependencies");
  });

  it("links a library to the mods that require it and warns what disabling it breaks", () => {
    const library = mod({ filename: "fabric-api.jar", displayName: "Fabric API", modrinth: { ...mod().modrinth!, projectId: "fabric-api", versionId: "fapi" } });
    const sodium = mod({ filename: "sodium.jar", displayName: "Sodium", modrinth: { ...mod().modrinth!, projectId: "sodium", versionId: "sod" }, dependencyHealth: { status: "satisfied", requiredCount: 1, required: [{ projectId: "fabric-api" }], missing: [] } });
    const lithium = mod({ filename: "lithium.jar", displayName: "Lithium", modrinth: { ...mod().modrinth!, projectId: "lithium", versionId: "lit" }, dependencyHealth: { status: "satisfied", requiredCount: 1, required: [{ projectId: "fabric-api" }], missing: [] } });
    const graph = buildModDependencyGraph([library, sodium, lithium]);

    const libraryHtml = renderPanel(library, graph.linksFor(library));
    expect(libraryHtml).toContain("Required by");
    expect(libraryHtml).toContain('title="Open Lithium"');
    expect(libraryHtml).toContain('title="Open Sodium"');
    expect(libraryHtml).toContain("Disabling or removing this mod stops Lithium and Sodium from loading.");

    const parentHtml = renderPanel(sodium, graph.linksFor(sodium));
    expect(parentHtml).toContain('title="Open Fabric API"');
    expect(parentHtml).toContain("Installed");
    expect(parentHtml).not.toContain("Required by");
  });

  it("omits the dependency section for a mod with no dependency links", () => {
    expect(renderPanel(mod(), { requires: [], requiredBy: [] })).not.toContain("mod-dependencies-title");
  });
});
