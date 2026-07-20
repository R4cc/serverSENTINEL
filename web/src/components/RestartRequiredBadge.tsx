import { useId } from "react";
import type { ServerRuntimeType } from "@serversentinel/contracts";
import type { RestartRequiredChange } from "../types";
import { StatusBadge } from "./UiPrimitives";

const actionLabels: Record<RestartRequiredChange["action"], string> = {
  added: "Added",
  removed: "Removed",
  enabled: "Enabled",
  disabled: "Disabled",
  updated: "Updated"
};

export function RestartRequiredBadge({ changes = [], runtimeType = "fabric" }: { changes?: RestartRequiredChange[]; runtimeType?: ServerRuntimeType }) {
  const tooltipId = useId();
  const contentLabel = runtimeType === "paper" ? "Plugins" : "Mods";
  return (
    <span className="restartRequirement">
      <StatusBadge tone="warning" className="restartRequirementBadge" tabIndex={0} aria-describedby={tooltipId}>
        Restart required
      </StatusBadge>
      <span className="restartRequirementTooltip" id={tooltipId} role="tooltip">
        <strong>{contentLabel} have changed.</strong>
        <span>Restart the server to apply the changes.</span>
        {changes.length > 0 && (
          <ul>
            {changes.map((change) => <li key={`${change.identity}:${change.action}`}><b>{actionLabels[change.action]}:</b> {change.displayName}</li>)}
          </ul>
        )}
      </span>
    </span>
  );
}
