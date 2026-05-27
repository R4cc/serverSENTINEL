import type { ServerStatus } from '../types';

export function ControlIcon({ action }: { action: "start" | "stop" | "restart" }) {
  if (action === "start") {
    return <span className="controlGlyph play" aria-hidden="true" />;
  }
  if (action === "stop") {
    return <span className="controlGlyph stop" aria-hidden="true" />;
  }
  return <span className="controlGlyph restart" aria-hidden="true" />;
}

export function RuntimeControls({
  status,
  isProvisioning,
  controlAvailableFallback = false,
  busyAction,
  onAction
}: {
  status: ServerStatus | null;
  isProvisioning: boolean;
  controlAvailableFallback?: boolean;
  busyAction: "start" | "stop" | "restart" | null;
  onAction: (action: "start" | "stop" | "restart") => void;
}) {
  const controlAvailable = status?.controlAvailable ?? controlAvailableFallback;
  const disabled = isProvisioning || Boolean(busyAction) || !controlAvailable;
  return (
    <div className="runtimeControls" aria-label="Container controls">
      {(["start", "stop", "restart"] as const).map((action) => {
        const actionDisabled = disabled
          || Boolean(status && action === "start" && status.docker.running)
          || Boolean(status && action === "stop" && !status.docker.running);
        return (
          <button
            key={action}
            type="button"
            className={`runtimeControlButton ${action}`}
            onClick={() => onAction(action)}
            disabled={actionDisabled}
          >
            {busyAction === action ? <span className="buttonSpinner" aria-hidden="true" /> : <ControlIcon action={action} />}
            <span>{action}</span>
          </button>
        );
      })}
    </div>
  );
}
