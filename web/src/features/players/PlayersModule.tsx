import type { ManagedServer, Notify } from "../../types";
import { polyfillCountryFlagEmojis } from "country-flag-emoji-polyfill";
import countryFlagFontUrl from "../../../../node_modules/country-flag-emoji-polyfill/dist/TwemojiCountryFlags.woff2?url";
import { PlayersPage } from "../../pages/PlayersPage";
import { usePlayersWorkspace } from "./usePlayersWorkspace";

polyfillCountryFlagEmojis("Twemoji Country Flags", countryFlagFontUrl);

/**
 * The Player Insights module's entire browser surface: its workspace state and its page, behind one
 * dynamic import. The shell never references either directly, so a visitor who cannot reach the
 * module — because the installation switched it off, or because their account lacks `players.view`
 * — never downloads this chunk, and never downloads the bundled world outline with it.
 *
 * Nothing outside the module reads this state, so unlike managed content it is mounted with its
 * page rather than for the whole server visit.
 */
export type PlayersModuleProps = {
  activeServer: ManagedServer | null;
  activeServerIsDemo: boolean;
  demoRunning: boolean;
  canManage: boolean;
  playerHeadsEnabled: boolean;
  /** Phone layout, passed straight through to the chart geometry. */
  compactLayout: boolean;
  notify: Notify;
  handleStaleSession(error: unknown): boolean;
  formatDate(value: string | number | Date): string;
};

export function PlayersModule(props: PlayersModuleProps) {
  const workspace = usePlayersWorkspace({
    active: Boolean(props.activeServer),
    activeServer: props.activeServer,
    activeServerIsDemo: props.activeServerIsDemo,
    demoRunning: props.demoRunning,
    canManage: props.canManage,
    notify: props.notify,
    handleStaleSession: props.handleStaleSession
  });

  if (!props.activeServer) return null;

  return (
    <PlayersPage
      active
      server={props.activeServer}
      insights={workspace.insights}
      loading={workspace.loading}
      error={workspace.error}
      busy={workspace.busy}
      range={workspace.range}
      onRangeChange={workspace.setRange}
      onReload={workspace.reload}
      onSaveServerAddress={(address) => void workspace.saveServerAddress(address)}
      onRefreshGeoDatabase={() => void workspace.refreshGeoDatabase()}
      canManage={props.canManage}
      playerHeadsEnabled={props.playerHeadsEnabled}
      compactLayout={props.compactLayout}
      formatDate={props.formatDate}
    />
  );
}
