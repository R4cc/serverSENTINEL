import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoServer } from "../demo";
import { fabricContentTerminology } from "../features/mods/contentTerminology";
import type { ActivePage } from "../types";
import { webModules } from "../app/moduleRegistry";
import { AppSidebar } from "./AppSidebar";

function renderSidebar(activePage: "nodes" | "overview", withServer = true, availablePages?: (page: ActivePage) => boolean, nodeUpdateNames: string[] = [], account: { demoMode?: boolean; accountName?: string } = {}) {
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
      demoMode={account.demoMode ?? false}
      panelVersion="1.8.0"
      nodeUpdateNames={nodeUpdateNames}
      accountName={"accountName" in account ? account.accountName : "Administrator"}
      onLogout={vi.fn()}
    />
  );
}

describe("AppSidebar navigation semantics", () => {
  it("shows a named update indicator and describes it to keyboard and screen-reader users", () => {
    const html = renderSidebar("overview", true, undefined, ["Alpha", "Beta"]);
    expect(html).toContain('class="sidebarNodeUpdateDot" title="Update available for nodes: Alpha, Beta"');
    expect(html).toMatch(/data-nav-page="nodes"[^>]*aria-describedby="[^"]+"/);
    expect(html).toContain('class="srOnly">Update available for nodes: Alpha, Beta</span>');
  });

  it("omits the update dot and its description when every node is current", () => {
    const html = renderSidebar("nodes");
    expect(html).not.toContain("sidebarNodeUpdateDot");
    expect(html).not.toContain("aria-describedby");
  });

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

  // Driven by the registry rather than a list of names, so a module added without its availability
  // check in the sidebar fails here instead of quietly offering a destination nobody can open.
  it("offers a module destination only while that module is reachable", () => {
    const everything = renderSidebar("overview");
    for (const module of webModules) {
      expect(everything, module.id).toContain(`data-nav-page="${module.page}"`);
    }

    for (const module of webModules) {
      const html = renderSidebar("overview", true, (page) => page !== module.page);
      expect(html, module.id).not.toContain(`data-nav-page="${module.page}"`);
      // Only that module's entry goes: one module's state says nothing about another's.
      for (const other of webModules.filter((candidate) => candidate.page !== module.page)) {
        expect(html, `${module.id} -> ${other.id}`).toContain(`data-nav-page="${other.page}"`);
      }
      // Core destinations are never touched by a module being unavailable.
      for (const page of ["overview", "console", "files", "properties", "nodes", "settings"]) {
        expect(html, `${module.id} -> ${page}`).toContain(`data-nav-page="${page}"`);
      }
    }
  });
});

describe("AppSidebar layout", () => {
  it("groups the server pages under a label instead of divider rules", () => {
    const html = renderSidebar("overview");
    expect(html).not.toContain("sidebarDivider");
    expect(html).toMatch(/class="sidebarSectionLabel"[^>]*>Server</);
    // The label names the group, so the switcher no longer repeats it as an eyebrow.
    expect(html).not.toContain("Managed server");
  });

  it("shows the panel version as plain text beside Settings", () => {
    expect(renderSidebar("overview")).toContain('class="settingsVersionText">v1.8.0</span>');
  });

  it("identifies the account by its initial", () => {
    expect(renderSidebar("overview")).toMatch(/class="accountIcon" aria-hidden="true">A</);
    expect(renderSidebar("overview", true, undefined, [], { accountName: "  bob" })).toMatch(/class="accountIcon" aria-hidden="true">B</);
    expect(renderSidebar("overview", true, undefined, [], { demoMode: true })).toMatch(/class="accountIcon" aria-hidden="true">D</);
    expect(renderSidebar("overview", true, undefined, [], { accountName: undefined })).toMatch(/class="accountIcon" aria-hidden="true">A</);
  });
});
