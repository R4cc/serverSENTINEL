import type { RefObject } from "react";
import { demoServerId } from "../demoRuntime";
import type { ActivePage, ManagedServer } from "../types";
import { minecraftVersionInfo, versionValue } from "../utils/format";
import type { ManagedContentTerminology } from "../features/mods/contentTerminology";
import { ActionMenu } from "./ActionMenu";
import { BrandLogo } from "./BrandLogo";
import { SidebarIcon, SidebarToggleIcon } from "./FileTypeIcon";
import { Button } from "./UiPrimitives";

export function AppSidebar({
  sidebarCollapsed,
  onToggleCollapsed,
  sidebarToggleRef,
  activePage,
  onNavigate,
  onPrefetch,
  servers,
  activeServer,
  onSelectServer,
  serverCommandTone,
  isProvisioning,
  provisioningNavigationReason,
  serverPageDisabledReason,
  supportsManagedMods,
  managedContent,
  demoMode,
  panelVersion,
  accountName,
  onLogout
}: {
  sidebarCollapsed: boolean;
  onToggleCollapsed: () => void;
  sidebarToggleRef: RefObject<HTMLButtonElement | null>;
  activePage: ActivePage;
  onNavigate: (page: ActivePage) => void;
  onPrefetch: (page: ActivePage) => void;
  servers: ManagedServer[];
  activeServer: ManagedServer | undefined;
  onSelectServer: (serverId: string) => void;
  serverCommandTone: string;
  isProvisioning: boolean;
  provisioningNavigationReason: string;
  serverPageDisabledReason: string;
  supportsManagedMods: boolean;
  managedContent: ManagedContentTerminology;
  demoMode: boolean;
  panelVersion: string;
  accountName: string | undefined;
  onLogout: () => void;
}) {
  // Pointing at or tabbing to a navigation item is a reliable signal that the page is about to
  // open, and the chunk behind it takes longer to arrive than the pause before the click. Starting
  // it here is what turns a first visit into the same instant switch a repeat visit already is.
  const prefetchOnIntent = (page: ActivePage) => ({
    onPointerEnter: () => onPrefetch(page),
    onFocus: () => onPrefetch(page)
  });

  return (
    <aside className="sidebar" id="application-sidebar">
      <div className="brandBlock">
        <div className="brandLockup">
          <BrandLogo />
          <div>
            <h1 className="sidebarBrandWordmark" aria-label="serverSENTINEL">
              <span aria-hidden="true">server</span>
              <span aria-hidden="true">SENTINEL</span>
            </h1>
          </div>
        </div>
        <Button ref={sidebarToggleRef} variant="secondary" iconOnly className="iconButton" onClick={onToggleCollapsed} aria-label={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"} aria-expanded={!sidebarCollapsed} aria-controls="primary-navigation account-navigation" disabled={isProvisioning} title={isProvisioning ? provisioningNavigationReason : sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}>
          <SidebarToggleIcon collapsed={sidebarCollapsed} />
        </Button>
      </div>
      <nav className="sideNav" id="primary-navigation" aria-label="Infrastructure navigation">
        <button className={activePage === "nodes" ? "active" : ""} onClick={() => onNavigate("nodes")} {...prefetchOnIntent("nodes")} disabled={isProvisioning} title={isProvisioning ? provisioningNavigationReason : "Open nodes"}>
          <SidebarIcon name="nodes" />
          <span className="navLabel">Nodes</span>
        </button>
        <div className="sidebarDivider" />
        <div className="serverNavigationGroup">
          <div className="serverSwitcher">
            <ActionMenu
              label={activeServer ? `Switch server. Current server: ${activeServer.displayName}` : "Select server"}
              className="serverSwitcherAction"
              triggerClassName="serverSwitcherTrigger"
              menuClassName="serverSwitcherMenu"
              align="start"
              disabled={isProvisioning || servers.length === 0}
              items={servers.map((server) => {
                const selected = server.id === activeServer?.id;
                const lockedByDemo = demoMode && server.id !== demoServerId;
                const minecraftVersion = versionValue(minecraftVersionInfo(server));
                return {
                  id: server.id,
                  active: selected,
                  disabled: lockedByDemo,
                  title: lockedByDemo ? "Exit demo mode to access this server." : `Switch to ${server.displayName}`,
                  onSelect: () => onSelectServer(server.id),
                  label: (
                    <span className="serverSwitcherOption">
                      <span className={`serverSwitcherOptionDot ${selected ? serverCommandTone : "unknown"}`} aria-hidden="true" />
                      <span className="serverSwitcherOptionCopy">
                        <strong>{server.displayName}</strong>
                        <small>{server.nodeName || (minecraftVersion === "Unknown" ? "Version unknown" : `Minecraft ${minecraftVersion}`)}</small>
                      </span>
                      {selected && <span className="serverSwitcherCurrent">Current</span>}
                    </span>
                  )
                };
              })}
              trigger={(
                <>
                  <span className={`serverSwitcherStatus ${activeServer ? serverCommandTone : "unknown"}`} aria-hidden="true" />
                  <span className="serverSwitcherCopy">
                    <small>Managed server</small>
                    <strong>{activeServer?.displayName ?? "Select a server"}</strong>
                    <span>{activeServer?.nodeName || (activeServer ? "Server workspace" : "Choose a workspace")}</span>
                  </span>
                  <svg className="serverSwitcherChevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" aria-hidden="true">
                    <path d="m7 9 5 5 5-5" />
                  </svg>
                </>
              )}
            />
          </div>
          <div className="serverSubNav">
            <button className={activePage === "overview" ? "active" : ""} onClick={() => onNavigate("overview")} {...prefetchOnIntent("overview")} disabled={isProvisioning || !activeServer} title={isProvisioning || !activeServer ? serverPageDisabledReason : "Open overview"}>
              <SidebarIcon name="overview" />
              <span className="navLabel">Overview</span>
            </button>
            <button className={activePage === "console" ? "active" : ""} onClick={() => onNavigate("console")} {...prefetchOnIntent("console")} disabled={isProvisioning || !activeServer} title={isProvisioning || !activeServer ? serverPageDisabledReason : "Open console"}>
              <SidebarIcon name="console" />
              <span className="navLabel">Console</span>
            </button>
            <button className={activePage === "files" ? "active" : ""} onClick={() => onNavigate("files")} {...prefetchOnIntent("files")} disabled={isProvisioning || !activeServer} title={isProvisioning || !activeServer ? serverPageDisabledReason : "Open files"}>
              <SidebarIcon name="files" />
              <span className="navLabel">Files</span>
            </button>
            {supportsManagedMods && (
              <button className={activePage === "mods" ? "active" : ""} onClick={() => onNavigate("mods")} {...prefetchOnIntent("mods")} disabled={isProvisioning || !activeServer} title={isProvisioning || !activeServer ? serverPageDisabledReason : `Open ${managedContent.plural}`}>
                <SidebarIcon name="mods" />
                <span className="navLabel">{managedContent.pluralTitle}</span>
              </button>
            )}
            <button className={activePage === "schedule" ? "active" : ""} onClick={() => onNavigate("schedule")} {...prefetchOnIntent("schedule")} disabled={isProvisioning || !activeServer} title={isProvisioning || !activeServer ? serverPageDisabledReason : "Open schedules"}>
              <SidebarIcon name="schedule" />
              <span className="navLabel">Schedules</span>
            </button>
            <button className={activePage === "properties" ? "active" : ""} onClick={() => onNavigate("properties")} {...prefetchOnIntent("properties")} disabled={isProvisioning || !activeServer} title={isProvisioning || !activeServer ? serverPageDisabledReason : "Open properties"}>
              <SidebarIcon name="properties" />
              <span className="navLabel">Properties</span>
            </button>
          </div>
        </div>
      </nav>
      <nav className="sideNav sideNavBottom" id="account-navigation" aria-label="Account and settings navigation">
        <button className={activePage === "settings" ? "active" : ""} onClick={() => onNavigate("settings")} {...prefetchOnIntent("settings")} disabled={isProvisioning} title={isProvisioning ? provisioningNavigationReason : "Open settings"}>
          <SidebarIcon name="settings" />
          <span className="navLabel settingsNavLabel">
            <span>Settings</span>
            <span className="settingsVersionText">v{panelVersion}</span>
          </span>
        </button>
        <div className="accountChip">
          <span className="accountIcon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21a8 8 0 0 1 16 0" />
            </svg>
          </span>
          <span className="accountName">{demoMode ? "Demo" : accountName}</span>
          <Button variant="ghost" iconOnly className="accountLogoutButton" onClick={onLogout} disabled={isProvisioning} aria-label={demoMode ? "Exit demo" : "Log out"} title={isProvisioning ? provisioningNavigationReason : demoMode ? "Exit demo" : "Log out"}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M10 5H5v14h5" />
              <path d="M14 8l4 4-4 4" />
              <path d="M8 12h10" />
            </svg>
          </Button>
        </div>
      </nav>
    </aside>
  );
}
