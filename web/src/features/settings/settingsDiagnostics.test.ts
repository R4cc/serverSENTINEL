import { describe, expect, it } from "vitest";
import type { ManagedNode } from "../../types";
import { buildSystemDiagnostics, summarizeSettingsSystemInfo, type SettingsSystemInfo } from "./settingsDiagnostics";

const nodes: ManagedNode[] = [
  {
    id: "secret-node-id",
    name: "private-production-node",
    type: "remote",
    status: "online",
    isInternal: false,
    agentVersion: "1.2.1",
    protocolVersion: "2",
    compatibility: "compatible",
    dataPathStatus: "C:/private/server/path"
  },
  {
    id: "another-secret-id",
    name: "customer-node-name",
    type: "remote",
    status: "offline",
    isInternal: false,
    agentVersion: "1.2.0",
    protocolVersion: "2",
    compatibility: "incompatible"
  }
];

const info: SettingsSystemInfo = {
  panelVersion: "1.2.1",
  buildId: "abc123",
  runtimeMode: "panel",
  panelTimeZone: "Europe/Vienna",
  displayTimeZone: "UTC",
  dockerSocketMounted: false,
  panelOnlyMode: true,
  demoMode: false,
  serverCount: 4,
  nodes,
  totalMemory: 16 * 1024 * 1024 * 1024,
  modrinthConfigured: true
};

describe("settings system diagnostics", () => {
  it("summarizes node health, compatibility, and versions", () => {
    const summary = summarizeSettingsSystemInfo(info);
    expect(summary).toMatchObject({
      nodeCount: 2,
      onlineNodeCount: 1,
      compatibleNodeCount: 1,
      incompatibleNodeCount: 1,
      unknownCompatibilityCount: 0,
      protocolVersions: "2 (2)",
      dockerStatus: "Not required (remote-node mode)"
    });
    expect(summary.agentVersions).toContain("1.2.0 (1)");
    expect(summary.agentVersions).toContain("1.2.1 (1)");
  });

  it("copies aggregate diagnostics without identifiers, paths, or secrets", () => {
    const output = buildSystemDiagnostics(info, new Date("2026-07-14T12:00:00.000Z"));
    expect(output).toContain("Generated: 2026-07-14T12:00:00.000Z");
    expect(output).toContain("Nodes online: 1/2");
    expect(output).toContain("Node compatibility: 1 compatible, 1 incompatible, 0 unknown");
    expect(output).not.toContain("private-production-node");
    expect(output).not.toContain("customer-node-name");
    expect(output).not.toContain("secret-node-id");
    expect(output).not.toContain("C:/private/server/path");
  });
});
