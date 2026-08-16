import { FormEvent, useState } from "react";
import { api } from "../../api";
import type { AppState, Notify, PlayerHeadsState } from "../../types";
import { trimFormValue } from "../../utils/validation";
import { setValidationNotice } from "../../utils/appHelpers";
import type { RequestConfirmation } from "../../components/ConfirmationModal";

/**
 * The panel-level integration settings: the Modrinth API key, the MaxMind credentials that
 * authorize the GeoLite2 download, and the player heads integration. All three write straight to
 * the settings API; player-head responses carry the refreshed state back so no full app refresh is
 * needed. No credential is ever read back — the API only reports whether one is stored.
 */
export function useIntegrationSettings(inputs: {
  canManageIntegrations: boolean;
  playerHeads: PlayerHeadsState;
  setAppState: (update: (current: AppState) => AppState) => void;
  notify: Notify;
  refreshApp: () => Promise<void>;
  requestConfirmation: RequestConfirmation;
}) {
  const { canManageIntegrations, playerHeads, setAppState, notify, refreshApp, requestConfirmation } = inputs;
  const [playerHeadsBusy, setPlayerHeadsBusy] = useState(false);
  const [modrinthBusy, setModrinthBusy] = useState(false);
  const [maxmindBusy, setMaxmindBusy] = useState(false);
  const [playerHeadsOnboardingError, setPlayerHeadsOnboardingError] = useState("");

  async function updateModrinthKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageIntegrations || modrinthBusy) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const key = trimFormValue(form, "modrinthApiKey");
    if (setValidationNotice(formElement, key ? [] : [{ field: "modrinthApiKey", message: "Modrinth API key is required." }], (message) => notify("error", message))) return;
    setModrinthBusy(true);
    try {
      await api("/api/settings/modrinth", {
        method: "PUT",
        body: JSON.stringify({ modrinthApiKey: key })
      });
      formElement.reset();
      notify("success", "Modrinth API key saved");
      await refreshApp();
    } catch (error) {
      notify("error", (error as Error).message);
    } finally {
      setModrinthBusy(false);
    }
  }

  /**
   * The MaxMind account that authorizes the GeoLite2 download. Both halves are submitted together
   * because MaxMind authenticates with the pair, and neither is ever read back: the API reports
   * only whether a pair is stored.
   */
  async function updateMaxmindCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageIntegrations || maxmindBusy) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const accountId = trimFormValue(form, "maxmindAccountId");
    const licenseKey = trimFormValue(form, "maxmindLicenseKey");
    const problems = [
      ...(accountId ? [] : [{ field: "maxmindAccountId", message: "MaxMind account ID is required." }]),
      ...(licenseKey ? [] : [{ field: "maxmindLicenseKey", message: "MaxMind license key is required." }])
    ];
    if (setValidationNotice(formElement, problems, (message) => notify("error", message))) return;
    setMaxmindBusy(true);
    try {
      await api("/api/settings/maxmind", {
        method: "PUT",
        body: JSON.stringify({ accountId, licenseKey })
      });
      formElement.reset();
      notify("success", "MaxMind credentials saved");
      await refreshApp();
    } catch (error) {
      notify("error", (error as Error).message);
    } finally {
      setMaxmindBusy(false);
    }
  }

  /**
   * `onboarding` routes the failure into the onboarding prompt instead of a
   * toast, so the first-run chooser can show the error inline and stay open.
   */
  async function updatePlayerHeads(enabled: boolean, onboarding = false) {
    if (!canManageIntegrations || playerHeadsBusy) return false;
    setPlayerHeadsBusy(true);
    if (onboarding) setPlayerHeadsOnboardingError("");
    try {
      const result = await api<{ playerHeads: AppState["playerHeads"] }>("/api/settings/player-heads", {
        method: "PUT",
        body: JSON.stringify({ enabled })
      });
      setAppState((current) => ({ ...current, playerHeads: result.playerHeads }));
      setPlayerHeadsOnboardingError("");
      notify("success", enabled ? "Player heads enabled" : "Player heads disabled");
      return true;
    } catch (error) {
      const message = (error as Error).message;
      if (onboarding) setPlayerHeadsOnboardingError(message);
      else notify("error", message);
      return false;
    } finally {
      setPlayerHeadsBusy(false);
    }
  }

  async function clearPlayerHeadCache() {
    if (!canManageIntegrations || playerHeadsBusy || playerHeads.cacheEntries === 0) return;
    const confirmed = await requestConfirmation({
      title: "Clear cached player heads?",
      description: "This removes every player-head image cached by this instance.",
      warning: playerHeads.enabled
        ? "Player heads are enabled, so images will be downloaded again as players appear on Overview."
        : "The integration remains disabled and no new images will be requested.",
      confirmLabel: "Clear cache",
      cancelLabel: "Keep cache",
      variant: "critical"
    });
    if (!confirmed) return;
    setPlayerHeadsBusy(true);
    try {
      const result = await api<{ playerHeads: AppState["playerHeads"] }>("/api/settings/player-heads/cache", { method: "DELETE" });
      setAppState((current) => ({ ...current, playerHeads: result.playerHeads }));
      notify("success", "Player head cache cleared");
    } catch (error) {
      notify("error", (error as Error).message);
    } finally {
      setPlayerHeadsBusy(false);
    }
  }

  return {
    playerHeadsBusy,
    integrationBusy: playerHeadsBusy || modrinthBusy || maxmindBusy,
    playerHeadsOnboardingError,
    updateModrinthKey,
    updateMaxmindCredentials,
    updatePlayerHeads,
    clearPlayerHeadCache
  };
}
