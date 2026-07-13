import type { InstalledMod, ModUpdatePlan } from "../../types";
import { LoadingLabel, SkeletonBlock } from "../../components/UiPrimitives";
import { getInstalledModHealth } from "./modHealth";
import { updatePlanEntryForMod } from "./modUpdatePlan";

type Props = {
  mods: InstalledMod[];
  updatePlan: ModUpdatePlan | null;
  loading?: boolean;
};

export function buildModsSummary(mods: InstalledMod[], updatePlan: ModUpdatePlan | null = null) {
  const health = mods.map(getInstalledModHealth);
  // The update plan is the authoritative result of an update check. Installed-mod
  // metadata may come from a separate cache and omit latest-version information
  // after returning to this page. Fall back to that metadata only for mods that
  // are not represented in the current plan.
  const updates = mods.filter((mod, index) => {
    const plannedStatus = updatePlanEntryForMod(updatePlan, mod)?.status;
    return plannedStatus
      ? plannedStatus === "safe_update" || plannedStatus === "needs_review"
      : health[index].hasSafeUpdate || health[index].hasReviewUpdate;
  }).length;
  const attention = health.filter((item) => item.needsAttention).length;

  return [
    { label: "Total mods", value: mods.length, tone: "blue" },
    { label: "Updates", value: updates || "Up to date", tone: updates > 0 ? "orange" : "green" },
    { label: "Needs attention", value: attention || "All clear", tone: "purple" }
  ];
}

export function ModsSummary({ mods, updatePlan, loading = false }: Props) {
  const items = buildModsSummary(mods, updatePlan);
  const initialLoading = loading && mods.length === 0;

  return (
    <section className="modsWorkspaceSummary" aria-label="Mods status summary" aria-busy={initialLoading}>
      {initialLoading && <LoadingLabel>Loading mods summary</LoadingLabel>}
      {items.map((item) => (
        <article key={item.label} className={`modsWorkspaceMetric ${item.tone}`}>
          <span className="modsWorkspaceMetricDot" aria-hidden="true" />
          <div>
            <small>{item.label}</small>
            <strong>{initialLoading ? <SkeletonBlock className="modsMetricValueSkeleton" /> : item.value}</strong>
          </div>
        </article>
      ))}
    </section>
  );
}
