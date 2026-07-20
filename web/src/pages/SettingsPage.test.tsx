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
    consoleFontSize: 13,
    consoleScrollback: 5_000,
    commandHistoryCount: 3,
    onRememberConsoleHistoryChange: vi.fn(),
    onConsoleFontSizeChange: vi.fn(),
    onConsoleScrollbackChange: vi.fn(),
    onClearConsoleHistory: vi.fn(),
    modrinthConfigured: false,
    canManageIntegrations: false,
    onSubmitModrinthKey: vi.fn(),
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
    expect(html).toContain("Xander Green");
    expect(html).toContain(">mint</option>");
    expect(html).toContain("Nightlight");
    expect(html).toContain(">peach</option>");
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
  });

  it("renders console defaults and command-history state", () => {
    const html = renderToStaticMarkup(<SettingsPage {...props({ initialCategory: "console", commandHistoryCount: 0 })} />);
    expect(html).toContain("Remember command history");
    expect(html).toContain("13px (default)");
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
  });
});
