import { ActionMenu, type ActionMenuItem } from "../components/ActionMenu";
import { DialogSurface } from "../components/DialogSurface";
import { AppIcon } from "../components/FileTypeIcon";
import { Button, StatusBadge } from "../components/UiPrimitives";
import type { ContextNode, ManagedNode, NodeManualRecovery, NodeOperation } from "../types";
import { formatBytes } from "../utils/format";
import { nodeDataPathLabel, nodeDockerLabel, nodeJoinTokenExpired, nodeWarnings } from "../utils/nodes";

type PrimaryActionKind = "operation" | "check" | "rotate-token" | "install" | "update" | null;

export function nodeDetailsPrimaryAction({
  node,
  operation,
  manualRecovery,
  updateAvailable,
  canManageNodes
}: {
  node: ManagedNode;
  operation?: NodeOperation;
  manualRecovery?: NodeManualRecovery;
  updateAvailable: boolean;
  canManageNodes: boolean;
}): PrimaryActionKind {
  if (operation?.phase === "waiting") return "operation";
  if (operation?.phase === "timed-out" || manualRecovery) return "check";
  if (nodeJoinTokenExpired(node) && canManageNodes) return "rotate-token";
  if (node.hasPendingJoinToken) return "install";
  if (updateAvailable && node.status === "online" && canManageNodes) return "update";
  return null;
}

export function nodeDetailsActionIds({
  node,
  contextNode,
  canManageNodes
}: {
  node: ManagedNode;
  contextNode?: ContextNode;
  canManageNodes: boolean;
}) {
  const ids = node.isInternal ? [] : ["install"];
  if (!node.isInternal && canManageNodes) ids.push("rotate-token");
  ids.push("refresh");
  if (canManageNodes) ids.push("restart");
  if (!node.isInternal && canManageNodes && contextNode) {
    ids.push("remove");
    if (contextNode.servers.length > 0) ids.push("force-remove");
  }
  return ids;
}

function formatNodeDate(value: string | undefined, formatter: (value: string | number | Date) => string) {
  return value ? formatter(value) : "Unknown";
}

function formatElapsedTime(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function shortBuildId(value?: string) {
  return value ? value.slice(0, 12) : "Unknown";
}

function valueTone(value?: string) {
  if (["online", "available", "ready"].includes(value || "")) return "ready";
  if (["offline", "unavailable", "missing"].includes(value || "")) return "limited";
  return "neutral";
}

function MoreIcon() {
  return (
    <svg className="buttonIcon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function NodeGlyph() {
  return (
    <span className="nodeDrawerGlyph" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="4" width="14" height="5" rx="1.5" />
        <rect x="5" y="15" width="14" height="5" rx="1.5" />
        <path d="M8 6.5h.1M8 17.5h.1M12 9v6" />
      </svg>
    </span>
  );
}

export type NodeDetailsDrawerProps = {
  node: ManagedNode;
  contextNode?: ContextNode;
  panelVersion: string;
  panelBuildId?: string;
  canManageNodes: boolean;
  busy: boolean;
  busyNodeId: string;
  operation?: NodeOperation;
  operationNow: number;
  operationGraceMs: number;
  manualRecovery?: NodeManualRecovery;
  updateAvailable: boolean;
  buildUpdateAvailable: boolean;
  panelUpdateRequired: boolean;
  versionMismatch: boolean;
  updateTitle: string;
  formatDate: (value: string | number | Date) => string;
  onClose: () => void;
  onShowInstall: (node: ManagedNode) => void;
  onRotateToken: (node: ManagedNode) => void;
  onUpdateNode: (node: ManagedNode) => void;
  onRefresh: () => void;
  onRestartNode: (node: ManagedNode) => void;
  onRemoveNode: (node: ContextNode, force?: boolean) => void;
  onCopy: (value: string) => void;
};

export function NodeDetailsDrawer({
  node,
  contextNode,
  panelVersion,
  panelBuildId,
  canManageNodes,
  busy,
  busyNodeId,
  operation,
  operationNow,
  operationGraceMs,
  manualRecovery,
  updateAvailable,
  buildUpdateAvailable,
  panelUpdateRequired,
  versionMismatch,
  updateTitle,
  formatDate,
  onClose,
  onShowInstall,
  onRotateToken,
  onUpdateNode,
  onRefresh,
  onRestartNode,
  onRemoveNode,
  onCopy
}: NodeDetailsDrawerProps) {
  const operationElapsedMs = operation ? Math.max(0, operationNow - operation.startedAt) : 0;
  const primaryAction = nodeDetailsPrimaryAction({ node, operation, manualRecovery, updateAvailable, canManageNodes });
  const nodeBusy = busyNodeId === node.id;
  const capabilities = node.capabilities?.length ? node.capabilities : [];
  const rawWarnings = nodeWarnings(node).filter((warning) => !((operation || manualRecovery) && warning === "Node is offline."));
  const warnings = [
    ...rawWarnings,
    ...(panelUpdateRequired ? [`Node agent ${node.agentVersion} is newer than this panel (${panelVersion}). Update the panel first.`] : []),
    ...(versionMismatch ? [`Node agent ${node.agentVersion} cannot be safely compared with panel ${panelVersion}. Update both to matching releases.`] : [])
  ];
  const statusTitle = operation?.phase === "waiting"
    ? operation.kind === "update" ? "Updating node" : "Restarting node"
    : operation?.phase === "timed-out"
      ? "Node did not reconnect"
      : manualRecovery
        ? "Manual update required"
        : node.status === "online"
          ? "Node online"
          : node.status === "offline" ? "Node offline" : "Waiting for node status";
  const statusDescription = operation?.phase === "waiting"
    ? `Waiting for the node to reconnect · ${formatElapsedTime(operationElapsedMs)} elapsed`
    : operation?.phase === "timed-out"
      ? `No reconnect was detected within ${Math.round(operationGraceMs / 60_000)} minutes. Check the node host, then try again.`
      : manualRecovery?.message
        ?? (node.status === "online" ? "The node is connected and ready for panel operations." : "Runtime actions remain unavailable until this node reconnects.");
  const statusTone = operation?.phase === "waiting" ? "working" : operation?.phase === "timed-out" || manualRecovery ? "attention" : node.status;
  const actionIds = new Set(nodeDetailsActionIds({ node, contextNode, canManageNodes }));

  const menuItems: ActionMenuItem[] = [];
  if (actionIds.has("install")) {
    menuItems.push({
      id: "install",
      label: "Install instructions",
      icon: <AppIcon name="download" />,
      onSelect: () => onShowInstall(node),
      disabled: nodeBusy,
      title: "Show commands for this node host"
    });
    if (actionIds.has("rotate-token")) {
      menuItems.push({
        id: "rotate-token",
        label: "Rotate join token",
        icon: <AppIcon name="refresh" />,
        onSelect: () => onRotateToken(node),
        disabled: nodeBusy || operation?.phase === "waiting",
        title: "Invalidate the current join token and create a replacement"
      });
    }
  }
  if (actionIds.has("refresh")) menuItems.push({
    id: "refresh",
    label: "Refresh status",
    icon: <AppIcon name="refresh" />,
    onSelect: onRefresh,
    disabled: busy,
    separatorBefore: menuItems.length > 0,
    title: "Reload node status"
  });
  if (actionIds.has("restart")) {
    menuItems.push({
      id: "restart",
      label: node.isInternal ? "Restart Panel" : "Restart node",
      icon: <AppIcon name="refresh" />,
      onSelect: () => onRestartNode(node),
      disabled: nodeBusy || operation?.phase === "waiting" || (!node.isInternal && node.status !== "online"),
      title: !node.isInternal && node.status !== "online" ? "Bring the node online before restarting" : "Restart the node container"
    });
  }
  if (actionIds.has("remove") && contextNode) {
    menuItems.push({
      id: "remove",
      label: "Remove node",
      icon: <AppIcon name="trash" />,
      onSelect: () => onRemoveNode(contextNode),
      disabled: nodeBusy,
      critical: true,
      separatorBefore: true,
      title: contextNode.servers.length ? "Remove managed server containers and panel records for this node" : "Remove this node from the panel"
    });
    if (actionIds.has("force-remove")) {
      menuItems.push({
        id: "force-remove",
        label: "Force remove node",
        icon: <AppIcon name="trash" />,
        onSelect: () => onRemoveNode(contextNode, true),
        disabled: nodeBusy,
        critical: true,
        title: "Remove stale records even when container cleanup cannot finish"
      });
    }
  }

  return (
    <DialogSurface className="nodeDetailsDrawer" labelledBy="node-details-title" describedBy="node-details-description" onClose={onClose}>
      <header className="nodeDrawerHeader">
        <div className="nodeDrawerTitle">
          <NodeGlyph />
          <div>
            <div className="nodeDrawerTitleLine">
              <h2 id="node-details-title">{node.name}</h2>
              <StatusBadge tone={operation?.phase === "waiting" ? "accent" : operation?.phase === "timed-out" ? "danger" : node.status === "online" ? "success" : node.status === "offline" ? "danger" : "neutral"}>
                {operation?.phase === "waiting" && <span className="nodeOperationBadgeSpinner" aria-hidden="true" />}
                {operation?.phase === "waiting" ? operation.kind === "update" ? "Updating" : "Restarting" : operation?.phase === "timed-out" ? "Attention" : node.status}
              </StatusBadge>
            </div>
            <p id="node-details-description">{node.isInternal ? "Internal panel node" : "Remote node"}</p>
          </div>
        </div>
        <Button variant="secondary" iconOnly className="iconButton nodeDrawerClose" onClick={onClose} aria-label="Close node details"><AppIcon name="x" /></Button>
      </header>

      <div className="nodeDrawerBody">
        <section className={`nodeOperationStatus ${statusTone}`} aria-live="polite" aria-atomic="true">
          <span className="nodeOperationStatusIcon" aria-hidden="true">
            {operation?.phase === "waiting" ? <span className="nodeOperationSpinner" /> : <span className={`nodeStatusDot ${node.status}`} />}
          </span>
          <div>
            <strong>{statusTitle}</strong>
            <p>{statusDescription}</p>
            {node.status !== "unknown" && (operation || manualRecovery) && <small>Last reported status: {node.status}</small>}
          </div>
        </section>

        {manualRecovery?.command && (
          <section className="nodeManualCommand" aria-label="Manual update command">
            <div><strong>Run on the node host</strong>{manualRecovery.image && <span>{manualRecovery.image}</span>}</div>
            <code>{manualRecovery.command}</code>
            <Button variant="secondary" compact onClick={() => onCopy(manualRecovery.command || "")}><AppIcon name="copy" />Copy</Button>
          </section>
        )}

        {warnings.length > 0 && (
          <section className="nodeDrawerNotice" aria-label="Node warnings">
            <strong>Needs attention</strong>
            <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          </section>
        )}

        <section className="nodeDrawerSection" aria-labelledby="node-health-title">
          <h3 id="node-health-title">Health and runtime</h3>
          <dl className="nodeDrawerFacts">
            <div><dt>Docker</dt><dd className={valueTone(node.dockerStatus)}>{nodeDockerLabel(node)}</dd></div>
            <div><dt>Data path</dt><dd className={valueTone(node.dataPathStatus)}>{nodeDataPathLabel(node)}</dd></div>
            <div><dt>Agent version</dt><dd>{node.agentVersion || "Unknown"}</dd></div>
            <div><dt>Panel version</dt><dd>{panelVersion || "Unknown"}</dd></div>
            <div><dt>Host memory</dt><dd>{node.totalMemory ? formatBytes(node.totalMemory) : "Unknown"}</dd></div>
            <div><dt>Last seen</dt><dd>{formatNodeDate(node.lastSeenAt ?? node.connectedAt, formatDate)}</dd></div>
          </dl>
        </section>

        <details className="nodeTechnicalDetails">
          <summary><span>Technical details</span><span>{capabilities.length} capabilities</span></summary>
          <dl className="nodeDrawerFacts technical">
            <div><dt>Node ID</dt><dd><code>{node.id}</code></dd></div>
            <div><dt>Type</dt><dd>{node.type}</dd></div>
            <div><dt>Agent build</dt><dd><code>{shortBuildId(node.buildId)}</code></dd></div>
            <div><dt>Panel build</dt><dd><code>{shortBuildId(panelBuildId)}</code></dd></div>
            <div><dt>Protocol</dt><dd>{node.protocolVersion || "Unknown"}</dd></div>
            <div><dt>Created</dt><dd>{formatNodeDate(node.createdAt, formatDate)}</dd></div>
            <div><dt>Updated</dt><dd>{formatNodeDate(node.updatedAt, formatDate)}</dd></div>
            <div><dt>Connected</dt><dd>{formatNodeDate(node.connectedAt, formatDate)}</dd></div>
          </dl>
          <div className="nodeCapabilityDetails">
            <strong>Capabilities</strong>
            <div>{capabilities.length ? capabilities.map((capability) => <code key={capability}>{capability}</code>) : <span>None advertised</span>}</div>
          </div>
        </details>
      </div>

      <footer className="nodeDrawerFooter">
        <ActionMenu
          label="More node actions"
          className="nodeDrawerActionMenu"
          trigger={<MoreIcon />}
          items={menuItems}
          disabled={menuItems.length === 0}
          align="start"
        />
        <div className="nodeDrawerPrimaryAction">
          {primaryAction === "operation" && <Button disabled><span className="buttonSpinner" aria-hidden="true" />{operation?.kind === "update" ? "Updating…" : "Restarting…"}</Button>}
          {primaryAction === "check" && <Button onClick={onRefresh} disabled={busy}><AppIcon name="refresh" />Check again</Button>}
          {primaryAction === "rotate-token" && <Button onClick={() => onRotateToken(node)} disabled={nodeBusy}><AppIcon name="refresh" />Rotate token</Button>}
          {primaryAction === "install" && <Button onClick={() => onShowInstall(node)} disabled={nodeBusy}><AppIcon name="download" />Install instructions</Button>}
          {primaryAction === "update" && <Button onClick={() => onUpdateNode(node)} disabled={nodeBusy} title={updateTitle}><AppIcon name="arrowUp" />{buildUpdateAvailable ? "Update node" : "Upgrade node"}</Button>}
        </div>
      </footer>
    </DialogSurface>
  );
}
