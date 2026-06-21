import type { ServerStatus } from '../types';
import { Button } from './UiPrimitives';

export function ControlIcon({ action }: { action: "start" | "stop" | "restart" }) {
  if (action === "start") {
    return (
      <svg className="buttonIcon controlGlyphSVG" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M8 5v14l11-7z" />
      </svg>
    );
  }
  if (action === "stop") {
    return (
      <svg className="buttonIcon controlGlyphSVG" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M6 6h12v12H6z" />
      </svg>
    );
  }
  return (
    <svg className="buttonIcon controlGlyphSVG" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 2v6h-6" />
      <path d="M21 13a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
    </svg>
  );
}

export function RuntimeControls({
  status,
  isProvisioning,
  controlAvailableFallback = false,
  disabledReason,
  busyAction,
  onAction
}: {
  status: ServerStatus | null;
  isProvisioning: boolean;
  controlAvailableFallback?: boolean;
  disabledReason?: string;
  busyAction: "start" | "stop" | "restart" | null;
  onAction: (action: "start" | "stop" | "restart") => void;
}) {
  const controlAvailable = status?.controlAvailable ?? controlAvailableFallback;
  const disabled = isProvisioning || Boolean(busyAction) || !controlAvailable;
  const isRunning = Boolean(status && status.docker.running);
  const mainAction = isRunning ? "stop" : "start";
  const baseDisabledReason = busyAction
    ? `Runtime ${busyAction} is already in progress.`
    : disabledReason || (!controlAvailable ? status?.docker.message || "Runtime controls are unavailable for this server." : "");
  const actionLabel = (action: "start" | "stop" | "restart") => `${action[0].toUpperCase()}${action.slice(1)}`;

  return (
    <div className="runtimeControls" aria-label="Container controls">
      {([mainAction, "restart"] as const).map((action) => {
        const actionDisabled = disabled || (action === "restart" && !isRunning);
        const actionReason = action === "restart" && !isRunning
          ? "Start the server before restarting it."
          : baseDisabledReason;
        return (
          <Button
            key={action}
            variant={action === "stop" ? "critical" : action === "restart" ? "secondary" : "primary"}
            className={`runtimeControlButton ${action}`}
            onClick={() => onAction(action)}
            disabled={actionDisabled}
            title={actionDisabled ? actionReason : `${actionLabel(action)} server`}
            aria-label={actionDisabled && actionReason ? `${actionLabel(action)} unavailable: ${actionReason}` : actionLabel(action)}
          >
            {busyAction === action ? <span className="buttonSpinner" aria-hidden="true" /> : <ControlIcon action={action} />}
            <span>{actionLabel(action)}</span>
          </Button>
        );
      })}
    </div>
  );
}
