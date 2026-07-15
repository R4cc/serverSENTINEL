import { FormEvent, useEffect, useMemo, useState } from "react";
import { InlineState } from "../components/InlineState";
import { AppIcon } from "../components/FileTypeIcon";
import { Button, EmptyState, StatusBadge } from "../components/UiPrimitives";
import { DialogSurface } from "../components/DialogSurface";
import type { ContextNode, CreateNodeResponse, ManagedNode, NodeInstallInstructions, NodeInstallResponse, NodeManualRecovery, NodeOperation, ServerActivity } from "../types";
import { defaultNodeDataPath } from "../app/appConfig";
import { isNodeRuntimeUsable, nodeBlockReason } from "../utils/nodes";
import { NodeDetailsDrawer } from "./NodeDetailsDrawer";

type AddNodeInput = {
  name: string;
  panelUrl: string;
  dataMount: string;
};

const collapsedServerLimit = 4;

function formatNodeDate(value: string | undefined, formatter: (value: string | number | Date) => string) {
  if (!value) return "Never";
  return formatter(value);
}

function statusTone(value?: string) {
  if (value === "online" || value === "available" || value === "ready") return "ready";
  if (value === "offline" || value === "unavailable" || value === "missing") return "limited";
  return "";
}

function sharedStatusTone(value?: string): "success" | "danger" | "neutral" {
  const tone = statusTone(value);
  return tone === "ready" ? "success" : tone === "limited" ? "danger" : "neutral";
}

function shortBuildId(value?: string) {
  return value ? value.slice(0, 12) : undefined;
}

function ServerRowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
      <path d="m4 7 8 4 8-4" />
      <path d="M12 11v10" />
    </svg>
  );
}

function PlayerIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8" r="3" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
    </svg>
  );
}

function playerCountLabel(activity?: ServerActivity) {
  if (!activity || activity.playersOnline === null || activity.playersOnline === undefined) return "-";
  return activity.maxPlayers ? `${activity.playersOnline}/${activity.maxPlayers}` : String(activity.playersOnline);
}

function compareVersions(left?: string, right?: string) {
  if (!left || !right) return null;
  const parse = (value: string) => {
    const match = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return left === right ? 0 : null;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

function validateAddNodeInput(input: AddNodeInput) {
  const name = input.name.trim();
  const panelUrl = input.panelUrl.trim();
  const dataMount = input.dataMount.trim();
  if (name.length > 80 || /[\u0000-\u001f]/.test(name)) {
    return "Node name must be 80 characters or fewer.";
  }
  if (!panelUrl) {
    return "Panel URL is required so the node can connect back.";
  }
  try {
    const url = new URL(panelUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "Panel URL must start with http:// or https://.";
    }
    if (url.username || url.password) {
      return "Panel URL cannot include a username or password.";
    }
  } catch {
    return "Panel URL must be a valid URL reachable from the node host.";
  }
  if (!dataMount) {
    return "Data folder is required.";
  }
  if (dataMount.length > 512 || /[\r\n\u0000]/.test(dataMount)) {
    return "Data folder must be a single-line host path or host:container mount.";
  }
  return "";
}

function dockerComposeSnippet(install: NodeInstallInstructions) {
  const env = Object.entries(install.dockerCompose.environment)
    .map(([key, value]) => `      ${key}: ${value}`)
    .join("\n");
  const volumes = install.dockerCompose.volumes.map((volume) => `      - ${volume}`).join("\n");
  return `services:
  serversentinel-node:
    image: ${install.dockerCompose.image}
    container_name: serversentinel-node
    restart: unless-stopped
    environment:
${env}
    volumes:
${volumes}`;
}

function InstallInstructions({
  result,
  method,
  onMethodChange,
  onCopy,
  formatDate
}: {
  result: CreateNodeResponse | NodeInstallResponse;
  method: "compose" | "run";
  onMethodChange: (method: "compose" | "run") => void;
  onCopy: (text: string) => void;
  formatDate: (value: string | number | Date) => string;
}) {
  const snippet = method === "compose" ? dockerComposeSnippet(result.install) : result.install.dockerRun;
  const expiresAt = "expiresAt" in result ? result.expiresAt : result.node.joinTokenExpiresAt;

  return (
    <section className="nodeInstallBox">
      <div className="nodeInstallHeader">
        <div>
          <h3>Install {result.node.name}</h3>
          <p>{expiresAt ? `Join token expires ${formatNodeDate(expiresAt, formatDate)}` : result.install.tokenRequired ? "Rotate the join token before installing this node." : "Token is not included in this snippet."}</p>
          {result.install.joinToken && <p className="sensitiveHint">This command contains a secret join token. Copy it only to the node host.</p>}
        </div>
      </div>
      <div className="installTabs" role="tablist" aria-label="Install method">
        <Button variant="ghost" compact className={method === "run" ? "active" : ""} onClick={() => onMethodChange("run")}>docker run Recommended</Button>
        <Button variant="ghost" compact className={method === "compose" ? "active" : ""} onClick={() => onMethodChange("compose")}>Docker Compose</Button>
      </div>
      <div className="installSnippetShell">
        <Button variant="secondary" iconOnly className="installCopyButton" onClick={() => onCopy(snippet)} aria-label="Copy install command" title="Copy install command">
          <AppIcon name="copy" />
        </Button>
        <pre className="installSnippet"><code>{snippet}</code></pre>
      </div>
    </section>
  );
}

const addNodeSteps = ["Create node", "Run install", "Connect", "Verify", "Ready"];

type AddNodeFlowState = "waiting" | "success" | "expired" | "disconnected";

function isAddNodeSuccess(node?: ManagedNode) {
  return Boolean(node && node.status === "online" && isNodeRuntimeUsable(node));
}

function addNodeFlowState(node: ManagedNode | undefined, expiresAt: string): AddNodeFlowState {
  if (isAddNodeSuccess(node)) return "success";
  if (node?.status === "offline" && node.connectedAt) return "disconnected";
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) return "expired";
  return "waiting";
}

function addNodeActiveStep(flowState: AddNodeFlowState) {
  if (flowState === "success") return 5;
  if (flowState === "disconnected") return 3;
  return 2;
}

function AddNodeStepper({ activeStep, completeAll }: { activeStep: number; completeAll: boolean }) {
  const completedUntil = completeAll ? addNodeSteps.length : Math.max(1, activeStep - 1);

  return (
    <ol className="addNodeStepper" aria-label="Add node progress">
      {addNodeSteps.map((label, index) => {
        const stepNumber = index + 1;
        const isComplete = stepNumber <= completedUntil;
        const isActive = !completeAll && stepNumber === activeStep;
        return (
          <li key={label} className={`addNodeStep ${isComplete ? "complete" : ""} ${isActive ? "active" : ""}`}>
            {index > 0 && <span className={`addNodeConnector ${index <= completedUntil ? "complete" : ""}`} aria-hidden="true" />}
            <span className="addNodeStepContent">
              <span className="addNodeStepCircle" aria-hidden="true">{isComplete ? "✓" : stepNumber}</span>
              <span className="addNodeStepLabel">{label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function AddNodeStatusCard({ nodeName, flowState }: { nodeName: string; flowState: AddNodeFlowState; node?: ManagedNode }) {
  if (flowState === "success") {
    return (
      <div className="addNodeStatusCard success">
        <span className="addNodeStatusIcon" aria-hidden="true">✓</span>
        <div>
          <h3>Node added successfully</h3>
          <p>{nodeName} is now connected to this panel and ready to host servers.</p>
          <p>You can close this dialog and manage the node from the Nodes page.</p>
        </div>
      </div>
    );
  }

  if (flowState === "expired") {
    return (
      <div className="addNodeStatusCard error">
        <span className="addNodeStatusIcon" aria-hidden="true">!</span>
        <div>
          <h3>Join token expired</h3>
          <p>The join token for {nodeName} expired before the node connected. Rotate the token or create a new pending node, then run the updated install command.</p>
        </div>
      </div>
    );
  }

  if (flowState === "disconnected") {
    return (
      <div className="addNodeStatusCard error">
        <span className="addNodeStatusIcon" aria-hidden="true">!</span>
        <div>
          <h3>Node disconnected</h3>
          <p>{nodeName} connected once, but it is offline now. Check the node host and run the install command again if needed.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="addNodeStatusCard waiting" role="status" aria-live="polite">
      <span className="addNodeSpinner" aria-hidden="true" />
      <div>
        <h3>Waiting for node connection</h3>
        <p>Run the install command on the host, then wait for the node to connect to this panel.</p>
      </div>
    </div>
  );
}

function AddNodeModal({
  busy,
  defaultPanelUrl,
  created,
  currentNode,
  installMethod,
  onInstallMethodChange,
  onClose,
  onDone,
  onCreate,
  onCopy,
  formatDate
}: {
  busy: boolean;
  defaultPanelUrl: string;
  created: CreateNodeResponse | null;
  currentNode?: ManagedNode;
  installMethod: "compose" | "run";
  onInstallMethodChange: (method: "compose" | "run") => void;
  onClose: () => void;
  onDone: () => void;
  onCreate: (input: AddNodeInput) => void;
  onCopy: (text: string) => void;
  formatDate: (value: string | number | Date) => string;
}) {
  const [name, setName] = useState("");
  const [panelUrl, setPanelUrl] = useState(defaultPanelUrl);
  const [dataMount, setDataMount] = useState(defaultNodeDataPath);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    if (!panelUrl) setPanelUrl(defaultPanelUrl);
  }, [defaultPanelUrl, panelUrl]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const input = { name: name.trim(), panelUrl: panelUrl.trim(), dataMount: dataMount.trim() };
    const error = validateAddNodeInput(input);
    if (error) {
      setFormError(error);
      return;
    }
    setFormError("");
    onCreate(input);
  }

  const liveNode = currentNode ?? created?.node;
  const flowState = created ? addNodeFlowState(liveNode, created.expiresAt) : "waiting";
  const isSuccess = flowState === "success";
  const activeStep = addNodeActiveStep(flowState);
  const showInstall = Boolean(created && flowState !== "success");
  const canClose = !busy;

  return (
    <div className="modalBackdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && canClose) onClose();
    }}>
      <DialogSurface className="modalPanel nodeModalPanel" labelledBy="add-node-title" onClose={onClose}>
        <header className="nodeModalHeader">
          <div>
            <h2 id="add-node-title">Add node</h2>
            <p>Create a remote node and connect it to this panel.</p>
          </div>
          <Button
            variant="secondary"
            iconOnly
            className="iconButton modalCloseButton"
            onClick={onClose}
            disabled={!canClose}
            aria-label="Close add node modal"
            title={canClose ? "Close add node modal" : "Node creation is still in progress"}
          >
            <AppIcon name="x" />
          </Button>
        </header>

        {!created ? (
          <form className="appForm nodeModalBody" onSubmit={submit}>
            <fieldset disabled={busy}>
              {formError && <InlineState tone="error" title="Check node details" message={formError} />}
              <label>
                Node name
                <input name="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="MC-NODE-01" maxLength={80} required />
              </label>
              <label>
                Panel URL reachable from the node
                <input name="panelUrl" value={panelUrl} onChange={(event) => setPanelUrl(event.target.value)} placeholder="https://panel.example.com" required />
              </label>
              <label>
                <span className="fieldLabelWithInfo">
                  Data folder on node
                  <span className="roleInfoWrap">
                    <Button variant="ghost" iconOnly className="roleInfoButton" aria-label="About the node data folder" aria-describedby="node-data-folder-tip">i</Button>
                    <span id="node-data-folder-tip" role="tooltip" className="roleTooltip fieldTooltip">
                      Folder on the node host where Minecraft server files, worlds, mods, logs, and configs are stored. The installer mounts this folder into the node container.
                    </span>
                  </span>
                </span>
                <input name="dataMount" value={dataMount} onChange={(event) => setDataMount(event.target.value)} placeholder={defaultNodeDataPath} required />
              </label>
              <div className="nodeModalFooter inline">
                <Button type="submit" reserveLabel="Create pending node">{busy ? "Creating..." : "Create pending node"}</Button>
                <Button variant="secondary" onClick={onClose} disabled={!canClose} title={canClose ? "Cancel node creation" : "Node creation is still in progress"}>Cancel</Button>
              </div>
            </fieldset>
          </form>
        ) : (
          <div className="nodeModalBody">
            <AddNodeStepper activeStep={activeStep} completeAll={isSuccess} />
            <AddNodeStatusCard nodeName={created.node.name} flowState={flowState} node={liveNode} />
            {showInstall && <InstallInstructions result={created} method={installMethod} onMethodChange={onInstallMethodChange} onCopy={onCopy} formatDate={formatDate} />}
            <div className={`nodeModalFooter inline addNodeModalActions ${isSuccess ? "success" : ""}`}>
              <Button onClick={isSuccess ? onDone : onClose} disabled={!canClose} title={canClose ? (isSuccess ? "Finish node setup" : "Close and finish later") : "Node creation is still in progress"}>{isSuccess ? "Done" : "Finish later"}</Button>
            </div>
          </div>
        )}
      </DialogSurface>
    </div>
  );
}

export function NodesPage({
  nodes,
  panelVersion,
  panelBuildId,
  canManageNodes,
  busy,
  busyNodeId,
  defaultPanelUrl,
  selectedNode,
  nodeOperations,
  nodeOperationNow,
  nodeUpdateGraceMs,
  nodeManualRecoveryById,
  installResult,
  addNodeOpen,
  addNodeResult,
  installMethod,
  onInstallMethodChange,
  onOpenAddNode,
  onCloseAddNode,
  onDoneAddNode,
  onCreateNode,
  onRefresh,
  onViewDetails,
  onShowInstall,
  onRotateToken,
  onUpdateNode,
  onRestartNode,
  onRemoveNode,
  onCloseDetails,
  onSelectServer,
  onAddServer,
  onClearInstall,
  onCopy,
  serverStateLabel,
  serverActivities,
  formatDate
}: {
  nodes: ContextNode[];
  panelVersion: string;
  panelBuildId?: string;
  canManageNodes: boolean;
  busy: boolean;
  busyNodeId: string;
  defaultPanelUrl: string;
  selectedNode: ManagedNode | null;
  nodeOperations: Record<string, NodeOperation>;
  nodeOperationNow: number;
  nodeUpdateGraceMs: number;
  nodeManualRecoveryById: Record<string, NodeManualRecovery>;
  installResult: NodeInstallResponse | CreateNodeResponse | null;
  addNodeOpen: boolean;
  addNodeResult: CreateNodeResponse | null;
  installMethod: "compose" | "run";
  onInstallMethodChange: (method: "compose" | "run") => void;
  onOpenAddNode: () => void;
  onCloseAddNode: () => void;
  onDoneAddNode: () => void;
  onCreateNode: (input: AddNodeInput) => void;
  onRefresh: () => void;
  onViewDetails: (node: ManagedNode) => void;
  onShowInstall: (node: ManagedNode) => void;
  onRotateToken: (node: ManagedNode) => void;
  onUpdateNode: (node: ManagedNode) => void;
  onRestartNode: (node: ManagedNode) => void;
  onRemoveNode: (node: ContextNode, force?: boolean) => void;
  onCloseDetails: () => void;
  onSelectServer: (serverId: string) => void;
  onAddServer: (nodeId: string) => void;
  onClearInstall: () => void;
  onCopy: (text: string) => void;
  serverStateLabel: (serverId: string) => string;
  serverActivities: Record<string, ServerActivity>;
  formatDate: (value: string | number | Date) => string;
}) {
  const [expandedNodeIds, setExpandedNodeIds] = useState<Record<string, boolean>>({});
  const internalNode = nodes.find((node) => node.isInternal || node.type === "local");
  const externalNodes = nodes.filter((node) => !(node.isInternal || node.type === "local"));
  const addNodeCurrent = addNodeResult ? nodes.find((node) => node.id === addNodeResult.node.id) : undefined;
  const nodeVersionState = (node: ManagedNode) => {
    if (node.isInternal || !node.agentVersion) return "unknown";
    const comparison = compareVersions(node.agentVersion, panelVersion);
    if (comparison === 0) return "current";
    if (comparison === -1) return "older";
    if (comparison === 1) return "newer";
    return "mismatch";
  };
  const nodeBuildUpdateAvailable = (node: ManagedNode) => (
    !node.isInternal
    && Boolean(panelBuildId)
    && nodeVersionState(node) === "current"
    && node.buildId !== panelBuildId
  );
  const nodeUpdateAvailable = (node: ManagedNode) => nodeVersionState(node) === "older" || nodeBuildUpdateAvailable(node);
  const nodePanelUpdateRequired = (node: ManagedNode) => nodeVersionState(node) === "newer";
  const nodeVersionMismatch = (node: ManagedNode) => nodeVersionState(node) === "mismatch";
  const nodeCanPanelUpdate = (node: ManagedNode) => node.status === "online";
  const nodeUpdateTitle = (node: ManagedNode) => {
    if (!nodeUpdateAvailable(node)) return "Node agent is already current";
    if (!nodeCanPanelUpdate(node)) return "Bring the node online before updating";
    if (nodeBuildUpdateAvailable(node)) return `Update node image to build ${shortBuildId(panelBuildId)}`;
    return `Upgrade node agent to ${panelVersion}`;
  };

  const sortedNodes = useMemo(() => {
    return [
      ...(internalNode ? [internalNode] : []),
      ...externalNodes.sort((a, b) => a.name.localeCompare(b.name))
    ];
  }, [externalNodes, internalNode]);
  const selectedContextNode = selectedNode ? sortedNodes.find((candidate) => candidate.id === selectedNode.id) : undefined;
  const selectedDetailsNode = selectedContextNode ?? selectedNode;
  const selectedOperation = selectedDetailsNode ? nodeOperations[selectedDetailsNode.id] : undefined;
  const selectedManualRecovery = selectedDetailsNode ? nodeManualRecoveryById[selectedDetailsNode.id] : undefined;

  return (
    <section className={`pageStack nodesPage layoutBalanced ${selectedDetailsNode ? "nodeDetailsOpen" : ""}`.trim()}>
      {sortedNodes.length > 0 && (
        <section className="panel nodesToolbar">
          <div>
            <h2>Node inventory</h2>
            <p className="muted">Manage nodes and the servers they host.</p>
          </div>
          <div className="buttonRow">
            <Button onClick={onOpenAddNode} disabled={busy || !canManageNodes} title={!canManageNodes ? "Manage users permission is required" : busy ? "A node action is already in progress" : "Add a remote node"}>Add node</Button>
            <Button variant="secondary" iconOnly className="iconButton nodesRefreshButton" onClick={onRefresh} disabled={busy} aria-label="Refresh node status" title="Refresh node status">
              <AppIcon name="refresh" />
            </Button>
          </div>
        </section>
      )}

      <section className="nodesGrid">
        {sortedNodes.length === 0 && (
          <EmptyState
            className="nodesEmptyState"
            title="No nodes yet"
            message="No host is connected yet. Add a node so serverSENTINEL has a place to run Minecraft servers."
            action={<Button onClick={onOpenAddNode} disabled={busy || !canManageNodes} title={!canManageNodes ? "Manage users permission is required" : busy ? "A node action is already in progress" : "Add a remote node"}>Add node</Button>}
          />
        )}
        {sortedNodes.map((node) => {
          const operation = nodeOperations[node.id];
          const operationLabel = operation?.phase === "waiting"
            ? operation.kind === "update" ? "Updating" : "Restarting"
            : operation?.phase === "timed-out" ? "Attention" : "";
          const expanded = Boolean(expandedNodeIds[node.id]);
          const visibleServers = expanded ? node.servers : node.servers.slice(0, collapsedServerLimit);
          const hiddenServerCount = Math.max(0, node.servers.length - visibleServers.length);
          const canAddServer = isNodeRuntimeUsable(node);
          const addServerReason = nodeBlockReason(node) || "Node cannot host new servers right now.";
          return (
            <article key={node.id} className={`panel nodeCard ${node.status}`}>
              <header className="nodeCardHeader">
                <div className="nodeCardTopLine">
                  <div className="nodeCardTitle">
                    <h3>{node.name}</h3>
                  </div>
                  <div className="nodeStatusPills">
                    <StatusBadge
                      tone={operation?.phase === "waiting" ? "accent" : operation?.phase === "timed-out" ? "danger" : sharedStatusTone(node.status)}
                      className={`settingsStatus ${operation ? operation.phase : statusTone(node.status)}`}
                    >
                      {operation?.phase === "waiting" && <span className="nodeOperationBadgeSpinner" aria-hidden="true" />}
                      {operationLabel || node.status}
                    </StatusBadge>
                    {nodePanelUpdateRequired(node) && (
                      <StatusBadge tone="warning" className="settingsStatus warning" title={`Node agent ${node.agentVersion} is newer than panel ${panelVersion}. Update the panel before changing this node.`}>Panel update required</StatusBadge>
                    )}
                    {nodeVersionMismatch(node) && (
                      <StatusBadge tone="warning" className="settingsStatus warning" title={`Node agent ${node.agentVersion} does not match panel ${panelVersion}. Update both to matching release versions.`}>Version mismatch</StatusBadge>
                    )}
                  </div>
                </div>
                <div className="nodeCardActions">
                  {nodeUpdateAvailable(node) && (
                    <Button
                      variant="secondary"
                      compact
                      className="nodeUpgradeButton"
                      onClick={() => onUpdateNode(node)}
                      disabled={busyNodeId === node.id || Boolean(operation) || !canManageNodes || !nodeCanPanelUpdate(node)}
                      title={nodeUpdateTitle(node)}
                    >
                      {operation?.phase === "waiting" ? operation.kind === "update" ? "Updating…" : "Restarting…" : nodeBuildUpdateAvailable(node) ? "Update" : "Upgrade"}
                    </Button>
                  )}
                  <Button variant="secondary" compact onClick={() => onViewDetails(node)} disabled={busyNodeId === node.id} title={busyNodeId === node.id ? "This node is being updated" : "View node details"}>Details</Button>
                </div>
              </header>

              <section className="nodeServerSection">
                <div className="nodeServerSectionLabel">Servers on this node</div>
                <div className="nodeServerList">
                  {visibleServers.map((server) => {
                    const state = serverStateLabel(server.id);
                    const playerLabel = playerCountLabel(serverActivities[server.id]);
                    return (
                      <button key={server.id} type="button" className="nodeServerRow" onClick={() => onSelectServer(server.id)}>
                        <span className="nodeServerIcon"><ServerRowIcon /></span>
                        <span className="nodeServerName">{server.displayName}</span>
                        {playerLabel !== "-" && (
                          <span className="nodeServerPlayers" title={`${playerLabel} players online`}>
                            {playerLabel}
                            <span className="nodePlayerIcon"><PlayerIcon /></span>
                          </span>
                        )}
                        <span className={`nodeServerState ${state.toLowerCase()}`}>
                          <span className={`nodeStatusDot ${state === "RUNNING" ? "online" : state === "STOPPED" ? "offline" : "unknown"}`} aria-hidden="true" />
                          {state}
                        </span>
                      </button>
                    );
                  })}
                  <button type="button" className="nodeServerRow nodeAddServerRow" onClick={() => onAddServer(node.id)} disabled={!canAddServer} title={canAddServer ? `Add server to ${node.name}` : addServerReason}>
                    <span className="nodeServerIcon"><AppIcon name="plus" /></span>
                    <span className="nodeServerName">Add server</span>
                    <span className="nodeAddServerHint">{canAddServer ? "Create on this node" : "Node unavailable"}</span>
                  </button>
                  {hiddenServerCount > 0 && (
                    <button type="button" className="nodeServerMoreRow" onClick={() => setExpandedNodeIds((current) => ({ ...current, [node.id]: true }))}>
                      Show all {node.servers.length} servers
                    </button>
                  )}
                  {expanded && node.servers.length > collapsedServerLimit && (
                    <button type="button" className="nodeServerMoreRow" onClick={() => setExpandedNodeIds((current) => ({ ...current, [node.id]: false }))}>
                      Show less
                    </button>
                  )}
                </div>
              </section>
            </article>
          );
        })}
      </section>

      {selectedDetailsNode && (
        <div className="nodeDrawerBackdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) onCloseDetails();
        }}>
          <NodeDetailsDrawer
            node={selectedDetailsNode}
            contextNode={selectedContextNode}
            panelVersion={panelVersion}
            panelBuildId={panelBuildId}
            canManageNodes={canManageNodes}
            busy={busy}
            busyNodeId={busyNodeId}
            operation={selectedOperation}
            operationNow={nodeOperationNow}
            operationGraceMs={nodeUpdateGraceMs}
            manualRecovery={selectedManualRecovery}
            updateAvailable={nodeUpdateAvailable(selectedDetailsNode)}
            buildUpdateAvailable={nodeBuildUpdateAvailable(selectedDetailsNode)}
            panelUpdateRequired={nodePanelUpdateRequired(selectedDetailsNode)}
            versionMismatch={nodeVersionMismatch(selectedDetailsNode)}
            updateTitle={nodeUpdateTitle(selectedDetailsNode)}
            formatDate={formatDate}
            onClose={onCloseDetails}
            onShowInstall={onShowInstall}
            onRotateToken={onRotateToken}
            onUpdateNode={onUpdateNode}
            onRefresh={onRefresh}
            onRestartNode={onRestartNode}
            onRemoveNode={onRemoveNode}
            onCopy={onCopy}
          />
        </div>
      )}

      {installResult && (
        <div className="modalBackdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClearInstall();
        }}>
          <DialogSurface className="modalPanel nodeModalPanel" labelledBy="install-node-title" onClose={onClearInstall}>
            <header className="nodeModalHeader">
              <div>
                <h2 id="install-node-title">Node Install</h2>
                <p>Use this on the host that should run the node agent.</p>
              </div>
              <Button variant="secondary" iconOnly className="iconButton modalCloseButton" onClick={onClearInstall} aria-label="Close install instructions" title="Close install instructions"><AppIcon name="x" /></Button>
            </header>
            <div className="nodeModalBody">
              <InstallInstructions result={installResult} method={installMethod} onMethodChange={onInstallMethodChange} onCopy={onCopy} formatDate={formatDate} />
            </div>
          </DialogSurface>
        </div>
      )}

      {addNodeOpen && (
        <AddNodeModal
          busy={busy}
          defaultPanelUrl={defaultPanelUrl}
          created={addNodeResult}
          currentNode={addNodeCurrent}
          installMethod={installMethod}
          onInstallMethodChange={onInstallMethodChange}
          onClose={onCloseAddNode}
          onDone={onDoneAddNode}
          onCreate={onCreateNode}
          onCopy={onCopy}
          formatDate={formatDate}
        />
      )}
    </section>
  );
}
