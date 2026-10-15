import React, { createRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppSidebar } from "../../web/src/components/AppSidebar";
import { AppToaster } from "../../web/src/components/AppToaster";
import { fabricContentTerminology } from "../../web/src/features/mods/contentTerminology";
import { useNodeUpdateVisitNotification } from "../../web/src/features/nodes/useNodeUpdateVisitNotification";
import { nodesWithAvailableUpdates } from "../../web/src/utils/nodeUpdates";
import { appVersion } from "../../web/src/app/appConfig";
import type { ActivePage, NodeView } from "../../web/src/types";

const alpha: NodeView = { id: "alpha", name: "Alpha", type: "remote", status: "online", isInternal: false, agentVersion: "1.0.0", buildId: "old" };
const target = window as typeof window & { nodeUpdateInitialMultiple?: boolean; nodeUpdates: Record<string, unknown> };

function Fixture() {
  const [nodes, setNodes] = useState(target.nodeUpdateInitialMultiple ? [alpha, { ...alpha, id: "beta", name: "Beta" }] : [alpha]);
  const [collapsed, setCollapsed] = useState(false);
  const [page, setPage] = useState<ActivePage>("overview");
  const [selection, setSelection] = useState("");
  target.nodeUpdates = {
    setNodes, setCollapsed,
    current: () => setNodes([{ ...alpha, agentVersion: appVersion, buildId: "panel-build" }])
  };
  useNodeUpdateVisitNotification({ ready: true, demoMode: false, nodes, panelVersion: appVersion, panelBuildId: "panel-build",
    onReviewNodes: id => {
      setPage("nodes"); setSelection(id ?? "fleet");
      if (innerWidth <= 1100) setCollapsed(true);
    }
  });
  return <>
    <AppToaster darkMode={document.documentElement.classList.contains("themeDark")} />
    <main className={`appShell ${collapsed ? "sidebarCollapsed" : ""} ${innerWidth <= 720 && !collapsed ? "mobileNavigationOpen" : ""}`}>
      <AppSidebar sidebarCollapsed={collapsed} onToggleCollapsed={() => setCollapsed(value => !value)} sidebarToggleRef={createRef()}
        activePage={page} onNavigate={setPage} onPrefetch={() => {}} isPageAvailable={() => true}
        servers={[]} activeServer={undefined} onSelectServer={() => {}} serverCommandTone="running"
        isProvisioning={false} provisioningNavigationReason="" serverPageDisabledReason="Select a server"
        supportsManagedMods={false} managedContent={fabricContentTerminology} demoMode={false}
        panelVersion={appVersion} nodeUpdateNames={nodesWithAvailableUpdates(nodes, appVersion, "panel-build").map(node => node.name)}
        accountName="demo" onLogout={() => {}} />
      <section className="workspace">
        <output id="node-update-selection">{page}:{selection}</output>
      </section>
    </main>
  </>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
