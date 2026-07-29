import type { ManagedServer, ServerStatus } from "../types";
import { ActionMenu } from "./ActionMenu";
import { RestartRequiredBadge } from "./RestartRequiredBadge";
import { RuntimeControls } from "./RuntimeControls";
import { ServerRuntimeAlert } from "./ServerRuntimeAlert";
import { Button, Spinner, StatusBadge } from "./UiPrimitives";

export type ServerStripHealth = { tone: string; message: string } | null;
export type ServerStripAlert = { title: string; message: string } | null;

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
  runtimeVersion,
  minecraftVersion,
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
  runtimeVersion: string;
  minecraftVersion: string;
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
                    {runtimeDisplayName} {runtimeVersion || "unknown"}
                  </small>
                  <span aria-hidden="true" className="serverStripSeparator">·</span>
                  <small className="serverStripMeta">
                    MC {minecraftVersion === "Unknown" ? "unknown" : minecraftVersion}
                  </small>
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
          <ActionMenu
            label="More server actions"
            className="overflowMenuContainer"
            triggerClassName="iconButton overflowButton"
            menuClassName="overflowDropdown"
            items={[
              {
                id: "refresh",
                label: health || alert ? "Retry connection" : "Refresh status",
                onSelect: onRetryConnection,
                disabled: refreshDisabled,
                title: refreshDisabled ? refreshDisabledReason : "Refresh server status"
              }
            ]}
            trigger={
              <svg className="buttonIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                <circle cx="12" cy="5" r="1.5" fill="currentColor" />
                <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                <circle cx="12" cy="19" r="1.5" fill="currentColor" />
              </svg>
            }
          />
        </div>
      </div>
      {alert && <ServerRuntimeAlert title={alert.title} message={alert.message} />}
    </div>
  );
}
