import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { useExportWorkspace } from "../../web/src/features/exports/useExportWorkspace";

const target = window as any;
const pending: Array<{ path: string; method: string; resolve: (response: Response) => void }> = [];
window.fetch = (path, init) => new Promise((resolve) => {
  pending.push({ path: String(path), method: init?.method ?? "GET", resolve });
});
target.pending = pending;
target.reply = (index: number, body: unknown, status = 200) => pending[index].resolve(new Response(JSON.stringify(body), { status }));
const noop = () => {};
const confirm = () => new Promise<boolean>((resolve) => { target.confirm = resolve; });
function Harness() {
  const [id, setId] = useState("A");
  const [enabled, setEnabled] = useState(true);
  const exports = useExportWorkspace(noop, id, enabled, confirm);
  target.exports = exports;
  target.selectServer = setId;
  target.setEnabled = setEnabled;
  return createElement("pre", { id: "state" }, JSON.stringify({
    server: id, data: exports.serverExportState, loading: exports.serverExportStateLoading,
    error: exports.serverExportStateError, locked: exports.exportMutationLocked,
    busy: exports.exportBusy, deleting: exports.deletingExportId, open: exports.exportOpen
  }));
}
const root = createRoot(document.getElementById("root")!);
target.unmount = () => root.unmount();
root.render(createElement(Harness));
