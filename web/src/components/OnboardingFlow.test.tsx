import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ContextNode, ManagedServer } from "../types";
import { OnboardingFlow, onboardingRecommendedStep } from "./OnboardingFlow";

const localNode: ContextNode = {
  id: "local",
  name: "Internal Node",
  type: "local",
  status: "online",
  isInternal: true,
  dockerStatus: "available",
  dataPathStatus: "ready",
  servers: []
};

const server = {
  id: "server-1",
  nodeId: "local",
  displayName: "Survival",
  runtimeIntent: "running",
  runtimeProfile: { runtimeType: "fabric" }
} as ManagedServer;

function render(overrides: Partial<Parameters<typeof OnboardingFlow>[0]> = {}) {
  return renderToStaticMarkup(<OnboardingFlow
    open
    nodes={[localNode]}
    servers={[]}
    serverRunning={false}
    runtimeMode="all-in-one"
    panelTimeZone="Europe/Berlin"
    modrinthConfigured={false}
    playerHeadsEnabled={false}
    playerHeadsBusy={false}
    canCreateServers
    canManageNodes
    canControlServers
    canManageIntegrations
    startingServer={false}
    onClose={vi.fn()}
    onAddNode={vi.fn()}
    onCreateServer={vi.fn()}
    onImportServer={vi.fn()}
    onOpenServer={vi.fn()}
    onStartServer={vi.fn()}
    onOpenSettings={vi.fn()}
    onFinish={vi.fn()}
    {...overrides}
  />);
}

describe("onboarding flow", () => {
  it("starts a fresh installation with capability-based host choices", () => {
    const html = render();
    expect(html).toContain("Where should the first server run?");
    expect(html).toContain("This machine");
    expect(html).toContain("Another machine");
    expect(html).toContain("Add remote node");
    expect(html).not.toContain("Additional nodes remain available");
  });

  it("resumes at optional setup after the first server is running", () => {
    const html = render({ servers: [server], activeServerId: server.id, serverRunning: true });
    expect(html).toContain("Make the panel yours");
    expect(html).toContain("Player heads");
    expect(html).toContain("Scheduling time zone");
    expect(html).toContain("Finish setup");
  });

  it("derives resumable milestones from server state", () => {
    expect(onboardingRecommendedStep({ serverCount: 0, serverRunning: false })).toBe(1);
    expect(onboardingRecommendedStep({ serverCount: 1, serverRunning: false })).toBe(3);
    expect(onboardingRecommendedStep({ serverCount: 1, serverRunning: true })).toBe(4);
  });
});
