import { useState } from "react";
import { moduleDescriptor } from "@serversentinel/contracts";
import { api } from "../../api";
import type { AppState, ModuleAccessState, ModuleId, Notify } from "../../types";
import type { RequestConfirmation } from "../../components/ConfirmationModal";
import { errorMessage } from "../../utils/appHelpers";

/**
 * The installation-wide switch for an optional module. Turning one off stops its background work
 * and closes its endpoints for everyone, so it is confirmed first and the effect is spelled out;
 * turning one on is reversible and applies immediately.
 *
 * The response carries the refreshed catalog back, so the shell learns which modules it may load
 * without a full app refresh.
 */
export function useModuleSettings(inputs: {
  canManage: boolean;
  setAppState: (update: (current: AppState) => AppState) => void;
  notify: Notify;
  requestConfirmation: RequestConfirmation;
}) {
  const [busy, setBusy] = useState(false);

  async function setModuleEnabled(id: ModuleId, enabled: boolean) {
    if (!inputs.canManage || busy) return false;
    const descriptor = moduleDescriptor(id);
    if (!enabled) {
      const confirmed = await inputs.requestConfirmation({
        title: `Disable ${descriptor.label}?`,
        description: "This applies to the whole installation, not just your account.",
        warning: descriptor.disabledEffect,
        confirmLabel: `Disable ${descriptor.label}`,
        cancelLabel: "Keep enabled",
        variant: "critical"
      });
      if (!confirmed) return false;
    }
    setBusy(true);
    try {
      const result = await api<{ modules: ModuleAccessState[] }>(`/api/modules/${id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled })
      });
      inputs.setAppState((current) => ({ ...current, modules: result.modules }));
      inputs.notify("success", `${descriptor.label} ${enabled ? "enabled" : "disabled"}`);
      return true;
    } catch (error) {
      inputs.notify("error", errorMessage(error, `Could not ${enabled ? "enable" : "disable"} ${descriptor.label}.`));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { modulesBusy: busy, setModuleEnabled };
}
