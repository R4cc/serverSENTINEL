import type { ManagedServer, PlayerSnapshot, ServerStatus } from "../types";
import { Box, UserRound } from "lucide-react";
import { AppIcon } from "./FileTypeIcon";
import { RestartRequiredBadge } from "./RestartRequiredBadge";
import { RuntimeControls } from "./RuntimeControls";
import { ServerRuntimeAlert } from "./ServerRuntimeAlert";
import { Button, Spinner, StatusBadge } from "./UiPrimitives";
import { GlassEffect } from "./GlassEffect";

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
  startupDisabledReason,
  onRuntimeAction,
  onRetryConnection,
  onResolveRuntimeIssue,
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
  startupDisabledReason?: string;
  onRuntimeAction: (action: "start" | "stop" | "restart") => void;
  onRetryConnection: () => void;
  onResolveRuntimeIssue?: () => void;
  refreshDisabled: boolean;
  refreshDisabledReason: string;
}) {
  const playerCount = playerCountLabel(playerSnapshot);
  return (
    <div className={`activeServerStrip uiGlassSurface uiGlassSurface--chrome ${runtimeAction ? `runtimeAction-${runtimeAction}` : ""} ${runtimeFeedbackAction ? `runtimeFeedback-${runtimeFeedbackAction}` : ""}`.replace(/\s+/g, " ").trim()}>
      <GlassEffect variant="chrome" />
      <div className="serverStripPrimary">
        <div className="serverStripLeft">
          <div className="serverStripIcon">
            <Box className="server-icon-cube" strokeWidth={2.2} aria-hidden="true" />
          </div>
          <div className="serverStripInfo">
            <div className="serverStripTitleRow">
              <span className={`serverCommandStatusDot ${serverCommandTone}`} aria-hidden="true" />
              <strong title={server.displayName}>{server.displayName}</strong>
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
                      <small className="serverStripMeta serverStripPlayers" title="Players online" aria-label={`Players online: ${playerCount}`}>
                        <UserRound strokeWidth={2.2} aria-hidden="true" />
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
            startupDisabledReason={startupDisabledReason}
            busyAction={runtimeAction}
            onAction={onRuntimeAction}
            className="runtimeControlsCompact"
          />
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
      {alert && <ServerRuntimeAlert
        title={alert.title}
        message={alert.message}
        action={server.runtimeIssues?.length && onResolveRuntimeIssue
          ? <Button variant="secondary" onClick={onResolveRuntimeIssue}>Open Properties</Button>
          : undefined}
      />}
    </div>
  );
}
