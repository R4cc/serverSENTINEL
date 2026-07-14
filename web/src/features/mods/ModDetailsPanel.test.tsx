import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InstalledMod } from "../../types";
import { ModDetailsPanel } from "./ModDetailsPanel";

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

function renderPanel(installed: InstalledMod) {
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

    expect(html).toContain("Required dependencies");
    expect(html).toContain("Fabric API");
    expect(html).toContain("Not installed");
    expect(html).toContain("Cloth Config");
    expect(html).toContain("Disabled");
    expect(html).toContain("Install dependencies");
  });
});
