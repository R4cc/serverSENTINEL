import type { ServerStatus } from '../types';
import { Play, RotateCw, Square } from 'lucide-react';
import { Button, Spinner } from './UiPrimitives';

export function RuntimeControlIcon({ action }: { action: "start" | "stop" | "restart" }) {
  if (action === "start") {
    return <Play className="buttonIcon controlGlyphSVG controlGlyph-start" fill="currentColor" aria-hidden="true" />;
  }
  if (action === "stop") {
    return <Square className="buttonIcon controlGlyphSVG controlGlyph-stop" fill="currentColor" aria-hidden="true" />;
  }
  return <RotateCw className="buttonIcon controlGlyphSVG controlGlyph-restart" strokeWidth={2.5} aria-hidden="true" />;
}

export function RuntimeControls({
  status,
  isProvisioning,
  controlAvailableFallback = false,
  disabledReason,
  startupDisabledReason,
  busyAction,
  onAction,
  className = ""
}: {
  status: ServerStatus | null;
  isProvisioning: boolean;
  controlAvailableFallback?: boolean;
  disabledReason?: string;
  startupDisabledReason?: string;
  busyAction: "start" | "stop" | "restart" | null;
  onAction: (action: "start" | "stop" | "restart") => void;
  className?: string;
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
    <div
      className={`runtimeControls ${className}`.trim()}
      // A plain `div` is a generic container, and assistive technology drops the
      // accessible name off one -- so without the role the label was never read.
      role="group"
      aria-label="Container controls"
      aria-busy={Boolean(busyAction)}
      data-busy-action={busyAction || undefined}
    >
      {([mainAction, "restart"] as const).map((action) => {
        const startupBlocked = action !== "stop" && Boolean(startupDisabledReason);
        const actionDisabled = disabled || startupBlocked || (action === "restart" && !isRunning);
        const actionReason = startupBlocked
          ? startupDisabledReason
          : action === "restart" && !isRunning
            ? "Start the server before restarting it."
            : baseDisabledReason;
        return (
          <Button
            key={action}
            variant={action === "stop" ? "critical" : action === "restart" ? "secondary" : "primary"}
            className={`runtimeControlButton ${action}`}
            data-action={action}
            data-busy={busyAction === action || undefined}
            onClick={() => onAction(action)}
            disabled={actionDisabled}
            title={actionDisabled ? actionReason : `${actionLabel(action)} server`}
            aria-label={actionDisabled && actionReason ? `${actionLabel(action)} unavailable: ${actionReason}` : actionLabel(action)}
          >
            {busyAction === action ? <Spinner size="sm" tone="current" /> : <RuntimeControlIcon action={action} />}
            <span>{actionLabel(action)}</span>
          </Button>
        );
      })}
    </div>
  );
}
