import type { InstalledMod, ModUpdatePlan } from "../../types";
import { LoadingLabel, MetricTile, SkeletonBlock } from "../../components/UiPrimitives";
import { getInstalledModHealth } from "./modHealth";
import { updatePlanEntryForMod } from "./modUpdatePlan";
import { fabricContentTerminology, type ManagedContentTerminology } from "./contentTerminology";

type Props = {
  mods: InstalledMod[];
  updatePlan: ModUpdatePlan | null;
  loading?: boolean;
  terminology?: ManagedContentTerminology;
};

export function buildModsSummary(mods: InstalledMod[], updatePlan: ModUpdatePlan | null = null, terminology: ManagedContentTerminology = fabricContentTerminology) {
  const health = mods.map((mod) => getInstalledModHealth(mod, terminology));
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

export function ModsSummary({ mods, updatePlan, loading = false, terminology = fabricContentTerminology }: Props) {
  const items = buildModsSummary(mods, updatePlan, terminology);
  items[0] = { ...items[0], label: `Total ${terminology.plural}` };
  const initialLoading = loading && mods.length === 0;

  return (
    <section className="modsWorkspaceSummary" aria-label={`${terminology.pluralTitle} status summary`} aria-busy={initialLoading}>
      {initialLoading && <LoadingLabel>Loading {terminology.plural} summary</LoadingLabel>}
      {items.map((item) => (
        <MetricTile
          key={item.label}
          className={`modsWorkspaceMetric ${item.tone}`}
          tone={item.tone === "orange" ? "warning" : item.tone === "green" ? "success" : item.tone === "purple" ? "accent" : "neutral"}
          label={item.label}
          value={initialLoading ? <SkeletonBlock className="modsMetricValueSkeleton" /> : item.value}
        />
      ))}
    </section>
  );
}
