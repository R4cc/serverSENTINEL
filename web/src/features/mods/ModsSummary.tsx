import type { InstalledMod } from "../../types";
import { installedModStatus, installedModUpdateState } from "./modStatus";

type Props = {
  mods: InstalledMod[];
  serverRunning: boolean;
  changesAllowed: boolean;
};

export function ModsSummary({ mods, serverRunning, changesAllowed }: Props) {
  const enabled = mods.filter((mod) => mod.enabled).length;
  const updates = mods.filter((mod) => installedModUpdateState(mod) === "available").length;
  const attention = mods.filter((mod) => {
    const status = installedModStatus(mod).key;
    return status === "review" || status === "not-recommended";
  }).length;

  const items = [
    { label: "Total mods", value: mods.length, detail: `${enabled} enabled · ${mods.length - enabled} disabled`, tone: "blue" },
    { label: "Updates", value: updates, detail: updates === 1 ? "Safe update available" : "Safe updates available", tone: "orange" },
    { label: "Needs attention", value: attention, detail: attention ? "Review recommended" : "Setup looks healthy", tone: "purple" },
    { label: "Mod changes", value: serverRunning ? "Locked" : changesAllowed ? "Enabled" : "Unavailable", detail: serverRunning ? "Stop server required" : changesAllowed ? "Changes allowed" : "Check permissions", tone: serverRunning ? "orange" : "green" }
  ];

  return (
    <section className="modsWorkspaceSummary" aria-label="Mods status summary">
      {items.map((item) => (
        <article key={item.label} className={`modsWorkspaceMetric ${item.tone}`}>
          <span className="modsWorkspaceMetricDot" aria-hidden="true" />
          <div>
            <small>{item.label}</small>
            <strong>{item.value}</strong>
            <span>{item.detail}</span>
          </div>
        </article>
      ))}
    </section>
  );
}
