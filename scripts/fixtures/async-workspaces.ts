import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { useModsWorkspace } from "../../web/src/features/mods/useModsWorkspace";
import { useNodesWorkspace } from "../../web/src/features/nodes/useNodesWorkspace";

// Real hooks and React lifecycle, with requests resolved explicitly by the browser smoke.
const pending: Array<{ path: string; method: string; resolve: (response: Response) => void }> = [];
window.fetch = (path, init) => new Promise((resolve) => {
  pending.push({ path: String(path), method: init?.method ?? "GET", resolve });
});
const noop = () => {};
const refresh = async () => {};
const target = window as any;
target.pending = pending;
target.reply = (index: number, body: unknown, status = 200) => pending[index].resolve(new Response(JSON.stringify(body), { status }));

function Harness() {
  const [id, setId] = useState("A");
  const mods = useModsWorkspace({
    activeServer: { id, displayName: id, runtimeProfile: { runtimeType: "fabric" } } as any,
    activePage: "mods", activeServerIsDemo: false, activeServerUsesInternalNode: true,
    activeNodeRuntimeBlocked: false, activeNodeBlockMessage: "", demoMode: false,
    demoInstalledMods: [], setDemoInstalledMods: noop, modrinthConfigured: false,
    isProvisioning: false, canManage: true, canInstall: true, modsLocked: false,
    toggleLocked: false, notify: noop, setNotice: noop, setActiveJobs: noop,
    handleStaleSession: () => false, refreshFiles: refresh, refreshServerState: refresh,
    requestConfirmation: async () => true
  });
  const nodes = useNodesWorkspace({
    contextNodes: [], panelVersion: "test", demoMode: false, canManageNodes: true,
    currentPanelUrl: () => location.origin, notify: noop,
    requestConfirmation: async () => true, refreshApp: refresh
  });
  target.mods = mods;
  target.nodes = nodes;
  target.selectServer = setId;
  return createElement("pre", { id: "state" }, JSON.stringify({
    server: id, mods: mods.data.installedMods, loading: mods.state.modsLoading,
    selectedNode: nodes.selectedNode, busyNodeId: nodes.busyNodeId, busy: nodes.busy,
    install: nodes.installResult
  }));
}
const root = createRoot(document.getElementById("root")!);
target.unmount = () => root.unmount();
root.render(createElement(Harness));
