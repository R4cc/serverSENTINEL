import type { InstalledMod } from "../../types";
import { LoadingLabel, SkeletonBlock } from "../../components/UiPrimitives";
import { getInstalledModHealth } from "./modHealth";

type Props = {
  mods: InstalledMod[];
  loading?: boolean;
};

export function buildModsSummary(mods: InstalledMod[]) {
  const health = mods.map(getInstalledModHealth);
  // Keep the summary aligned with the status badges shown for these same mods.
  // The update plan is loaded independently and can briefly be stale or contain
  // incomplete classifications while the installed-mod list is already current.
  const updates = health.filter((item) => item.hasSafeUpdate || item.hasReviewUpdate).length;
  const attention = health.filter((item) => item.needsAttention).length;

  return [
    { label: "Total mods", value: mods.length, tone: "blue" },
    { label: "Updates", value: updates || "Up to date", tone: "orange" },
    { label: "Needs attention", value: attention || "All clear", tone: "purple" }
  ];
}

export function ModsSummary({ mods, loading = false }: Props) {
  const items = buildModsSummary(mods);
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
