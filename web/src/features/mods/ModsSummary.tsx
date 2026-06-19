import type { InstalledMod, ModUpdatePlan } from "../../types";
import { getInstalledModHealth } from "./modHealth";

type Props = {
  mods: InstalledMod[];
  updatePlan?: ModUpdatePlan | null;
};

export function buildModsSummary(mods: InstalledMod[], updatePlan?: ModUpdatePlan | null) {
  const enabled = mods.filter((mod) => mod.enabled).length;
  const health = mods.map(getInstalledModHealth);
  const safeUpdates = updatePlan?.counts.safeUpdates ?? health.filter((item) => item.hasSafeUpdate).length;
  const reviewUpdates = updatePlan?.counts.reviewUpdates ?? health.filter((item) => item.hasReviewUpdate).length;
  const updates = safeUpdates + reviewUpdates;
  const attention = updatePlan
    ? updatePlan.counts.reviewUpdates + updatePlan.counts.blockedUpdates + updatePlan.counts.unknown
    : health.filter((item) => item.needsAttention).length;

  return [
    { label: "Total mods", value: mods.length, detail: `${enabled} enabled · ${mods.length - enabled} disabled`, tone: "blue" },
    { label: "Updates", value: updates || "Up to date", detail: reviewUpdates ? `${safeUpdates} safe · ${reviewUpdates} need review` : safeUpdates === 1 ? "1 safe update" : safeUpdates ? `${safeUpdates} safe updates` : "No updates available", tone: "orange" },
    { label: "Needs attention", value: attention || "All clear", detail: attention ? "Review recommended" : "No action needed", tone: "purple" }
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
            <span>{item.detail}</span>
          </div>
        </article>
      ))}
    </section>
  );
}
