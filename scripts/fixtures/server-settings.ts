import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ServerRuntimeType } from "@serversentinel/contracts";
import { useJavaMemory, useMinecraftVersions, useRuntimeVersions } from "../../web/src/pages/useServerSettings";

const target = window as any;
const pending: Array<{ path: string; resolve: (response: Response) => void }> = [];
window.fetch = (path) => new Promise((resolve) => pending.push({ path: String(path), resolve }));
target.pending = pending;
target.reply = (index: number, body: unknown, status = 200) => pending[index].resolve(new Response(JSON.stringify(body), { status }));
function Harness() {
  const [runtime, setRuntime] = useState<ServerRuntimeType>("fabric");
  const [minecraft, setMinecraft] = useState("1.21.4");
  const [max, setMax] = useState(16);
  const bounds = { min: 1, max, recommendedMin: 2, recommendedMax: 8 };
  const create = useJavaMemory(bounds, { min: 2, max: 8, args: "-Xms2G -Xmx8G" }, true);
  const edit = useJavaMemory(bounds, { min: 2, max: 4, args: "-Xms2G -Xmx4G -XX:+UseG1GC" });
  const versions = useMinecraftVersions(runtime);
  const builds = useRuntimeVersions(runtime, minecraft);
  const editBuilds = useRuntimeVersions(runtime, minecraft, true);
  Object.assign(target, { create, edit, setMax, setRuntime, setMinecraft });
  return createElement("pre", { id: "state" }, JSON.stringify({ create, edit, versions, builds, editBuilds }));
}
createRoot(document.getElementById("root")!).render(createElement(Harness));
