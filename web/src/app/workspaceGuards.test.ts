import { describe, expect, it } from "vitest";
import type { ServerStatus } from "../types";
import { resolveRuntimeGuards, resolveServerSettingsGuards, resolveServerStripStatus, stoppedServerMutationMessage } from "./workspaceGuards";

function serverStatus(overrides: {
  docker?: Partial<ServerStatus["docker"]>;
  lifecycle?: Partial<ServerStatus["lifecycle"]>;
} = {}): ServerStatus {
  return {
    server: { id: "server-1" },
    docker: { configured: true, available: true, controllable: true, state: "exited", running: false, ...overrides.docker },
    fileLogsAvailable: true,
    controlAvailable: true,
    commandInputAvailable: true,
    commandInputMessage: "",
    lifecycle: { state: "idle", message: "", ...overrides.lifecycle } as ServerStatus["lifecycle"]
  };
}

const stripDefaults = {
  activeNodeRuntimeBlocked: false,
  activeNodeStatus: "online",
  activeNodeBlockReason: "",
  activeNodeBlockMessage: "",
  statusError: "",
  activePage: "overview" as const,
  consoleConnectionState: "live" as const,
  consoleError: "",
  consoleLoading: false,
  activeStatus: serverStatus()
};

describe("resolveServerStripStatus", () => {
  const runtimeIssue = {
    code: "port_conflict" as const,
    message: "Port 25565/tcp is also assigned to Survival.",
    port: 25565,
    protocol: "tcp" as const,
    conflictingServerId: "server-2",
    conflictingServerName: "Survival"
  };

  it("reports no alert and no health line when the server is healthy", () => {
    expect(resolveServerStripStatus(stripDefaults)).toEqual({ alert: null, health: null });
  });

  it("raises an alert when the node is blocked but not offline", () => {
    const { alert } = resolveServerStripStatus({
      ...stripDefaults,
      activeNodeRuntimeBlocked: true,
      activeNodeBlockReason: "Node unreachable",
      activeNodeBlockMessage: "Node unreachable. Check the agent connection."
    });
    expect(alert).toEqual({ title: "Node unreachable", message: "Check the agent connection." });
  });

  it("shows an imported port conflict ahead of runtime health", () => {
    expect(resolveServerStripStatus({ ...stripDefaults, runtimeIssue, statusError: "unreachable" }).alert).toEqual({
      title: "Unresolved port conflict",
      message: "Port 25565/tcp is also assigned to Survival. Choose a different port in Properties before starting this server."
    });
  });

  it("suppresses the health line whenever an alert is showing", () => {
    const blocked = {
      ...stripDefaults,
      activeNodeRuntimeBlocked: true,
      activeNodeBlockReason: "Node unreachable",
      activeNodeBlockMessage: "Node unreachable. Check the agent connection."
    };
    // Each of these inputs produces a health line on its own; the alert must win
    // so the strip never reports two conflicting states at once.
    expect(resolveServerStripStatus({ ...blocked, activeStatus: null }).health).toBeNull();
    expect(resolveServerStripStatus({ ...blocked, statusError: "boom" }).health).toBeNull();
    expect(resolveServerStripStatus({ ...blocked, activePage: "console", consoleConnectionState: "reconnecting" }).health).toBeNull();

    // Same inputs without the alert do produce a health line.
    expect(resolveServerStripStatus({ ...stripDefaults, activeStatus: null }).health).not.toBeNull();
    expect(resolveServerStripStatus({ ...stripDefaults, statusError: "boom" }).health).not.toBeNull();
  });

  it("keeps the full message when it is not prefixed by the reason", () => {
    const { alert } = resolveServerStripStatus({
      ...stripDefaults,
      activeNodeRuntimeBlocked: true,
      activeNodeBlockReason: "Node unreachable",
      activeNodeBlockMessage: "Something else entirely."
    });
    expect(alert?.message).toBe("Something else entirely.");
  });

  it("stays silent when the node is blocked because it is offline", () => {
    const { alert } = resolveServerStripStatus({
      ...stripDefaults,
      activeNodeRuntimeBlocked: true,
      activeNodeStatus: "offline",
      activeNodeBlockMessage: "Node is offline."
    });
    expect(alert).toBeNull();
  });

  it("surfaces a status error ahead of console state", () => {
    const { health } = resolveServerStripStatus({ ...stripDefaults, statusError: "boom", activePage: "console", consoleConnectionState: "reconnecting" });
    expect(health).toEqual({ tone: "warning", message: "Status temporarily unavailable — retrying automatically." });
  });

  it("reports console connection state only on the console page", () => {
    expect(resolveServerStripStatus({ ...stripDefaults, consoleConnectionState: "reconnecting" }).health).toBeNull();
    expect(resolveServerStripStatus({ ...stripDefaults, activePage: "console", consoleConnectionState: "reconnecting" }).health)
      .toEqual({ tone: "warning", message: "Reconnecting console…" });
    expect(resolveServerStripStatus({ ...stripDefaults, activePage: "console", consoleConnectionState: "polling" }).health)
      .toEqual({ tone: "warning", message: "Live stream unavailable — polling console logs." });
  });

  it("falls back to a generic message when the console errors without detail", () => {
    expect(resolveServerStripStatus({ ...stripDefaults, activePage: "console", consoleConnectionState: "error" }).health)
      .toEqual({ tone: "error", message: "Console stream is unavailable." });
    expect(resolveServerStripStatus({ ...stripDefaults, activePage: "console", consoleConnectionState: "error", consoleError: "stream closed" }).health)
      .toEqual({ tone: "error", message: "stream closed" });
  });

  it("shows a loading line until the status arrives", () => {
    expect(resolveServerStripStatus({ ...stripDefaults, activeStatus: null }).health)
      .toEqual({ tone: "loading", message: "Loading server status…" });
  });
});

const runtimeDefaults = {
  authOperationalLock: false,
  canBasic: true,
  activeNodeRuntimeBlocked: false,
  nodeOfflineDetected: false,
  activeNodeBlockMessage: "",
  activeNodeName: "local",
  activeServerUsesInternalNode: false,
  dockerSocketMounted: true,
  lifecycleTransitionRunning: false,
  isProvisioning: false,
  activeStatus: serverStatus(),
  runtimeAction: null
};

describe("resolveRuntimeGuards", () => {
  it("allows runtime controls when nothing is blocking", () => {
    expect(resolveRuntimeGuards(runtimeDefaults).runtimeControlsDisabledReason).toBe("");
  });

  it("ranks sign-in above every other reason", () => {
    expect(resolveRuntimeGuards({ ...runtimeDefaults, authOperationalLock: true, canBasic: false, isProvisioning: true }).runtimeControlsDisabledReason)
      .toBe("Sign in before using runtime controls.");
  });

  it("names the offline node when no block message is supplied", () => {
    expect(resolveRuntimeGuards({ ...runtimeDefaults, nodeOfflineDetected: true, activeNodeName: "edge-1" }).runtimeControlsDisabledReason)
      .toBe("edge-1 is offline. Runtime controls will return when it reconnects.");
  });

  it("blocks startup with the exact imported port conflict", () => {
    expect(resolveRuntimeGuards({
      ...runtimeDefaults,
      runtimeIssue: {
        code: "port_conflict",
        message: "Port 25565/tcp is also assigned to Survival.",
        port: 25565,
        protocol: "tcp",
        conflictingServerId: "server-2",
        conflictingServerName: "Survival"
      }
    }).runtimeControlsDisabledReason).toContain("Port 25565/tcp is also assigned to Survival");
  });

  it("explains a missing Docker socket only for internal nodes", () => {
    expect(resolveRuntimeGuards({ ...runtimeDefaults, activeServerUsesInternalNode: true, dockerSocketMounted: false }).runtimeControlsDisabledReason)
      .toBe("Docker socket is not mounted. Runtime controls are unavailable for the internal node.");
    expect(resolveRuntimeGuards({ ...runtimeDefaults, activeServerUsesInternalNode: false, dockerSocketMounted: false }).runtimeControlsDisabledReason).toBe("");
  });

  it("treats a running container as requiring a stop before config edits", () => {
    expect(resolveRuntimeGuards({ ...runtimeDefaults, activeStatus: serverStatus({ docker: { running: true, state: "running" } }) }).serverRequiresStoppedForMutableConfig).toBe(true);
  });

  it("treats an in-flight runtime action as requiring a stop", () => {
    expect(resolveRuntimeGuards({ ...runtimeDefaults, runtimeAction: "start" }).serverRequiresStoppedForMutableConfig).toBe(true);
  });

  it("allows edits for a container that has never been created", () => {
    const status = serverStatus({ docker: { state: "unknown", configured: false, running: false } });
    expect(resolveRuntimeGuards({ ...runtimeDefaults, activeStatus: status }).serverRequiresStoppedForMutableConfig).toBe(false);
  });

  it("uses the export lock reason for runtime controls", () => {
    expect(resolveRuntimeGuards({
      ...runtimeDefaults,
      exportMutationLocked: true,
      exportMutationBlockedReason: "Export in progress."
    }).runtimeControlsDisabledReason).toBe("Export in progress.");
  });

  it("allows edits when an available Docker reports the container does not exist", () => {
    const status = serverStatus({ docker: { state: "unknown", available: true, message: "configured container does not exist" } });
    expect(resolveRuntimeGuards({ ...runtimeDefaults, activeStatus: status }).serverRequiresStoppedForMutableConfig).toBe(false);
  });

  it("blocks edits for an unknown state it cannot explain away", () => {
    const status = serverStatus({ docker: { state: "unknown", available: true, message: "docker daemon unreachable" } });
    expect(resolveRuntimeGuards({ ...runtimeDefaults, activeStatus: status }).serverRequiresStoppedForMutableConfig).toBe(true);
  });
});

const settingsDefaults = {
  isProvisioning: false,
  dockerOperationalLock: false,
  serverRequiresStoppedForMutableConfig: false,
  canEditServerSettings: true,
  canDeleteServers: true,
  serverSettingsSaving: false,
  runtimeControlsDisabledReason: "",
  activeStatus: serverStatus()
};

describe("resolveServerSettingsGuards", () => {
  it("unlocks the form when the server is stopped and permissions allow it", () => {
    const guards = resolveServerSettingsGuards(settingsDefaults);
    expect(guards).toMatchObject({ serverSettingsLocked: false, deleteServerLocked: false, serverSettingsLockedReason: "" });
  });

  it("asks for a stop before mutable config changes", () => {
    expect(resolveServerSettingsGuards({ ...settingsDefaults, serverRequiresStoppedForMutableConfig: true }).serverSettingsLockedReason)
      .toBe(stoppedServerMutationMessage);
  });

  it("borrows the runtime reason when the runtime is locked", () => {
    expect(resolveServerSettingsGuards({ ...settingsDefaults, dockerOperationalLock: true, runtimeControlsDisabledReason: "Node is offline." }).serverSettingsLockedReason)
      .toBe("Node is offline.");
  });

  it("falls back to its own wording when the runtime gives no reason", () => {
    expect(resolveServerSettingsGuards({ ...settingsDefaults, dockerOperationalLock: true }).serverSettingsLockedReason)
      .toBe("Server settings are unavailable until the runtime reconnects.");
  });

  it("blocks deletion while the container is running", () => {
    const guards = resolveServerSettingsGuards({ ...settingsDefaults, activeStatus: serverStatus({ docker: { running: true, state: "running" } }) });
    expect(guards.deleteServerLocked).toBe(true);
  });

  it("locks settings and deletion during an export", () => {
    expect(resolveServerSettingsGuards({
      ...settingsDefaults,
      exportMutationLocked: true,
      exportMutationBlockedReason: "Export in progress."
    })).toMatchObject({
      serverSettingsLocked: true,
      deleteServerLocked: true,
      serverSettingsLockedReason: "Export in progress."
    });
  });
});
