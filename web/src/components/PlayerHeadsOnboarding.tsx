import { Button } from "./UiPrimitives";
import { DialogSurface } from "./DialogSurface";
import { InlineState } from "./InlineState";

export function PlayerHeadsOnboarding({
  busy,
  error,
  onChoose
}: {
  busy: boolean;
  error: string;
  onChoose(enabled: boolean): void;
}) {
  return (
    <DialogSurface
      backdrop="playerHeadsOnboardingBackdrop"
      dismissible={false}
      className="modalPanel playerHeadsOnboardingModal"
      labelledBy="player-heads-onboarding-title"
      describedBy="player-heads-onboarding-description"
      onClose={() => undefined}
    >
      <header className="modalHeader">
        <div>
          <h2 id="player-heads-onboarding-title">Player heads on Overview</h2>
          <p>Choose whether this instance may use an external avatar service.</p>
        </div>
      </header>
      <div className="modalBody playerHeadsOnboardingBody">
        <p id="player-heads-onboarding-description">
          When enabled, serverSENTINEL sends visible player usernames to <strong>MCHeads (mc-heads.net)</strong> and caches the returned head images.
        </p>
        <p>
          When disabled, no MCHeads requests are made. You can change this later under Settings → Integrations.
        </p>
        <p className="playerHeadsOnboardingFreshness">Cached heads refresh on a rolling daily schedule.</p>
        {error && <InlineState tone="error" title="Could not save this choice" message={error} />}
      </div>
      <footer className="modalFooter">
        <Button variant="secondary" onClick={() => onChoose(false)} disabled={busy}>Keep disabled</Button>
        <Button onClick={() => onChoose(true)} disabled={busy} reserveLabel="Enable player heads">{busy ? "Saving…" : "Enable player heads"}</Button>
      </footer>
    </DialogSurface>
  );
}
