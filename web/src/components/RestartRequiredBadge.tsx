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

export function RestartRequiredBadge({ changes = [], runtimeType = "fabric", stopped = false }: {
  changes?: RestartRequiredChange[];
  runtimeType?: ServerRuntimeType;
  /** A stopped server picks the changes up when it next starts, so there is nothing to restart. */
  stopped?: boolean;
}) {
  const tooltipId = useId();
  const contentLabel = runtimeType === "paper" ? "Plugins" : "Mods";
  return (
    <span className="restartRequirement">
      <StatusBadge tone={stopped ? "neutral" : "warning"} className="restartRequirementBadge" tabIndex={0} aria-describedby={tooltipId}>
        {stopped ? "Applies on start" : "Restart required"}
      </StatusBadge>
      <span className="restartRequirementTooltip" id={tooltipId} role="tooltip">
        <strong>{contentLabel} have changed.</strong>
        <span>{stopped ? "The changes apply when the server next starts." : "Restart the server to apply the changes."}</span>
        {changes.length > 0 && (
          <ul>
            {changes.map((change) => <li key={`${change.identity}:${change.action}`}><b>{actionLabels[change.action]}:</b> {change.displayName}</li>)}
          </ul>
        )}
      </span>
    </span>
  );
}
