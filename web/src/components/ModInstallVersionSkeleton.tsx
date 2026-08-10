import { SkeletonBlock } from "./UiPrimitives";

/**
 * Stands in for the version step while Modrinth is being asked what it has.
 *
 * It mirrors the two blocks that step actually renders — the recommended release and
 * the advanced-options disclosure — rather than a shape of its own, so the panel does
 * not jump when the answer lands.
 */
export function ModInstallVersionSkeleton() {
  return (
    <div className="modInstallVersionSkeleton" aria-hidden="true">
      <div className="modsRecommendedVersion">
        <div>
          <SkeletonBlock className="modInstallSkeletonEyebrow" />
          <SkeletonBlock className="modInstallSkeletonVersion" />
          <SkeletonBlock className="modInstallSkeletonNote" />
        </div>
        <SkeletonBlock className="modInstallSkeletonButton" />
      </div>
      <div className="modsAdvancedOptions">
        <SkeletonBlock className="modInstallSkeletonSummary" />
      </div>
    </div>
  );
}
