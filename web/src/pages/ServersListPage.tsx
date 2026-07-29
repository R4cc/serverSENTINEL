import type { ReactNode } from "react";
import { serverRuntimeDefinition } from "@serversentinel/contracts";
import { demoServerId } from "../demoRuntime";
import type { ManagedServer } from "../types";
import { minecraftVersionInfo, versionValue } from "../utils/format";
import { Button, Toolbar } from "../components/UiPrimitives";
import { AppIcon } from "../components/FileTypeIcon";

export function ServersListPage({
  servers,
  activeServerId,
  demoMode,
  isProvisioning,
  canExport,
  canImport,
  onSelectServer,
  onLockedServer,
  onExport,
  onImport,
  emptyState
}: {
  servers: ManagedServer[];
  activeServerId: string | undefined;
  demoMode: boolean;
  isProvisioning: boolean;
  canExport: boolean;
  canImport: boolean;
  onSelectServer: (serverId: string) => void;
  onLockedServer: () => void;
  onExport: () => void;
  onImport: () => void;
  emptyState: ReactNode;
}) {
  return (
    <section className="pageStack layoutBalanced">
      {(canExport || canImport) && (
        <Toolbar
          secondary={(
            <>
              {canExport && (
                <Button variant="secondary" compact onClick={onExport} disabled={demoMode || isProvisioning || servers.length === 0}>
                  <AppIcon name="download" /> Export
                </Button>
              )}
              {canImport && (
                <Button variant="secondary" compact onClick={onImport} disabled={demoMode || isProvisioning}>
                  <AppIcon name="fileUp" /> Import
                </Button>
              )}
            </>
          )}
        />
      )}
      {servers.length > 0 ? (
        <section className="serverList">
          {servers.map((server) => {
            const lockedByDemo = demoMode && server.id !== demoServerId;
            const minecraftVersion = versionValue(minecraftVersionInfo(server));
            const runtime = serverRuntimeDefinition(server.runtimeProfile.runtimeType);
            return (
              <button
                key={server.id}
                className={`serverListItem ${server.id === activeServerId ? "active" : ""}`}
                disabled={isProvisioning || lockedByDemo}
                onClick={() => {
                  if (lockedByDemo) {
                    onLockedServer();
                    return;
                  }
                  onSelectServer(server.id);
                }}
              >
                <span className="serverListTitleRow">
                  <strong>{server.displayName}</strong>
                </span>
                <span>{minecraftVersion === "Unknown" ? "Version unknown" : minecraftVersion} - {runtime.displayName}</span>
                {lockedByDemo && <small>Demo mode is enabled. Disable it in settings to access this server.</small>}
              </button>
            );
          })}
        </section>
      ) : (
        emptyState
      )}
    </section>
  );
}
