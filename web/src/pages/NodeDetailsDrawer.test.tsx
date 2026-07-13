import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ContextNode, ManagedNode, NodeOperation } from "../types";
import { NodeDetailsDrawer, nodeDetailsActionIds, nodeDetailsPrimaryAction, type NodeDetailsDrawerProps } from "./NodeDetailsDrawer";

function node(overrides: Partial<ManagedNode> = {}): ManagedNode {
  return {
    id: "node-1",
    name: "mc-node-01",
    type: "remote",
    status: "online",
    isInternal: false,
    agentVersion: "1.2.0",
    buildId: "1234567890abcdef",
    protocolVersion: "2.0",
    dockerStatus: "available",
    dataPathStatus: "ready",
    compatibility: "compatible",
    totalMemory: 8 * 1024 * 1024 * 1024,
    lastSeenAt: "2026-07-13T18:00:00.000Z",
    capabilities: ["server.start", "files.read"],
    ...overrides
  };
}

function contextNode(overrides: Partial<ContextNode> = {}): ContextNode {
  return { ...node(), servers: [], ...overrides };
}

function operation(overrides: Partial<NodeOperation> = {}): NodeOperation {
  return {
    kind: "update",
    phase: "waiting",
    startedAt: 1_000,
    targetVersion: "1.2.0",
    ...overrides
  };
}

function props(overrides: Partial<NodeDetailsDrawerProps> = {}): NodeDetailsDrawerProps {
  const selected = overrides.node ?? node();
  return {
    node: selected,
    contextNode: contextNode({ ...selected }),
    panelVersion: "1.2.0",
    panelBuildId: "1234567890abcdef",
    canManageNodes: true,
    busy: false,
    busyNodeId: "",
    operationNow: 10_000,
    operationGraceMs: 300_000,
    updateAvailable: false,
    buildUpdateAvailable: false,
    panelUpdateRequired: false,
    versionMismatch: false,
    updateTitle: "Node agent is already current",
    formatDate: (value) => String(value),
    onClose: vi.fn(),
    onShowInstall: vi.fn(),
    onRotateToken: vi.fn(),
    onUpdateNode: vi.fn(),
    onRefresh: vi.fn(),
    onRestartNode: vi.fn(),
    onRemoveNode: vi.fn(),
    onCopy: vi.fn(),
    ...overrides
  };
}

describe("node details action model", () => {
  it("chooses only the most relevant primary action", () => {
    const selected = node({ agentVersion: "1.1.0" });
    expect(nodeDetailsPrimaryAction({ node: selected, updateAvailable: true, canManageNodes: true })).toBe("update");
    expect(nodeDetailsPrimaryAction({ node: node({ hasPendingJoinToken: true }), updateAvailable: false, canManageNodes: true })).toBe("install");
    expect(nodeDetailsPrimaryAction({ node: node({ hasPendingJoinToken: true, joinTokenExpiresAt: "2000-01-01T00:00:00.000Z" }), updateAvailable: false, canManageNodes: true })).toBe("rotate-token");
    expect(nodeDetailsPrimaryAction({ node: selected, operation: operation(), updateAvailable: true, canManageNodes: true })).toBe("operation");
    expect(nodeDetailsPrimaryAction({ node: selected, operation: operation({ phase: "timed-out" }), updateAvailable: true, canManageNodes: true })).toBe("check");
    expect(nodeDetailsPrimaryAction({ node: selected, manualRecovery: { message: "Update on the host" }, updateAvailable: true, canManageNodes: true })).toBe("check");
    expect(nodeDetailsPrimaryAction({ node: selected, updateAvailable: true, canManageNodes: false })).toBeNull();
  });

  it("hides actions that do not apply to the node or permission level", () => {
    expect(nodeDetailsActionIds({ node: node(), contextNode: contextNode(), canManageNodes: false })).toEqual(["install", "refresh"]);
    expect(nodeDetailsActionIds({ node: node({ isInternal: true, type: "local" }), canManageNodes: true })).toEqual(["refresh", "restart"]);
    expect(nodeDetailsActionIds({ node: node(), contextNode: contextNode({ servers: [{} as ContextNode["servers"][number]] }), canManageNodes: true })).toEqual([
      "install", "rotate-token", "refresh", "restart", "remove", "force-remove"
    ]);
  });
});

describe("NodeDetailsDrawer", () => {
  it("renders a summary-first drawer with collapsed technical details", () => {
    const html = renderToStaticMarkup(<NodeDetailsDrawer {...props()} />);

    expect(html).toContain('role="dialog"');
    expect(html).toContain("mc-node-01");
    expect(html).toContain("Node online");
    expect(html).toContain("Health and runtime");
    expect(html).toContain("Agent version");
    expect(html).toContain('<details class="nodeTechnicalDetails">');
    expect(html).toContain("2 capabilities");
    expect(html).toContain('aria-label="More node actions"');
    expect(html).not.toContain("Update node</button>");
  });

  it("keeps update progress in the permanent status area and suppresses the expected offline warning", () => {
    const selected = node({ status: "offline" });
    const html = renderToStaticMarkup(<NodeDetailsDrawer {...props({ node: selected, contextNode: contextNode({ ...selected }), operation: operation() })} />);

    expect(html).toContain("Updating node");
    expect(html).toContain("0:09 elapsed");
    expect(html).toContain("Last reported status: offline");
    expect(html).toContain("Updating…");
    expect(html).not.toContain("<li>Node is offline.</li>");
  });

  it("renders manual recovery details with a copyable command", () => {
    const html = renderToStaticMarkup(<NodeDetailsDrawer {...props({
      manualRecovery: {
        message: "Node is offline. Update it on the node host.",
        image: "ghcr.io/example/node:1.2.0",
        command: "docker pull ghcr.io/example/node:1.2.0"
      }
    })} />);

    expect(html).toContain("Manual update required");
    expect(html).toContain("Run on the node host");
    expect(html).toContain("docker pull ghcr.io/example/node:1.2.0");
    expect(html).toContain("Check again");
  });
});
