import type { InstalledMod, ModUpdatePlan } from "../../types";
import { getInstalledModHealth } from "./modHealth";

type Props = {
  mods: InstalledMod[];
  updatePlan?: ModUpdatePlan | null;
};

export function buildModsSummary(mods: InstalledMod[], updatePlan?: ModUpdatePlan | null) {
  const health = mods.map(getInstalledModHealth);
  const safeUpdates = updatePlan?.counts.safeUpdates ?? health.filter((item) => item.hasSafeUpdate).length;
  const reviewUpdates = updatePlan?.counts.reviewUpdates ?? health.filter((item) => item.hasReviewUpdate).length;
  const updates = safeUpdates + reviewUpdates;
  const attention = updatePlan
    ? updatePlan.counts.reviewUpdates + updatePlan.counts.blockedUpdates + updatePlan.counts.unknown
    : health.filter((item) => item.needsAttention).length;

  return [
    { label: "Total mods", value: mods.length, tone: "blue" },
    { label: "Updates", value: updates || "Up to date", tone: "orange" },
    { label: "Needs attention", value: attention || "All clear", tone: "purple" }
  ];
}

export function ModsSummary({ mods, updatePlan }: Props) {
  const items = buildModsSummary(mods, updatePlan);

  return (
    <section className="modsWorkspaceSummary" aria-label="Mods status summary">
      {items.map((item) => (
        <article key={item.label} className={`modsWorkspaceMetric ${item.tone}`}>
          <span className="modsWorkspaceMetricDot" aria-hidden="true" />
          <div>
            <small>{item.label}</small>
            <strong>{item.value}</strong>
          </div>
        </article>
      ))}
    </section>
  );
}
