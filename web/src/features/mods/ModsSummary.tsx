import type { InstalledMod, ModUpdatePlan } from "../../types";
import { getInstalledModHealth } from "./modHealth";

type Props = {
  mods: InstalledMod[];
  serverRunning: boolean;
  changesAllowed: boolean;
  updatePlan?: ModUpdatePlan | null;
};

export function ModsSummary({ mods, serverRunning, changesAllowed, updatePlan }: Props) {
  const enabled = mods.filter((mod) => mod.enabled).length;
  const health = mods.map(getInstalledModHealth);
  const safeUpdates = updatePlan?.counts.safeUpdates ?? health.filter((item) => item.hasSafeUpdate).length;
  const reviewUpdates = updatePlan?.counts.reviewUpdates ?? health.filter((item) => item.hasReviewUpdate).length;
  const updates = safeUpdates + reviewUpdates;
  const attention = updatePlan
    ? updatePlan.counts.reviewUpdates + updatePlan.counts.blockedUpdates
    : health.filter((item) => item.needsAttention).length;

  const items = [
    { label: "Total mods", value: mods.length, detail: `${enabled} enabled · ${mods.length - enabled} disabled`, tone: "blue" },
    { label: "Updates", value: updates, detail: reviewUpdates ? `${safeUpdates} safe · ${reviewUpdates} need review` : safeUpdates === 1 ? "1 safe update available" : `${safeUpdates} safe updates available`, tone: "orange" },
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
