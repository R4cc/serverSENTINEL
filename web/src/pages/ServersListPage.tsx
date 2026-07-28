import type { ReactNode } from "react";
import { serverRuntimeDefinition } from "@serversentinel/contracts";
import { demoServerId } from "../demoRuntime";
import type { ManagedServer } from "../types";
import { minecraftVersionInfo, versionValue } from "../utils/format";

export function ServersListPage({
  servers,
  activeServerId,
  demoMode,
  isProvisioning,
  onSelectServer,
  onLockedServer,
  emptyState
}: {
  servers: ManagedServer[];
  activeServerId: string | undefined;
  demoMode: boolean;
  isProvisioning: boolean;
  onSelectServer: (serverId: string) => void;
  onLockedServer: () => void;
  emptyState: ReactNode;
}) {
  return (
    <section className="pageStack layoutBalanced">
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
