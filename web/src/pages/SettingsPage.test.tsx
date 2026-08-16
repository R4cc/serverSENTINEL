import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsPage, type SettingsPageProps } from "./SettingsPage";

function props(overrides: Partial<SettingsPageProps> = {}): SettingsPageProps {
  return {
    loading: false,
    themePreference: "system",
    relativeTimestamps: true,
    regionalFormatPreference: "user",
    displayTimeZonePreference: "panel",
    panelTimeZone: "Europe/Vienna",
    browserTimeZone: "Europe/Vienna",
    displayTimeZone: "Europe/Vienna",
    onThemeChange: vi.fn(),
    onRelativeTimestampsChange: vi.fn(),
    onRegionalFormatChange: vi.fn(),
    onDisplayTimeZoneChange: vi.fn(),
    rememberConsoleHistory: true,
    consoleFontSize: 14,
    consoleScrollback: 5_000,
    commandHistoryCount: 3,
    onRememberConsoleHistoryChange: vi.fn(),
    onConsoleFontSizeChange: vi.fn(),
    onConsoleScrollbackChange: vi.fn(),
    onClearConsoleHistory: vi.fn(),
    modrinthConfigured: false,
    geoIpConfigured: false,
    canManageIntegrations: false,
    onSubmitModrinthKey: vi.fn(),
    onSubmitMaxmindCredentials: vi.fn(),
    playerHeads: { enabled: false, onboardingRequired: false, provider: "mc-heads.net", cacheEntries: 0, cacheBytes: 0 },
    playerHeadsBusy: false,
    onPlayerHeadsEnabledChange: vi.fn(),
    onClearPlayerHeadCache: vi.fn(),
    modules: [
      { id: "schedules", enabled: true, accessible: true },
      { id: "managedContent", enabled: true, accessible: true }
    ],
    modulesBusy: false,
    canManageModules: false,
    onModuleEnabledChange: vi.fn(),
    canViewUsers: false,
    userState: {
      users: [],
      editingUser: null,
      busy: false,
      loading: false,
      error: "",
      canManage: false,
      onOpenCreate: vi.fn(),
      onOpenEdit: vi.fn(),
      onCloseModal: vi.fn(),
      onCreate: vi.fn(),
      onUpdate: vi.fn(),
      onResetPassword: vi.fn(async () => true),
      onDelete: vi.fn(),
      onRetry: vi.fn()
    },
    systemInfo: {
      panelVersion: "1.2.1",
      runtimeMode: "all-in-one",
      panelTimeZone: "Europe/Vienna",
      displayTimeZone: "Europe/Vienna",
      dockerSocketMounted: true,
      panelOnlyMode: false,
      demoMode: false,
      serverCount: 1,
      nodes: [],
      totalMemory: 8 * 1024 * 1024 * 1024,
      modrinthConfigured: false
    },
    refreshingSystemInfo: false,
    onRefreshSystemInfo: vi.fn(),
    onCopyDiagnostics: vi.fn(),
    clearingUiCache: false,
    clearUiCacheDisabledReason: "",
    onClearUiCache: vi.fn(),
    onExitDemo: vi.fn(),
    exitDemoDisabled: false,
    ...overrides
  };
}

describe("SettingsPage", () => {
  it("renders a category-based page with Appearance selected by default", () => {
    const html = renderToStaticMarkup(<SettingsPage {...props()} />);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="settings-tab-appearance"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Relative timestamps");
    expect(html).toContain("This browser");
    expect(html).toContain(">System</option>");
    expect(html).toContain(">Light</option>");
    expect(html).toContain(">Dark</option>");
    expect(html).not.toContain("Make serverSENTINEL work your way");
    expect(html).not.toContain("Personal + panel settings");
  });

  it("uses one regional format with examples and plain-language time zones", () => {
    const html = renderToStaticMarkup(<SettingsPage {...props({
      regionalFormatPreference: "en-US",
      browserTimeZone: "America/New_York"
    })} />);

    expect(html).toContain('aria-label="Regional format"');
    expect(html).not.toContain('aria-label="Date format"');
    expect(html).not.toContain('aria-label="Number format"');
    expect(html).toContain("Example: Jul 20, 2026, 4:30 PM · 12,345.67");
    expect(html).toContain("Panel time — Europe/Vienna");
    expect(html).toContain("This device — America/New_York");
    expect(html).toContain("Schedules continue to use Europe/Vienna");
    expect(html).toContain('aria-live="polite"');
  });

  it("only exposes user management when the permission-backed category is available", () => {
    const withoutUsers = renderToStaticMarkup(<SettingsPage {...props()} />);
    const withUsers = renderToStaticMarkup(<SettingsPage {...props({ canViewUsers: true })} />);
    expect(withoutUsers).not.toContain('id="settings-tab-users"');
    expect(withUsers).toContain('id="settings-tab-users"');
  });

  it("keeps integration management disabled without permission", () => {
    const html = renderToStaticMarkup(<SettingsPage {...props({ initialCategory: "integrations" })} />);
    expect(html).toContain("Modrinth API key");
    expect(html).toContain("Manage integrations permission is required");
    expect(html).toContain("Player heads");
    expect(html).toContain("MCHeads");
    expect(html).toContain("cached heads refresh on a rolling daily schedule");
    expect(html).not.toContain("12 hours");
    expect(html).toContain("0 cached heads · 0 B");
    expect(html).toContain('aria-label="Show player heads on Overview"');
  });

  it("shows the global player-head choice and cached image size", () => {
    const html = renderToStaticMarkup(<SettingsPage {...props({
      initialCategory: "integrations",
      canManageIntegrations: true,
      playerHeads: { enabled: true, onboardingRequired: false, provider: "mc-heads.net", cacheEntries: 42, cacheBytes: 12_288 }
    })} />);
    expect(html).toContain("Enabled");
    expect(html).toContain("42 cached heads · 12 KiB");
    expect(html).toContain("Clear cache");
    expect(html).toContain('href="https://www.mc-heads.net/"');
  });

  it("lists optional modules with the permission that scopes them, and locks the switch without permission", () => {
    const html = renderToStaticMarkup(<SettingsPage {...props({ initialCategory: "modules" })} />);
    expect(html).toContain('id="settings-tab-modules"');
    expect(html).toContain("Schedules");
    expect(html).toContain("schedules.view");
    expect(html).toContain("Whole installation");
    expect(html).toContain('aria-label="Enable the Schedules module"');
    expect(html).toContain("Manage integrations permission is required");
  });

  it("explains what stops happening while a module is switched off", () => {
    const html = renderToStaticMarkup(<SettingsPage {...props({
      initialCategory: "modules",
      canManageModules: true,
      modules: [
        { id: "schedules", enabled: false, accessible: false },
        { id: "managedContent", enabled: true, accessible: true }
      ]
    })} />);
    expect(html).toContain("Nothing is scheduled while this is off");
    expect(html).toContain("Disabled");
    expect(html).not.toContain("Manage integrations permission is required");
  });

  it("drops an integration that only exists to configure a switched-off module", () => {
    const withManagedContent = renderToStaticMarkup(<SettingsPage {...props({ initialCategory: "integrations" })} />);
    const withoutManagedContent = renderToStaticMarkup(<SettingsPage {...props({
      initialCategory: "integrations",
      modules: [
        { id: "schedules", enabled: true, accessible: true },
        { id: "managedContent", enabled: false, accessible: false }
      ]
    })} />);

    expect(withManagedContent).toContain("Modrinth API key");
    expect(withoutManagedContent).not.toContain("Modrinth API key");
    // The unrelated integration in the same category is untouched.
    expect(withoutManagedContent).toContain("Player heads");
  });

  it("renders console defaults and command-history state", () => {
    const html = renderToStaticMarkup(<SettingsPage {...props({ initialCategory: "console", commandHistoryCount: 0 })} />);
    expect(html).toContain("Remember command history");
    expect(html).toContain("14px (default)");
    expect(html).toContain('value="5000" selected=""');
    expect(html).toContain("lines (default)");
    expect(html).toContain("Clear history");
    expect(html).toContain("disabled");
  });

  it("describes panel-only Docker control as not required", () => {
    const html = renderToStaticMarkup(<SettingsPage {...props({
      initialCategory: "system",
      systemInfo: { ...props().systemInfo, runtimeMode: "panel", panelOnlyMode: true, dockerSocketMounted: false }
    })} />);
    expect(html).toContain("Remote-node mode");
    expect(html).toContain("Not required (remote-node mode)");
    expect(html).toContain("Privacy-safe diagnostics");
    expect(html).toContain("Clear UI cache");
  });

  it("disables UI cache clearing while work that a reload could interrupt is active", () => {
    const reason = "Wait for every running task to finish before clearing the UI cache.";
    const html = renderToStaticMarkup(<SettingsPage {...props({ initialCategory: "system", clearUiCacheDisabledReason: reason })} />);
    expect(html).toContain("Clear UI cache");
    expect(html).toContain("disabled");
    expect(html).toContain(reason);
  });
});
