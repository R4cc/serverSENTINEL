import type { ManagedServer, PlayerSnapshot, ServerStatus } from "../types";
import { AppIcon } from "./FileTypeIcon";
import { RestartRequiredBadge } from "./RestartRequiredBadge";
import { RuntimeControls } from "./RuntimeControls";
import { ServerRuntimeAlert } from "./ServerRuntimeAlert";
import { Button, Spinner, StatusBadge } from "./UiPrimitives";

export type ServerStripHealth = { tone: string; message: string } | null;
export type ServerStripAlert = { title: string; message: string } | null;

/** Null when the count is unknown, so the strip can drop the item entirely. */
function playerCountLabel(snapshot: PlayerSnapshot | undefined) {
  if (!snapshot || snapshot.online === null) return null;
  return snapshot.maxPlayers ? `${snapshot.online} / ${snapshot.maxPlayers}` : String(snapshot.online);
}

export function ActiveServerStrip({
  server,
  runtimeAction,
  runtimeFeedbackAction,
  serverCommandTone,
  lastKnownRuntimeLabel,
  health,
  healthDetail,
  alert,
  nodeName,
  runtimeDisplayName,
  minecraftVersion,
  playerSnapshot,
  nodeOffline,
  status,
  controlAvailableFallback,
  controlsDisabled,
  controlsDisabledReason,
  onRuntimeAction,
  consoleActive,
  onOpenConsole,
  onRetryConnection,
  refreshDisabled,
  refreshDisabledReason
}: {
  server: ManagedServer;
  runtimeAction: "start" | "stop" | "restart" | null;
  runtimeFeedbackAction: "start" | "restart" | null;
  serverCommandTone: string;
  lastKnownRuntimeLabel: string;
  health: ServerStripHealth;
  healthDetail: string;
  alert: ServerStripAlert;
  nodeName: string;
  runtimeDisplayName: string;
  minecraftVersion: string;
  playerSnapshot: PlayerSnapshot | undefined;
  nodeOffline: boolean;
  status: ServerStatus | null;
  controlAvailableFallback: boolean;
  controlsDisabled: boolean;
  controlsDisabledReason: string;
  onRuntimeAction: (action: "start" | "stop" | "restart") => void;
  consoleActive: boolean;
  onOpenConsole: () => void;
  onRetryConnection: () => void;
  refreshDisabled: boolean;
  refreshDisabledReason: string;
}) {
  const playerCount = playerCountLabel(playerSnapshot);
  return (
    <div className={`activeServerStrip ${runtimeAction ? `runtimeAction-${runtimeAction}` : ""} ${runtimeFeedbackAction ? `runtimeFeedback-${runtimeFeedbackAction}` : ""}`.replace(/\s+/g, " ").trim()}>
      <div className="serverStripPrimary">
        <div className="serverStripLeft">
          <div className="serverStripIcon">
            <svg className="server-icon-cube" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
              <line x1="12" y1="22.08" x2="12" y2="12" />
            </svg>
          </div>
          <div className="serverStripInfo">
            <div className="serverStripTitleRow">
              <span className={`serverCommandStatusDot ${serverCommandTone}`} aria-hidden="true" />
              <strong>{server.displayName}</strong>
              <StatusBadge className={`runtimeBadge ${serverCommandTone}`}>
                {lastKnownRuntimeLabel}
              </StatusBadge>
              {server.restartRequiredSince && <RestartRequiredBadge changes={server.restartRequiredChanges} runtimeType={server.runtimeProfile.runtimeType} />}
            </div>
            <div className="serverStripMetaRow">
              {health ? (
                <small className={`serverStripHealth ${health.tone}`} role={health.tone === "error" ? "alert" : "status"} title={healthDetail || health.message}>
                  {health.tone === "loading" && <Spinner size="xs" />}
                  {health.message}
                </small>
              ) : (
                <>
                  <small className="serverStripMeta">
                    {nodeName}
                  </small>
                  <span aria-hidden="true" className="serverStripSeparator">·</span>
                  <small className="serverStripMeta">
                    {runtimeDisplayName}
                  </small>
                  <span aria-hidden="true" className="serverStripSeparator">·</span>
                  <small className="serverStripMeta">
                    MC {minecraftVersion === "Unknown" ? "unknown" : minecraftVersion}
                  </small>
                  {playerCount && (
                    <>
                      <span aria-hidden="true" className="serverStripSeparator">·</span>
                      <small className="serverStripMeta serverStripPlayers" title="Players online">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <circle cx="12" cy="8" r="3" />
                          <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
                        </svg>
                        {playerCount}
                      </small>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
        <div className="serverStripRight">
          {nodeOffline && <ServerRuntimeAlert title="Node offline" compact />}
          <RuntimeControls
            status={status}
            controlAvailableFallback={controlAvailableFallback}
            isProvisioning={controlsDisabled}
            disabledReason={controlsDisabledReason}
            busyAction={runtimeAction}
            onAction={onRuntimeAction}
            className="runtimeControlsCompact"
          />
          <Button
            variant="secondary"
            className={`quickActionButton consoleLink ${consoleActive ? "active" : ""}`}
            onClick={onOpenConsole}
            title="Open console"
          >
            <svg className="buttonIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span>Console</span>
          </Button>
          <Button
            variant="secondary"
            iconOnly
            className="refreshStatusButton"
            onClick={onRetryConnection}
            disabled={refreshDisabled}
            aria-label={health || alert ? "Retry server connection" : "Refresh server status"}
            title={refreshDisabled ? refreshDisabledReason : health || alert ? "Retry server connection" : "Refresh server status"}
          >
            <AppIcon name="refresh" />
          </Button>
        </div>
      </div>
      {alert && <ServerRuntimeAlert title={alert.title} message={alert.message} />}
    </div>
  );
}
