import { FormEvent, KeyboardEvent, ReactNode, useMemo, useState } from "react";
import type { DisplayTimeZonePreference, LocalePreference, PublicUser, ThemePreference } from "../types";
import type { ConsoleFontSize, ConsoleScrollback } from "../features/settings/settingsPreferences";
import { consoleFontSizes, consoleScrollbackSizes } from "../features/settings/settingsPreferences";
import { buildSystemDiagnostics, summarizeSettingsSystemInfo, type SettingsSystemInfo } from "../features/settings/settingsDiagnostics";
import { themeOptions } from "../features/settings/themePreferences";
import { ModrinthKeyForm } from "../components/SettingsPanels";
import { UserManagement } from "../components/AuthPanel";
import { InlineState } from "../components/InlineState";
import { Button, StatusBadge } from "../components/UiPrimitives";

type SettingsCategory = "appearance" | "console" | "integrations" | "users" | "system";

type SettingsUserState = {
  users: PublicUser[];
  currentUserId?: string;
  editingUser: "create" | PublicUser | null;
  busy: boolean;
  loading: boolean;
  error: string;
  canManage: boolean;
  onOpenCreate(): void;
  onOpenEdit(user: PublicUser): void;
  onCloseModal(): void;
  onCreate(event: FormEvent<HTMLFormElement>): void;
  onUpdate(event: FormEvent<HTMLFormElement>, user: PublicUser): void;
  onResetPassword(event: FormEvent<HTMLFormElement>, user: PublicUser): Promise<boolean>;
  onDelete(user: PublicUser): void;
  onRetry(): void;
};

export type SettingsPageProps = {
  initialCategory?: SettingsCategory;
  loading: boolean;
  themePreference: ThemePreference;
  relativeTimestamps: boolean;
  dateLocalePreference: LocalePreference;
  numberLocalePreference: LocalePreference;
  displayTimeZonePreference: DisplayTimeZonePreference;
  panelTimeZone: string;
  browserTimeZone: string;
  displayTimeZone: string;
  onThemeChange(value: ThemePreference): void;
  onRelativeTimestampsChange(value: boolean): void;
  onDateLocaleChange(value: LocalePreference): void;
  onNumberLocaleChange(value: LocalePreference): void;
  onDisplayTimeZoneChange(value: DisplayTimeZonePreference): void;
  rememberConsoleHistory: boolean;
  consoleFontSize: ConsoleFontSize;
  consoleScrollback: ConsoleScrollback;
  commandHistoryCount: number;
  onRememberConsoleHistoryChange(value: boolean): void;
  onConsoleFontSizeChange(value: ConsoleFontSize): void;
  onConsoleScrollbackChange(value: ConsoleScrollback): void;
  onClearConsoleHistory(): void;
  modrinthConfigured: boolean;
  canManageIntegrations: boolean;
  onSubmitModrinthKey(event: FormEvent<HTMLFormElement>): void;
  canViewUsers: boolean;
  userState: SettingsUserState;
  systemInfo: SettingsSystemInfo;
  refreshingSystemInfo: boolean;
  onRefreshSystemInfo(): void;
  onCopyDiagnostics(value: string): void;
  onExitDemo(): void;
  exitDemoDisabled: boolean;
};

const categoryDetails: Record<SettingsCategory, { label: string; description: string }> = {
  appearance: { label: "Appearance", description: "Theme, timestamps, and regional formats" },
  console: { label: "Console", description: "History, text size, and retained output" },
  integrations: { label: "Integrations", description: "External services and credentials" },
  users: { label: "Users", description: "Accounts, roles, and permissions" },
  system: { label: "System", description: "Panel health, runtime, and diagnostics" }
};

function SettingsGlyph({ name }: { name: SettingsCategory | "refresh" | "copy" }) {
  const paths: Record<typeof name, ReactNode> = {
    appearance: <><path d="M12 3a9 9 0 1 0 0 18h1.3a2.2 2.2 0 0 0 0-4.4h-.8a1.6 1.6 0 0 1 0-3.2H15A6 6 0 0 0 15 3h-3Z" /><circle cx="7.5" cy="9" r="1" /><circle cx="10" cy="6.5" r="1" /></>,
    console: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M12.5 15H17" /></>,
    integrations: <><path d="M8 12h8M12 8v8" /><path d="M7 4v3M17 4v3M7 17v3M17 17v3" /><rect x="5" y="7" width="14" height="10" rx="3" /></>,
    users: <><circle cx="9" cy="8" r="3" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 8.5a2.5 2.5 0 0 1 0 5M16 15.5a4.5 4.5 0 0 1 4.5 4.5" /></>,
    system: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
    refresh: <><path d="M20 6v5h-5" /><path d="M18.5 15a7 7 0 1 1-.8-7.8L20 11" /></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function PreferenceRow({ title, description, children, className = "" }: { title: string; description: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`settingsHubRow ${className}`.trim()}>
      <div className="settingsHubRowCopy">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <div className="settingsHubControl">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label, stateLabel }: { checked: boolean; onChange(value: boolean): void; label: string; stateLabel: string }) {
  return (
    <label className="settingsHubToggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} aria-label={label} />
      <span className="settingsHubToggleTrack" aria-hidden="true"><span /></span>
      <span className={checked ? "enabled" : ""}>{stateLabel}</span>
    </label>
  );
}

function CategoryHeader({ category, actions }: { category: SettingsCategory; actions?: ReactNode }) {
  const details = categoryDetails[category];
  return (
    <header className="settingsHubSectionHeader">
      <span className="settingsHubSectionIcon"><SettingsGlyph name={category} /></span>
      <div>
        <h3>{details.label}</h3>
        <p>{details.description}</p>
      </div>
      {actions && <div className="settingsHubSectionActions">{actions}</div>}
    </header>
  );
}

export function SettingsPage(props: SettingsPageProps) {
  const categories = useMemo<SettingsCategory[]>(() => ["appearance", "console", "integrations", ...(props.canViewUsers ? ["users" as const] : []), "system"], [props.canViewUsers]);
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>(props.initialCategory ?? "appearance");
  const selectedCategory = categories.includes(activeCategory) ? activeCategory : "appearance";
  const systemSummary = summarizeSettingsSystemInfo(props.systemInfo);

  function handleCategoryKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? categories.length - 1
        : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + categories.length) % categories.length;
    const next = categories[nextIndex];
    setActiveCategory(next);
    window.requestAnimationFrame(() => document.getElementById(`settings-tab-${next}`)?.focus());
  }

  const categoryContent: Record<SettingsCategory, ReactNode> = {
    appearance: (
      <>
        <CategoryHeader category="appearance" actions={<StatusBadge tone="neutral">This browser</StatusBadge>} />
        <div className="settingsHubRows">
          <PreferenceRow title="Theme" description="Choose a panel palette. This preference stays in this browser.">
            <select aria-label="Theme" value={props.themePreference} onChange={(event) => props.onThemeChange(event.target.value as ThemePreference)}>
              <optgroup label="Classics">
                {themeOptions.filter((option) => option.family === "classic").map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </optgroup>
              <optgroup label="Color commentary">
                {themeOptions.filter((option) => option.family === "color").map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </optgroup>
            </select>
          </PreferenceRow>
          <PreferenceRow title="Relative timestamps" description="Show times as “2 hours ago” instead of the full date and time.">
            <Toggle checked={props.relativeTimestamps} onChange={props.onRelativeTimestampsChange} label="Use relative timestamps" stateLabel={props.relativeTimestamps ? "Relative" : "Full date and time"} />
          </PreferenceRow>
          <PreferenceRow title="Date format" description="Control how dates and times are displayed.">
            <select aria-label="Date format" value={props.dateLocalePreference} onChange={(event) => props.onDateLocaleChange(event.target.value as LocalePreference)}>
              <option value="user">Use browser default</option><option value="en-US">English (US)</option><option value="en-GB">English (UK)</option><option value="de-DE">Deutsch (Deutschland)</option><option value="fr-FR">Français (France)</option><option value="ja-JP">日本語 (日本)</option>
            </select>
          </PreferenceRow>
          <PreferenceRow title="Display time zone" description={<>Show timestamps in {props.displayTimeZone}. Cron schedules continue to use {props.panelTimeZone}.</>}>
            <select aria-label="Display time zone" value={props.displayTimeZonePreference} onChange={(event) => props.onDisplayTimeZoneChange(event.target.value as DisplayTimeZonePreference)}>
              <option value="panel">Panel default ({props.panelTimeZone})</option><option value="browser">Browser local ({props.browserTimeZone})</option><option value="utc">UTC</option>
            </select>
          </PreferenceRow>
          <PreferenceRow title="Number format" description="Control numeric formatting across metrics.">
            <select aria-label="Number format" value={props.numberLocalePreference} onChange={(event) => props.onNumberLocaleChange(event.target.value as LocalePreference)}>
              <option value="user">Use browser default</option><option value="en-US">English (US)</option><option value="en-GB">English (UK)</option><option value="de-DE">Deutsch (Deutschland)</option><option value="fr-FR">Français (France)</option><option value="ja-JP">日本語 (日本)</option>
            </select>
          </PreferenceRow>
        </div>
      </>
    ),
    console: (
      <>
        <CategoryHeader category="console" actions={<StatusBadge tone="neutral">This browser</StatusBadge>} />
        <div className="settingsHubRows">
          <PreferenceRow title="Remember command history" description="Keep the last 50 commands in this browser for faster recall between visits.">
            <Toggle checked={props.rememberConsoleHistory} onChange={props.onRememberConsoleHistoryChange} label="Remember console command history" stateLabel={props.rememberConsoleHistory ? "Remembering" : "Session only"} />
          </PreferenceRow>
          <PreferenceRow title="Terminal font size" description="Change the console text size without changing the rest of the interface.">
            <select aria-label="Terminal font size" value={props.consoleFontSize} onChange={(event) => props.onConsoleFontSizeChange(Number(event.target.value) as ConsoleFontSize)}>
              {consoleFontSizes.map((size) => <option key={size} value={size}>{size}px{size === 13 ? " (default)" : ""}</option>)}
            </select>
          </PreferenceRow>
          <PreferenceRow title="Retained output" description="Choose how many console lines can be scrolled back through. Higher values use more browser memory.">
            <select aria-label="Console retained output" value={props.consoleScrollback} onChange={(event) => props.onConsoleScrollbackChange(Number(event.target.value) as ConsoleScrollback)}>
              {consoleScrollbackSizes.map((size) => <option key={size} value={size}>{size.toLocaleString()} lines{size === 5_000 ? " (default)" : ""}</option>)}
            </select>
          </PreferenceRow>
          <PreferenceRow title="Command history" description={`${props.commandHistoryCount} command${props.commandHistoryCount === 1 ? "" : "s"} available in the current session.`} className="settingsHubRowDanger">
            <Button variant="secondary" onClick={props.onClearConsoleHistory} disabled={props.commandHistoryCount === 0}>Clear history</Button>
          </PreferenceRow>
        </div>
      </>
    ),
    integrations: (
      <>
        <CategoryHeader category="integrations" />
        <div className="settingsHubRows">
          <PreferenceRow title="Modrinth API key" description="Enable mod search, compatibility checks, and installs." className="settingsHubIntegrationRow">
            <ModrinthKeyForm onSubmit={props.onSubmitModrinthKey} configured={props.modrinthConfigured} disabled={!props.canManageIntegrations} loading={props.loading} />
          </PreferenceRow>
        </div>
      </>
    ),
    users: (
      <>
        <CategoryHeader category="users" actions={<Button onClick={props.userState.onOpenCreate} disabled={props.userState.busy || !props.userState.canManage} title={!props.userState.canManage ? "Manage users permission is required" : "Create user"}>New user</Button>} />
        <div className="settingsHubUsers">
          {props.userState.error && <InlineState tone="error" title="Could not load users" message={`${props.userState.error} Check that your account can manage users, then try again.`} actionLabel="Retry" onAction={props.userState.onRetry} busy={props.userState.loading} />}
          <UserManagement
            users={props.userState.users}
            currentUserId={props.userState.currentUserId}
            editingUser={props.userState.editingUser}
            busy={props.userState.busy}
            loading={props.userState.loading}
            canManageUsers={props.userState.canManage}
            onOpenEdit={props.userState.onOpenEdit}
            onCloseModal={props.userState.onCloseModal}
            onCreate={props.userState.onCreate}
            onUpdate={props.userState.onUpdate}
            onResetPassword={props.userState.onResetPassword}
            onDelete={props.userState.onDelete}
          />
        </div>
      </>
    ),
    system: (
      <>
        <CategoryHeader category="system" actions={<div className="settingsHubSystemActions"><Button variant="secondary" onClick={props.onRefreshSystemInfo} disabled={props.refreshingSystemInfo} reserveLabel="Refreshing"><SettingsGlyph name="refresh" />{props.refreshingSystemInfo ? "Refreshing" : "Refresh"}</Button><Button onClick={() => props.onCopyDiagnostics(buildSystemDiagnostics(props.systemInfo))}><SettingsGlyph name="copy" />Copy diagnostics</Button></div>} />
        <div className="settingsHubSystemOverview">
          <div className={`settingsHubHealth ${props.systemInfo.panelOnlyMode || props.systemInfo.dockerSocketMounted || props.systemInfo.demoMode ? "ready" : "limited"}`}>
            <span className="settingsHubHealthDot" aria-hidden="true" />
            <div><strong>{props.systemInfo.demoMode ? "Demo environment" : props.systemInfo.panelOnlyMode ? "Remote-node mode" : props.systemInfo.dockerSocketMounted ? "Local control connected" : "Local control limited"}</strong><span>{props.systemInfo.panelOnlyMode ? "Docker control is provided by connected nodes and is not required on the panel." : props.systemInfo.dockerSocketMounted || props.systemInfo.demoMode ? "The panel runtime is available." : "Mount the Docker socket or connect an online remote node to enable runtime control."}</span></div>
          </div>
          <dl className="settingsHubFacts">
            <div><dt>Panel release</dt><dd><strong>v{props.systemInfo.panelVersion}</strong><span>{props.systemInfo.buildId ? `Build ${props.systemInfo.buildId.slice(0, 12)}` : "Build unavailable"}</span></dd></div>
            <div><dt>Runtime mode</dt><dd><strong>{props.systemInfo.runtimeMode || "Unknown"}</strong><span>Panel deployment role</span></dd></div>
            <div><dt>Docker control</dt><dd><strong>{systemSummary.dockerStatus}</strong><span>Local container access</span></dd></div>
            <div><dt>Managed servers</dt><dd><strong>{props.systemInfo.serverCount}</strong><span>Configured across all nodes</span></dd></div>
            <div><dt>Connected nodes</dt><dd><strong>{systemSummary.onlineNodeCount} / {systemSummary.nodeCount} online</strong><span>{systemSummary.nodeCount - systemSummary.onlineNodeCount} currently unavailable</span></dd></div>
            <div><dt>Detected memory</dt><dd><strong>{systemSummary.memory}</strong><span>Panel host capacity</span></dd></div>
            <div><dt>Modrinth</dt><dd><StatusBadge tone={props.systemInfo.modrinthConfigured ? "success" : "neutral"}>{props.systemInfo.modrinthConfigured ? "Configured" : "Not configured"}</StatusBadge><span>Mod discovery integration</span></dd></div>
          </dl>
          <div className="settingsHubTechnical">
            <div><strong>Time zones</strong><span>Panel: {props.systemInfo.panelTimeZone}</span><span>Display: {props.systemInfo.displayTimeZone}</span></div>
            <div><strong>Agent versions</strong><code>{systemSummary.agentVersions}</code></div>
            <div><strong>Protocol versions</strong><code>{systemSummary.protocolVersions}</code></div>
          </div>
          <div className="settingsHubPrivacyNote"><strong>Privacy-safe diagnostics</strong><span>Copied diagnostics include aggregate runtime information only. Usernames, credentials, commands, server and node names, and filesystem paths are excluded.</span></div>
          {props.systemInfo.demoMode && <div className="settingsHubDemoCallout"><div><strong>Demo mode</strong><span>Leave the sample workspace and return to sign-in.</span></div><Button variant="secondary" onClick={props.onExitDemo} disabled={props.exitDemoDisabled}>Exit demo mode</Button></div>}
        </div>
      </>
    )
  };

  return (
    <section className="settingsHub layoutWide" aria-busy={props.loading}>
      <div className="settingsHubShell">
        <nav className="settingsHubCategories" aria-label="Settings categories" role="tablist">
          {categories.map((category, index) => {
            const details = categoryDetails[category];
            const selected = selectedCategory === category;
            return <button key={category} id={`settings-tab-${category}`} type="button" role="tab" aria-selected={selected} aria-controls={`settings-panel-${category}`} tabIndex={selected ? 0 : -1} className={selected ? "active" : ""} onClick={() => setActiveCategory(category)} onKeyDown={(event) => handleCategoryKeyDown(event, index)}><span className="settingsHubCategoryIcon"><SettingsGlyph name={category} /></span><span><strong>{details.label}</strong><small>{details.description}</small></span></button>;
          })}
        </nav>
        <section className="settingsHubContent" id={`settings-panel-${selectedCategory}`} role="tabpanel" aria-labelledby={`settings-tab-${selectedCategory}`} tabIndex={0}>
          {categoryContent[selectedCategory]}
        </section>
      </div>
    </section>
  );
}
