import { SkeletonBlock } from "./UiPrimitives";

export function ModInstallVersionSkeleton() {
  const rowKeys = ["one", "two", "three"];
  return (
    <div className="modInstallVersionGroups modInstallVersionSkeleton" aria-hidden="true">
      <section className="modInstallVersionGroup">
        <div className="modInstallVersionGroupHeader">
          <strong>Compatible versions</strong>
          <SkeletonBlock className="skeletonCount" />
        </div>
        <div className="modInstallVersionTable">
          <div className="modInstallVersionTableHeader">
            <span>Version</span>
            <span>Minecraft</span>
            <span>Release type</span>
            <span>Published</span>
            <span>Size</span>
            <span>Status</span>
          </div>
          {rowKeys.map((key) => (
            <div key={key} className="modInstallVersionRow">
              <span><i className="skeletonRadio" /><SkeletonBlock /></span>
              <span><SkeletonBlock /></span>
              <span><SkeletonBlock /></span>
              <span><SkeletonBlock /></span>
              <span><SkeletonBlock /></span>
              <span><SkeletonBlock className="skeletonBadge" /></span>
            </div>
          ))}
        </div>
      </section>
      <section className="modInstallVersionGroup">
        <div className="modInstallVersionGroupHeader">
          <strong>Other available versions</strong>
          <SkeletonBlock className="skeletonToggle" />
        </div>
      </section>
    </div>
  );
}
