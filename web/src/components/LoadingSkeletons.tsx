import { LoadingLabel, SkeletonBlock } from "./UiPrimitives";
import { BrandLogo } from "./BrandLogo";

export function AuthLoadingSkeleton() {
  return (
    <main className="authShell">
      <section className="authPanel authLoadingSkeleton" aria-busy="true">
        <LoadingLabel>Checking session</LoadingLabel>
        <div className="brandLockup" aria-hidden="true">
          <BrandLogo />
          <div><SkeletonBlock className="authSkeletonTitle" /><SkeletonBlock className="authSkeletonSubtitle" /></div>
        </div>
        <div className="authSkeletonFields" aria-hidden="true">
          <SkeletonBlock className="authSkeletonLabel" /><SkeletonBlock className="authSkeletonInput" />
          <SkeletonBlock className="authSkeletonLabel" /><SkeletonBlock className="authSkeletonInput" />
          <SkeletonBlock className="authSkeletonButton" />
        </div>
      </section>
    </main>
  );
}

export function ApplicationLoadingSkeleton() {
  return (
    <section className="applicationLoadingSkeleton" aria-busy="true">
      <LoadingLabel>Loading application</LoadingLabel>
      <div className="applicationSkeletonSummary" aria-hidden="true">
        {Array.from({ length: 3 }, (_, index) => <SkeletonBlock className="applicationSkeletonTile" key={index} />)}
      </div>
      <div className="applicationSkeletonPanel" aria-hidden="true">
        <SkeletonBlock className="applicationSkeletonHeading" />
        {Array.from({ length: 6 }, (_, index) => <SkeletonBlock className="applicationSkeletonRow" key={index} style={{ width: `${88 - (index % 3) * 9}%` }} />)}
      </div>
    </section>
  );
}

export function CodeLoadingSkeleton({ label = "Loading content" }: { label?: string }) {
  return (
    <div className="codeLoadingSkeleton" aria-busy="true">
      <LoadingLabel>{label}</LoadingLabel>
      <div aria-hidden="true">
        {Array.from({ length: 12 }, (_, index) => <SkeletonBlock className="codeSkeletonLine" key={index} style={{ width: `${45 + (index * 23) % 50}%` }} />)}
      </div>
    </div>
  );
}

export function TerminalLoadingSkeleton() {
  return (
    <div className="terminalLoadingSkeleton" aria-busy="true">
      <LoadingLabel>Connecting to live console</LoadingLabel>
      <div aria-hidden="true">
        {Array.from({ length: 10 }, (_, index) => <SkeletonBlock className="terminalSkeletonLine" key={index} style={{ width: `${38 + (index * 29) % 56}%` }} />)}
      </div>
    </div>
  );
}
