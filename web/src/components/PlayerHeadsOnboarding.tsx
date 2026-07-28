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
          When enabled, serverSENTINEL sends usernames shown in the active-player roster and retained player timeline from this panel host to <strong>MCHeads (mc-heads.net)</strong> and caches the returned skin-head images. MCHeads does not require an API key.
        </p>
        <p>
          Keeping it disabled leaves Overview player names without skin heads and sends no requests, health checks, or other traffic to MCHeads. You can change this global choice later under Settings → Integrations.
        </p>
        <p className="playerHeadsOnboardingFreshness">Skin changes appear over time: serverSENTINEL rechecks every 12 hours, while MCHeads documents a skin cache of up to 24 hours.</p>
        {error && <InlineState tone="error" title="Could not save this choice" message={error} />}
      </div>
      <footer className="modalFooter">
        <Button variant="secondary" onClick={() => onChoose(false)} disabled={busy}>Keep disabled</Button>
        <Button onClick={() => onChoose(true)} disabled={busy} reserveLabel="Enable player heads">{busy ? "Saving…" : "Enable player heads"}</Button>
      </footer>
    </DialogSurface>
  );
}
