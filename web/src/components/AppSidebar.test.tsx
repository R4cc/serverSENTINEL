import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoServer } from "../demo";
import { fabricContentTerminology } from "../features/mods/contentTerminology";
import type { ActivePage } from "../types";
import { AppSidebar } from "./AppSidebar";

function renderSidebar(activePage: "nodes" | "overview", withServer = true, availablePages?: (page: ActivePage) => boolean) {
  const activeServer = withServer ? demoServer() : undefined;
  return renderToStaticMarkup(
    <AppSidebar
      sidebarCollapsed={false}
      onToggleCollapsed={vi.fn()}
      sidebarToggleRef={createRef<HTMLButtonElement>()}
      activePage={activePage}
      onNavigate={vi.fn()}
      onPrefetch={vi.fn()}
      isPageAvailable={availablePages ?? (() => true)}
      servers={activeServer ? [activeServer] : []}
      activeServer={activeServer}
      onSelectServer={vi.fn()}
      serverCommandTone="running"
      isProvisioning={false}
      provisioningNavigationReason="Provisioning is in progress"
      serverPageDisabledReason="Select a managed server first"
      supportsManagedMods
      managedContent={fabricContentTerminology}
      demoMode={false}
      panelVersion="1.8.0"
      accountName="Administrator"
      onLogout={vi.fn()}
    />
  );
}

describe("AppSidebar navigation semantics", () => {
  it("marks only the active destination as the current page", () => {
    const html = renderSidebar("overview");

    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page"[^>]*title="Open overview"/);
  });

  it("keeps server destinations disabled until a server is selected", () => {
    const html = renderSidebar("nodes", false);

    expect(html).toMatch(/disabled=""[^>]*title="Select a managed server first"[^>]*>.*Overview/s);
    expect(html).toContain('title="Open nodes"');
  });

  it("leaves out a destination whose optional module this visitor cannot reach", () => {
    const everything = renderSidebar("overview");
    expect(everything).toContain("Schedules");
    expect(everything).toContain("Mods");

    expect(renderSidebar("overview", true, (page) => page !== "schedule")).not.toContain("Schedules");

    // Managed content also needs a runtime that has content to manage, and the two conditions are
    // independent: switching the module off must not take the other module's entry with it.
    const withoutMods = renderSidebar("overview", true, (page) => page !== "mods");
    expect(withoutMods).not.toContain("Mods");
    expect(withoutMods).toContain("Schedules");
  });
});
