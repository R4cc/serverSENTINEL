import { useMemo, useRef, type RefObject } from "react";
import { ChevronDown, CircleUserRound, LogOut } from "lucide-react";
import { demoServerId } from "../demoRuntime";
import type { ActivePage, ManagedServer } from "../types";
import { minecraftVersionInfo, versionValue } from "../utils/format";
import type { ManagedContentTerminology } from "../features/mods/contentTerminology";
import { ActionMenu } from "./ActionMenu";
import { BrandLogo } from "./BrandLogo";
import { SidebarIcon, SidebarToggleIcon } from "./FileTypeIcon";
import { Button } from "./UiPrimitives";
import { GlassEffect } from "./GlassEffect";

export function AppSidebar({
  sidebarCollapsed,
  onToggleCollapsed,
  sidebarToggleRef,
  activePage,
  onNavigate,
  onPrefetch,
  isPageAvailable,
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
  /** False for a page whose optional module this installation, or this account, cannot reach. */
  isPageAvailable: (page: ActivePage) => boolean;
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
  // The switcher menu only mounts its items once it is open, but the array below — one JSX label
  // per managed server — was being rebuilt on every render of the shell, which includes every
  // console log flush. Held through a ref so the callback identity cannot invalidate the memo.
  const selectServerRef = useRef(onSelectServer);
  selectServerRef.current = onSelectServer;
  const serverSwitcherItems = useMemo(() => servers.map((server) => {
    const selected = server.id === activeServer?.id;
    const lockedByDemo = demoMode && server.id !== demoServerId;
    const minecraftVersion = versionValue(minecraftVersionInfo(server));
    const statusTone = server.runtimeIssues?.length ? "warning" : selected ? serverCommandTone : server.runtimeIntent === "running" ? "running" : server.runtimeIntent === "restarting" ? "starting" : server.runtimeIntent === "stopped" ? "stopped" : "unknown";
    return {
      id: server.id,
      active: selected,
      disabled: lockedByDemo,
      title: lockedByDemo ? "Exit demo mode to access this server." : `Switch to ${server.displayName}`,
      onSelect: () => selectServerRef.current(server.id),
      label: (
        <span className="serverSwitcherOption">
          <span className={`serverSwitcherOptionDot ${statusTone}`} aria-hidden="true" />
          <span className="serverSwitcherOptionCopy">
            <strong>{server.displayName}</strong>
            <small>{server.runtimeIssues?.length ? "Unresolved port conflict" : server.nodeName || (minecraftVersion === "Unknown" ? "Version unknown" : `Minecraft ${minecraftVersion}`)}</small>
          </span>
          {selected && <span className="serverSwitcherCurrent">Current</span>}
        </span>
      )
    };
  }), [servers, activeServer?.id, serverCommandTone, demoMode]);

  // Pointing at or tabbing to a navigation item is a reliable signal that the page is about to
  // open, and the chunk behind it takes longer to arrive than the pause before the click. Starting
  // it here is what turns a first visit into the same instant switch a repeat visit already is.
  //
  // Every navigation entry goes through this so the active page is announced (`aria-current`) and
  // not only tinted, and so no entry can drift away from the others as items are added.
  const navItem = (page: ActivePage, disabled: boolean, disabledReason: string, label: string) => ({
    type: "button" as const,
    className: activePage === page ? "active" : "",
    "aria-current": activePage === page ? ("page" as const) : undefined,
    onClick: () => onNavigate(page),
    onPointerEnter: () => onPrefetch(page),
    onFocus: () => onPrefetch(page),
    disabled,
    title: disabled ? disabledReason : label
  });

  const shellNavItem = (page: ActivePage, label: string) => navItem(page, isProvisioning, provisioningNavigationReason, label);
  const serverNavItem = (page: ActivePage, label: string) => navItem(page, isProvisioning || !activeServer, serverPageDisabledReason, label);

  return (
    <aside className="sidebar uiGlassSurface uiGlassSurface--chrome" id="application-sidebar">
      <GlassEffect variant="chrome" cornerRadius={0} />
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
        <button {...shellNavItem("nodes", "Open nodes")}>
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
              items={serverSwitcherItems}
              trigger={(
                <>
                  <span className={`serverSwitcherStatus ${activeServer ? serverCommandTone : "unknown"}`} aria-hidden="true" />
                  <span className="serverSwitcherCopy">
                    <small>Managed server</small>
                    <strong>{activeServer?.displayName ?? "Select a server"}</strong>
                    <span>{activeServer?.runtimeIssues?.length ? "Unresolved port conflict" : activeServer?.nodeName || (activeServer ? "Server workspace" : "Choose a workspace")}</span>
                  </span>
                  <ChevronDown className="serverSwitcherChevron" strokeWidth={2.25} aria-hidden="true" />
                </>
              )}
            />
          </div>
          <div className="serverSubNav">
            <button {...serverNavItem("overview", "Open overview")}>
              <SidebarIcon name="overview" />
              <span className="navLabel">Overview</span>
            </button>
            <button {...serverNavItem("console", "Open console")}>
              <SidebarIcon name="console" />
              <span className="navLabel">Console</span>
            </button>
            <button {...serverNavItem("files", "Open files")}>
              <SidebarIcon name="files" />
              <span className="navLabel">Files</span>
            </button>
            {supportsManagedMods && isPageAvailable("mods") && (
              <button {...serverNavItem("mods", `Open ${managedContent.plural}`)}>
                <SidebarIcon name="mods" />
                <span className="navLabel">{managedContent.pluralTitle}</span>
              </button>
            )}
            {isPageAvailable("schedule") && (
              <button {...serverNavItem("schedule", "Open schedules")}>
                <SidebarIcon name="schedule" />
                <span className="navLabel">Schedules</span>
              </button>
            )}
            <button {...serverNavItem("properties", "Open properties")}>
              <SidebarIcon name="properties" />
              <span className="navLabel">Properties</span>
            </button>
          </div>
        </div>
      </nav>
      <nav className="sideNav sideNavBottom" id="account-navigation" aria-label="Account and settings navigation">
        <button {...shellNavItem("settings", "Open settings")}>
          <SidebarIcon name="settings" />
          <span className="navLabel settingsNavLabel">
            <span>Settings</span>
            <span className="settingsVersionText">v{panelVersion}</span>
          </span>
        </button>
        <div className="accountChip">
          <span className="accountIcon" aria-hidden="true">
            <CircleUserRound />
          </span>
          <span className="accountName" title={demoMode ? "Demo" : accountName}>{demoMode ? "Demo" : accountName ?? "Account"}</span>
          <Button variant="ghost" iconOnly className="accountLogoutButton" onClick={onLogout} disabled={isProvisioning} aria-label={demoMode ? "Exit demo" : "Log out"} title={isProvisioning ? provisioningNavigationReason : demoMode ? "Exit demo" : "Log out"}>
            <LogOut aria-hidden="true" />
          </Button>
        </div>
      </nav>
    </aside>
  );
}
