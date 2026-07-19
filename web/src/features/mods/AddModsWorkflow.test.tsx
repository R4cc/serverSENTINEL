import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ModInstallModalState } from "../../app/uiState";
import type { ModrinthHit, ModrinthInstallVersion } from "../../types";
import { AddModsWorkflow } from "./AddModsWorkflow";
import { ModInstallReview } from "./ModInstallReview";

const noop = vi.fn();

function renderAddWorkflow(overrides: Partial<Parameters<typeof AddModsWorkflow>[0]> = {}) {
  const props: Parameters<typeof AddModsWorkflow>[0] = {
    query: "clumps",
    results: [],
    total: 0,
    installedMods: [],
    searching: false,
    loadingMore: false,
    error: "",
    configured: true,
    versionsUnknown: false,
    contextMessage: "",
    minecraftVersion: "1.21.4",
    showIncompatibleResults: false,
    locked: false,
    sentinelRef: { current: null },
    installState: null,
    selectedVersion: null,
    requiredDependencies: [],
    canContinue: false,
    formatDate: () => "Jan 1, 2026",
    formatNumber: (value) => String(value),
    onClose: noop,
    onQueryChange: noop,
    onShowIncompatibleResultsChange: noop,
    onChoose: noop,
    onRetrySearch: noop,
    onInstallClose: noop,
    onChannelChange: noop,
    onSelectVersion: noop,
    onToggleAdvanced: noop,
    onAcknowledge: noop,
    onContinue: noop,
    onBack: noop,
    onInstall: noop,
    ...overrides
  };
  return renderToStaticMarkup(<AddModsWorkflow {...props} />);
}

function incompatibleVersion(): ModrinthInstallVersion {
  return {
    id: "old",
    versionNumber: "0.9.0",
    releaseChannel: "release",
    publishedAt: "2026-01-01T00:00:00.000Z",
    minecraftVersions: ["1.20.1"],
    loaders: ["fabric"],
    file: { filename: "old.jar" },
    compatible: false,
    selectable: true,
    requiresMinecraftAcknowledgement: true,
    status: "version_mismatch",
    statusLabel: "Version mismatch",
    reason: "Not marked for Minecraft 1.21.4",
    dependencies: []
  };
}

function installState(version: ModrinthInstallVersion, step: 1 | 2, acknowledged: boolean, mode: "install" | "switch" = "install"): ModInstallModalState {
  return {
    mode,
    mod: { project_id: "clumps", title: "Clumps", description: "", downloads: 1 },
    sourceFilename: mode === "switch" ? "clumps.jar" : undefined,
    step,
    channel: "release",
    loading: false,
    installing: false,
    error: "",
    data: {
      project: { id: "clumps", title: "Clumps" },
      target: { serverId: "server", serverName: "Demo", minecraftVersion: "1.21.4", loader: "Fabric" },
      channel: "release",
      compatibleVersions: [],
      otherVersions: [version]
    },
    selectedVersionId: version.id,
    showOtherVersions: true,
    acknowledgeMinecraftMismatch: acknowledged
  };
}

describe("AddModsWorkflow", () => {
  it("renders the explicit incompatible toggle and safe default copy", () => {
    const html = renderAddWorkflow();
    expect(html).toContain("Show incompatible mods");
    expect(html).toContain("Showing compatible Fabric server mods for this server.");
  });

  it("renders incompatible search results with a visible risk state", () => {
    const risky: ModrinthHit = {
      project_id: "clumps",
      title: "Clumps",
      description: "Groups XP orbs.",
      downloads: 31,
      compatibility: {
        status: "no_minecraft_version",
        compatible: false,
        reason: "Not available for Minecraft 1.21.4",
        serverSide: "required",
        clientSide: "optional"
      }
    };
    const html = renderAddWorkflow({ results: [risky], total: 1, showIncompatibleResults: true });
    expect(html).toContain("Not recommended");
    expect(html).toContain("Not available for Minecraft 1.21.4");
    expect(html).toContain("Review risk");
  });

  it("uses empty-state copy that reflects the toggle state", () => {
    expect(renderAddWorkflow()).toContain("No compatible mods found");
    expect(renderAddWorkflow({ showIncompatibleResults: true })).toContain("No matching mods found");
  });

  it("renders only version selection for switch mode", () => {
    const version = incompatibleVersion();
    const html = renderAddWorkflow({
      query: "",
      installState: installState(version, 1, false, "switch"),
      selectedVersion: version,
      canContinue: false
    });

    expect(html).toContain("Choose a version");
    expect(html).toContain("Installed mods");
    expect(html).not.toContain("Find a Fabric mod");
    expect(html).not.toContain("Search by mod name");
    expect(html).not.toContain("What would you like to add?");
  });

  it("keeps an install selection in review instead of returning to search skeletons", () => {
    const version = incompatibleVersion();
    const html = renderAddWorkflow({
      installState: { ...installState(version, 1, false), loading: true, data: null },
      selectedVersion: null,
      searching: true
    });

    expect(html).toContain("Choose a version");
    expect(html).not.toContain("Find a Fabric mod");
    expect(html).not.toContain("Searching…");
    expect(html).not.toContain("modsResultCard isSkeleton");
  });
});

describe("ModInstallReview", () => {
  it("does not replace installation progress with a stop-server warning", () => {
    const version = { ...incompatibleVersion(), compatible: true, requiresMinecraftAcknowledgement: false };
    const html = renderToStaticMarkup(
      <ModInstallReview
        state={{ ...installState(version, 2, true), installing: true }}
        selected={version}
        requiredDependencies={[]}
        canContinue
        locked
        formatDate={() => "Jan 1, 2026"}
        onClose={noop}
        onChannelChange={noop}
        onRetry={noop}
        onSelect={noop}
        onToggleAdvanced={noop}
        onAcknowledge={noop}
        onContinue={noop}
        onBack={noop}
        onInstall={noop}
      />
    );

    expect(html).toContain("Installing...");
    expect(html).not.toContain("Stop the server to install");
  });

  it("keeps incompatible selected versions disabled until acknowledgement is present", () => {
    const version = incompatibleVersion();
    const html = renderToStaticMarkup(
      <ModInstallReview
        state={installState(version, 2, false)}
        selected={version}
        requiredDependencies={[]}
        canContinue={false}
        formatDate={() => "Jan 1, 2026"}
        onClose={noop}
        onChannelChange={noop}
        onRetry={noop}
        onSelect={noop}
        onToggleAdvanced={noop}
        onAcknowledge={noop}
        onContinue={noop}
        onBack={noop}
        onInstall={noop}
      />
    );
    expect(html).toContain("not marked compatible with the server Minecraft version");
    expect(html).toContain("Install incompatible mod");
    expect(html).toContain("disabled");
  });

  it("uses switch copy without dependency install summary in switch mode", () => {
    const version = { ...incompatibleVersion(), compatible: true, requiresMinecraftAcknowledgement: false, dependencies: [{ projectId: "fabric-api", dependencyType: "required", title: "Fabric API" }] };
    const html = renderToStaticMarkup(
      <ModInstallReview
        state={installState(version, 2, true, "switch")}
        selected={version}
        requiredDependencies={version.dependencies}
        canContinue
        formatDate={() => "Jan 1, 2026"}
        onClose={noop}
        onChannelChange={noop}
        onRetry={noop}
        onSelect={noop}
        onToggleAdvanced={noop}
        onAcknowledge={noop}
        onContinue={noop}
        onBack={noop}
        onInstall={noop}
      />
    );

    expect(html).toContain("Review switch");
    expect(html).toContain("Switch version");
    expect(html).not.toContain("Also installs");
  });
});
