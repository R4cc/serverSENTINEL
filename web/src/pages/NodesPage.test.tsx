import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ContextNode, ManagedServer } from "../types";
import { AddNodeModal, NodesPage, validateAddNodeInput } from "./NodesPage";

const validInput = {
  name: "Games host",
  panelUrl: "https://panel.example.com",
  dataMount: "/var/lib/serversentinel"
};

function renderAddNodeModal(browserPanelUrl: string) {
  return renderToStaticMarkup(
    <AddNodeModal
      busy={false}
      browserPanelUrl={browserPanelUrl}
      created={null}
      installMethod="run"
      onInstallMethodChange={vi.fn()}
      onClose={vi.fn()}
      onDone={vi.fn()}
      onCreate={vi.fn()}
      onCopy={vi.fn()}
      formatDate={(value) => String(value)}
    />
  );
}

describe("new node panel address", () => {
  it("accepts panel addresses that a different host can use", () => {
    expect(validateAddNodeInput(validInput)).toBe("");
    expect(validateAddNodeInput({ ...validInput, panelUrl: "http://192.168.1.50:8080" })).toBe("");
  });

  it.each([
    "http://localhost:8080",
    "http://node.localhost:8080",
    "http://127.0.0.1:8080",
    "http://0.0.0.0:8080",
    "http://[::1]:8080"
  ])("rejects the local-only address %s", (panelUrl) => {
    expect(validateAddNodeInput({ ...validInput, panelUrl })).toMatch(/node itself|another computer/);
  });

  it("starts empty and explains why a browser localhost address is not copied", () => {
    const html = renderAddNodeModal("http://localhost:8080");

    expect(html).toContain("How the node connects");
    expect(html).toContain("This is the panel&#x27;s address, not the new node&#x27;s address.");
    expect(html).toContain("local-only address");
    expect(html).not.toContain("Use this address");
    expect(html).toContain('name="panelUrl" value=""');
    expect(html).toContain("Create install command");
  });

  it("offers a non-loopback browser address as an explicit choice instead of a default", () => {
    const html = renderAddNodeModal("https://panel.example.com");

    expect(html).toContain("Use this address");
    expect(html).toContain('name="panelUrl" value=""');
  });
});

function denseServer(nodeId: string, nodeIndex: number, serverIndex: number): ManagedServer {
  const timestamp = "2026-07-29T12:00:00.000Z";
  return {
    id: `20000000-0000-4000-8000-${String(nodeIndex * 100 + serverIndex).padStart(12, "0")}`,
    nodeId,
    displayName: `Server ${nodeIndex}-${serverIndex}`,
    directoryLabel: `/servers/${nodeIndex}-${serverIndex}`,
    runtimeProfile: {
      minecraftVersion: "1.21.4",
      runtimeType: "paper",
      runtimeVersion: "1.21.4",
      javaMajorVersion: 21,
      jarProvider: "papermc",
      jarArtifact: { filename: "paper.jar" },
      compatibilityStatus: "compatible",
      resolvedAt: timestamp
    },
    hasDockerContainer: true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function denseNode(nodeIndex: number, serverCount = 12): ContextNode {
  const id = `10000000-0000-4000-8000-${String(nodeIndex).padStart(12, "0")}`;
  return {
    id,
    name: `Compute node ${nodeIndex}`,
    type: "remote",
    status: nodeIndex % 3 === 0 ? "offline" : "online",
    isInternal: false,
    agentVersion: "1.7.0",
    dockerStatus: nodeIndex % 3 === 0 ? "unavailable" : "available",
    dataPathStatus: nodeIndex % 3 === 0 ? "unavailable" : "ready",
    servers: Array.from({ length: serverCount }, (_, serverIndex) => denseServer(id, nodeIndex, serverIndex + 1))
  };
}

function renderDenseNodesPage(nodes: ContextNode[]) {
  const props: ComponentProps<typeof NodesPage> = {
    nodes,
    panelVersion: "1.7.0",
    panelBuildId: "test-build",
    canManageNodes: true,
    busy: false,
    busyNodeId: "",
    browserPanelUrl: "https://panel.example.com",
    selectedNode: null,
    nodeOperations: {},
    nodeOperationNow: Date.now(),
    nodeUpdateGraceMs: 30_000,
    nodeManualRecoveryById: {},
    installResult: null,
    addNodeOpen: false,
    addNodeResult: null,
    installMethod: "run",
    onInstallMethodChange: vi.fn(),
    onOpenAddNode: vi.fn(),
    onCloseAddNode: vi.fn(),
    onDoneAddNode: vi.fn(),
    onCreateNode: vi.fn(),
    onRefresh: vi.fn(),
    onViewDetails: vi.fn(),
    onShowInstall: vi.fn(),
    onRotateToken: vi.fn(),
    onUpdateNode: vi.fn(),
    onRestartNode: vi.fn(),
    onRemoveNode: vi.fn(),
    onCloseDetails: vi.fn(),
    onSelectServer: vi.fn(),
    onAddServer: vi.fn(),
    canImportServers: true,
    onImportServers: vi.fn(),
    onClearInstall: vi.fn(),
    onCopy: vi.fn(),
    serverStateLabel: (serverId) => serverId.endsWith("1") ? "RUNNING" : "STOPPED",
    playerSnapshots: {},
    formatDate: (value) => String(value)
  };
  return renderToStaticMarkup(<NodesPage {...props} />);
}

describe("dense node fleets", () => {
  it("keeps nodes as list rows and limits each initial server list", () => {
    const html = renderDenseNodesPage(Array.from({ length: 8 }, (_, index) => denseNode(index + 1)));

    expect(html.match(/class="nodeListItem"/g)).toHaveLength(8);
    expect(html.match(/class="nodeServerRow"/g)).toHaveLength(8 * 6);
    expect(html.match(/Show all 12 servers/g)).toHaveLength(8);
    expect(html).toContain('role="list"');
    expect(html).not.toContain('class="nodeTile"');
    expect(html).not.toContain("nodeServerTile");
  });

  it("sizes every toolbar action the same", () => {
    const html = renderDenseNodesPage([denseNode(1)]);
    const toolbar = html.slice(html.indexOf('class="uiToolbar nodesToolbar"'), html.indexOf("nodesBoard"));

    // `uiButton--compact` is 32px against the 40px the other two stand at, so one compact button in
    // the row leaves Import server shorter than the Refresh button beside it.
    expect(toolbar).toContain("Import server");
    expect(toolbar).toContain("Refresh");
    expect(toolbar).toContain("Add node");
    expect(toolbar).not.toContain("uiButton--compact");
  });
});
