import { FormEvent, useEffect, useMemo, useState } from "react";
import { InlineState } from "../components/InlineState";
import { AppIcon } from "../components/FileTypeIcon";
import type { ContextNode, CreateNodeResponse, ManagedNode, NodeInstallInstructions, NodeInstallResponse, ServerActivity } from "../types";
import { isNodeRuntimeUsable, nodeBlockReason, nodeCompatibilityLabel, nodeDataPathLabel, nodeDockerLabel, nodeStatusLabel, nodeWarnings } from "../utils/nodes";

type AddNodeInput = {
  name: string;
  panelUrl: string;
  dataMount: string;
};

const defaultNodeDataPath = "/var/lib/serversentinel";
const collapsedServerLimit = 4;

function formatNodeDate(value?: string, formatter?: (value: string | number | Date) => string) {
  if (!value) return "Never";
  return formatter ? formatter(value) : new Date(value).toLocaleString();
}

function statusTone(value?: string) {
  if (value === "online" || value === "available" || value === "compatible" || value === "ready") return "ready";
  if (value === "offline" || value === "unavailable" || value === "incompatible" || value === "missing") return "limited";
  return "";
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
  onCopy
}: {
  result: CreateNodeResponse | NodeInstallResponse;
  method: "compose" | "run";
  onMethodChange: (method: "compose" | "run") => void;
  onCopy: (text: string) => void;
}) {
  const snippet = method === "compose" ? dockerComposeSnippet(result.install) : result.install.dockerRun;
  const expiresAt = "expiresAt" in result ? result.expiresAt : result.node.joinTokenExpiresAt;

  return (
    <section className="nodeInstallBox">
      <div className="nodeInstallHeader">
        <div>
          <h3>INSTALL {result.node.name}</h3>
          <p>{expiresAt ? `Join token expires ${formatNodeDate(expiresAt)}` : result.install.tokenRequired ? "Rotate the join token before installing this node." : "Token is not included in this snippet."}</p>
        </div>
      </div>
      <div className="installTabs" role="tablist" aria-label="Install method">
        <button type="button" className={method === "compose" ? "active" : ""} onClick={() => onMethodChange("compose")}>DOCKER COMPOSE</button>
        <button type="button" className={method === "run" ? "active" : ""} onClick={() => onMethodChange("run")}>DOCKER RUN</button>
      </div>
      <div className="installSnippetShell">
        <button type="button" className="installCopyButton" onClick={() => onCopy(snippet)} aria-label="Copy install command" title="Copy install command">
          <AppIcon name="copy" />
        </button>
        <pre className="installSnippet"><code>{snippet}</code></pre>
      </div>
    </section>
  );
}

const addNodeSteps = ["Create Node", "Run Install", "Connect", "Verify", "Ready"];

type AddNodeFlowState = "waiting" | "success" | "incompatible" | "expired" | "disconnected";

function isAddNodeSuccess(node?: ManagedNode) {
  return Boolean(node && node.status === "online" && node.compatibility === "compatible" && isNodeRuntimeUsable(node));
}

function addNodeFlowState(node: ManagedNode | undefined, expiresAt: string): AddNodeFlowState {
  if (isAddNodeSuccess(node)) return "success";
  if (node?.status === "online" && node.compatibility === "incompatible") return "incompatible";
  if (node?.status === "offline" && node.connectedAt) return "disconnected";
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) return "expired";
  return "waiting";
}

function addNodeActiveStep(flowState: AddNodeFlowState) {
  if (flowState === "success") return 5;
  if (flowState === "incompatible") return 4;
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

function AddNodeStatusCard({ nodeName, flowState, node }: { nodeName: string; flowState: AddNodeFlowState; node?: ManagedNode }) {
  if (flowState === "success") {
    return (
      <div className="addNodeStatusCard success">
        <span className="addNodeStatusIcon" aria-hidden="true">✓</span>
        <div>
          <h3>NODE ADDED SUCCESSFULLY</h3>
          <p>{nodeName} is now connected to this panel and ready to host servers.</p>
          <p>You can close this dialog and manage the node from the Nodes page.</p>
        </div>
      </div>
    );
  }

  if (flowState === "incompatible") {
    const versionText = [node?.agentVersion ? `agent ${node.agentVersion}` : "", node?.protocolVersion ? `protocol ${node.protocolVersion}` : ""].filter(Boolean).join(", ");
    return (
      <div className="addNodeStatusCard error">
        <span className="addNodeStatusIcon" aria-hidden="true">!</span>
        <div>
          <h3>NODE CONNECTED BUT INCOMPATIBLE</h3>
          <p>{versionText ? `${nodeName} connected with ${versionText}, but it is not compatible with this panel.` : `${nodeName} connected, but its agent or protocol version is not compatible with this panel.`}</p>
        </div>
      </div>
    );
  }

  if (flowState === "expired") {
    return (
      <div className="addNodeStatusCard error">
        <span className="addNodeStatusIcon" aria-hidden="true">!</span>
        <div>
          <h3>JOIN TOKEN EXPIRED</h3>
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
          <h3>NODE DISCONNECTED</h3>
          <p>{nodeName} connected once, but it is offline now. Check the node host and run the install command again if needed.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="addNodeStatusCard waiting" role="status" aria-live="polite">
      <span className="addNodeSpinner" aria-hidden="true" />
      <div>
        <h3>WAITING FOR NODE CONNECTION</h3>
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
  onCopy
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
  const showInstall = Boolean(created && flowState !== "success" && flowState !== "incompatible");

  return (
    <div className="modalBackdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="modalPanel nodeModalPanel" role="dialog" aria-modal="true" aria-labelledby="add-node-title">
        <header className="nodeModalHeader">
          <div>
            <h2 id="add-node-title">ADD NODE</h2>
            <p>Create a remote node and connect it to this panel.</p>
          </div>
          <button type="button" className="iconButton modalCloseButton" onClick={onClose} aria-label="Close add node modal">X</button>
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
                    <button type="button" className="roleInfoButton" aria-describedby="node-data-folder-tip">i</button>
                    <span id="node-data-folder-tip" role="tooltip" className="roleTooltip fieldTooltip">
                      Folder on the node host where Minecraft server files, worlds, mods, logs, and configs are stored. The installer mounts this folder into the node container.
                    </span>
                  </span>
                </span>
                <input name="dataMount" value={dataMount} onChange={(event) => setDataMount(event.target.value)} placeholder={defaultNodeDataPath} required />
              </label>
              <div className="nodeModalFooter inline">
                <button type="submit">{busy ? "Creating..." : "Create pending node"}</button>
                <button type="button" className="secondaryButton" onClick={onClose}>Cancel</button>
              </div>
            </fieldset>
          </form>
        ) : (
          <div className="nodeModalBody">
            <AddNodeStepper activeStep={activeStep} completeAll={isSuccess} />
            <AddNodeStatusCard nodeName={created.node.name} flowState={flowState} node={liveNode} />
            {showInstall && <InstallInstructions result={created} method={installMethod} onMethodChange={onInstallMethodChange} onCopy={onCopy} />}
            <div className={`nodeModalFooter inline addNodeModalActions ${isSuccess ? "success" : ""}`}>
              {!isSuccess && <button type="button" className="secondaryButton" onClick={onClose}>CANCEL</button>}
              <button type="button" onClick={isSuccess ? onDone : onClose}>{isSuccess ? "DONE" : "DONE"}</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export function NodesPage({
  nodes,
  panelVersion,
  canManageNodes,
  busy,
  busyNodeId,
  defaultPanelUrl,
  selectedNode,
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
  canManageNodes: boolean;
  busy: boolean;
  busyNodeId: string;
  defaultPanelUrl: string;
  selectedNode: ManagedNode | null;
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
  const nodeUpdateAvailable = (node: ManagedNode) => nodeVersionState(node) === "older";
  const nodePanelUpdateRequired = (node: ManagedNode) => nodeVersionState(node) === "newer";
  const nodeVersionMismatch = (node: ManagedNode) => nodeVersionState(node) === "mismatch";
  const nodeCanSelfUpdate = (node: ManagedNode) => node.capabilities?.includes("node.update");
  const nodeCanPanelUpdate = (node: ManagedNode) => node.status === "online" && nodeCanSelfUpdate(node);

  const sortedNodes = useMemo(() => {
    return [
      ...(internalNode ? [internalNode] : []),
      ...externalNodes.sort((a, b) => a.name.localeCompare(b.name))
    ];
  }, [externalNodes, internalNode]);

  return (
    <section className="pageStack nodesPage">
      {sortedNodes.length > 0 && (
        <section className="panel nodesToolbar">
          <div>
            <h2>NODES</h2>
            <p className="muted">Manage nodes and the servers they host.</p>
          </div>
          <div className="buttonRow">
            <button type="button" className="iconButton nodesRefreshButton" onClick={onRefresh} disabled={busy} aria-label="Refresh node status" title="Refresh node status">
              <AppIcon name="refresh" />
            </button>
          </div>
        </section>
      )}

      <section className="nodesGrid">
        {sortedNodes.length === 0 && (
          <div className="emptyState nodesEmptyState">
            <h2>No Nodes Yet</h2>
            <p>No host is connected yet. Add a node so ServerSentinel has a place to run Minecraft servers.</p>
            <button type="button" onClick={onOpenAddNode} disabled={busy || !canManageNodes}>Add Node</button>
          </div>
        )}
        {sortedNodes.map((node) => {
          const expanded = Boolean(expandedNodeIds[node.id]);
          const visibleServers = expanded ? node.servers : node.servers.slice(0, collapsedServerLimit);
          const hiddenServerCount = Math.max(0, node.servers.length - visibleServers.length);
          const canAddServer = isNodeRuntimeUsable(node);
          const addServerReason = nodeBlockReason(node) || "Node cannot host new servers right now.";
          return (
            <article key={node.id} className={`panel nodeCard ${node.status}`}>
              <header className="nodeCardHeader">
                <div>
                  <div className="nodeCardTitle">
                    <span className={`nodeStatusDot ${node.status}`} title={nodeStatusLabel(node.status)} aria-label={nodeStatusLabel(node.status)} />
                    <h3>{node.name}</h3>
                  </div>
                </div>
                <span className={`settingsStatus ${statusTone(node.status)}`}>{node.status}</span>
                {nodePanelUpdateRequired(node) && (
                  <span className="settingsStatus warning" title={`Node agent ${node.agentVersion} is newer than panel ${panelVersion}. Update the panel before changing this node.`}>Panel update required</span>
                )}
                {nodeVersionMismatch(node) && (
                  <span className="settingsStatus warning" title={`Node agent ${node.agentVersion} does not match panel ${panelVersion}. Update both to matching release versions.`}>Version mismatch</span>
                )}
                {nodeUpdateAvailable(node) && (
                  <button
                    type="button"
                    className="secondaryButton compactButton"
                    onClick={() => nodeCanPanelUpdate(node) ? onUpdateNode(node) : onShowInstall(node)}
                    disabled={busyNodeId === node.id || !canManageNodes}
                    title={nodeCanPanelUpdate(node) ? `Update node agent to ${panelVersion}` : "This node needs a manual update before panel-triggered updates are available"}
                  >
                    {nodeCanPanelUpdate(node) ? "Update" : "Instructions"}
                  </button>
                )}
                <button type="button" className="secondaryButton compactButton" onClick={() => onViewDetails(node)} disabled={busyNodeId === node.id}>Details</button>
              </header>

              <section className="nodeServerSection">
                <div className="nodeServerSectionLabel">SERVERS ON THIS NODE</div>
                <div className="nodeServerList">
                  {node.servers.length === 0 && (
                    <div className="nodeServerEmpty">
                      <strong>No servers here yet</strong>
                      <span>{canAddServer ? "Add a server to place it on this node." : "Bring the node online before adding servers here."}</span>
                    </div>
                  )}
                  {visibleServers.map((server) => {
                    const state = serverStateLabel(server.id);
                    const playerLabel = playerCountLabel(serverActivities[server.id]);
                    return (
                      <button key={server.id} type="button" className="nodeServerRow" onClick={() => onSelectServer(server.id)}>
                        <span className="nodeServerIcon"><ServerRowIcon /></span>
                        <span className="nodeServerName">{server.displayName}</span>
                        <span className={`nodeServerPlayers ${playerLabel === "-" ? "unknown" : ""}`} title={playerLabel === "-" ? "Player count unavailable" : `${playerLabel} players online`}>
                          {playerLabel}
                          <span className="nodePlayerIcon"><PlayerIcon /></span>
                        </span>
                        <span className={`nodeServerState ${state.toLowerCase()}`}>
                          <span className={`nodeStatusDot ${state === "RUNNING" ? "online" : state === "STOPPED" ? "offline" : "unknown"}`} aria-hidden="true" />
                          {state}
                        </span>
                      </button>
                    );
                  })}
                  {hiddenServerCount > 0 && (
                    <button type="button" className="nodeServerMoreRow" onClick={() => setExpandedNodeIds((current) => ({ ...current, [node.id]: true }))}>
                      + {hiddenServerCount} MORE SERVERS
                    </button>
                  )}
                  {expanded && node.servers.length > collapsedServerLimit && (
                    <button type="button" className="nodeServerMoreRow" onClick={() => setExpandedNodeIds((current) => ({ ...current, [node.id]: false }))}>
                      SHOW LESS
                    </button>
                  )}
                </div>
              </section>

              <button type="button" className="secondaryButton nodeAddServerButton" onClick={() => onAddServer(node.id)} disabled={!canAddServer} title={canAddServer ? `Add server to ${node.name}` : addServerReason}>
                + Add Server
              </button>
            </article>
          );
        })}
        {sortedNodes.length > 0 && (
          <button
            type="button"
            className="panel nodeCard addNodeCardButton"
            onClick={onOpenAddNode}
            disabled={busy || !canManageNodes}
            aria-label="Add a remote node"
            title={canManageNodes ? "Add a remote node" : "Manage users permission is required"}
          >
            <div className="addNodeCardInner">
              <svg className="addNodeIcon" viewBox="0 0 24 24">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="square" />
              </svg>
              <span>Add Node</span>
            </div>
          </button>
        )}
      </section>

      {selectedNode && (
        <div className="modalBackdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) onCloseDetails();
        }}>
          <section className="modalPanel nodeModalPanel" role="dialog" aria-modal="true" aria-labelledby="node-details-title">
            <header className="nodeModalHeader">
              <div>
                <h2 id="node-details-title">{selectedNode.name}</h2>
                <p>Technical node details and maintenance actions.</p>
              </div>
              <button type="button" className="iconButton modalCloseButton" onClick={onCloseDetails} aria-label="Close node details">X</button>
            </header>
            <div className="nodeModalBody">
              <dl className="nodeFacts detailed">
                <div><dt>ID</dt><dd>{selectedNode.id}</dd></div>
                <div><dt>Type</dt><dd>{selectedNode.type}</dd></div>
                <div><dt>Status</dt><dd className={statusTone(selectedNode.status)}>{selectedNode.status}</dd></div>
                <div><dt>Agent</dt><dd>{selectedNode.agentVersion || "Unknown"}</dd></div>
                <div><dt>Panel</dt><dd>{panelVersion}</dd></div>
                <div><dt>Protocol</dt><dd>{selectedNode.protocolVersion || "Unknown"}</dd></div>
                <div><dt>Compatibility</dt><dd className={statusTone(selectedNode.compatibility)}>{nodeCompatibilityLabel(selectedNode)}</dd></div>
                <div><dt>Docker</dt><dd className={statusTone(selectedNode.dockerStatus)}>{nodeDockerLabel(selectedNode)}</dd></div>
                <div><dt>Data path</dt><dd className={statusTone(selectedNode.dataPathStatus)}>{nodeDataPathLabel(selectedNode)}</dd></div>
                <div><dt>Created</dt><dd>{formatNodeDate(selectedNode.createdAt, formatDate)}</dd></div>
                <div><dt>Updated</dt><dd>{formatNodeDate(selectedNode.updatedAt, formatDate)}</dd></div>
                <div><dt>Last seen</dt><dd>{formatNodeDate(selectedNode.lastSeenAt ?? selectedNode.connectedAt, formatDate)}</dd></div>
                <div><dt>Capabilities</dt><dd>{selectedNode.capabilities?.length ? selectedNode.capabilities.join(", ") : "None advertised"}</dd></div>
              </dl>
              {nodeWarnings(selectedNode).length > 0 && (
                <div className="nodeWarnings">
                  {nodeWarnings(selectedNode).map((warning) => <span key={warning}>{warning}</span>)}
                </div>
              )}
              {nodePanelUpdateRequired(selectedNode) && (
                <div className="nodeWarnings">
                  <span>Node agent {selectedNode.agentVersion} is newer than this panel ({panelVersion}). Update the panel before updating or managing this node image.</span>
                </div>
              )}
              {nodeVersionMismatch(selectedNode) && (
                <div className="nodeWarnings">
                  <span>Node agent {selectedNode.agentVersion} cannot be safely compared with this panel ({panelVersion}). Update the panel and node manually to matching release versions.</span>
                </div>
              )}
              <div className="nodeActions">
                <button type="button" className="secondaryButton compactButton" onClick={() => onShowInstall(selectedNode)} disabled={busyNodeId === selectedNode.id}>Install instructions</button>
                {nodeUpdateAvailable(selectedNode) && (
                  <button
                    type="button"
                    className="secondaryButton compactButton"
                    onClick={() => nodeCanPanelUpdate(selectedNode) ? onUpdateNode(selectedNode) : onShowInstall(selectedNode)}
                    disabled={busyNodeId === selectedNode.id || !canManageNodes}
                    title={nodeCanPanelUpdate(selectedNode) ? `Update node agent to ${panelVersion}` : "This node needs a manual update before panel-triggered updates are available"}
                  >
                    {nodeCanPanelUpdate(selectedNode) ? "Update image" : "Update instructions"}
                  </button>
                )}
                <button type="button" className="secondaryButton compactButton" onClick={() => onRotateToken(selectedNode)} disabled={busyNodeId === selectedNode.id || selectedNode.isInternal || !canManageNodes} title={selectedNode.isInternal ? "Internal node tokens cannot be rotated" : ""}>Rotate token</button>
                <button type="button" className="secondaryButton compactButton" onClick={onRefresh} disabled={busy}>Refresh node</button>
                <button
                  type="button"
                  className="dangerButton compactButton"
                  onClick={() => {
                    const node = sortedNodes.find((candidate) => candidate.id === selectedNode.id);
                    if (node) onRemoveNode(node);
                  }}
                  disabled={busyNodeId === selectedNode.id || selectedNode.isInternal || Boolean(sortedNodes.find((candidate) => candidate.id === selectedNode.id)?.servers.length) || !canManageNodes}
                  title={selectedNode.isInternal ? "Internal node cannot be deleted" : sortedNodes.find((candidate) => candidate.id === selectedNode.id)?.servers.length ? "Move or delete assigned servers first" : ""}
                >
                  Remove node
                </button>
                {Boolean(sortedNodes.find((candidate) => candidate.id === selectedNode.id)?.servers.length) && !selectedNode.isInternal && canManageNodes && (
                  <button
                    type="button"
                    className="dangerButton compactButton"
                    onClick={() => {
                      const node = sortedNodes.find((candidate) => candidate.id === selectedNode.id);
                      if (node) onRemoveNode(node, true);
                    }}
                    disabled={busyNodeId === selectedNode.id}
                    title="Remove this stale node and its assigned server records from the panel without contacting the node host"
                  >
                    Force remove node
                  </button>
                )}
              </div>
            </div>
          </section>
        </div>
      )}

      {installResult && (
        <div className="modalBackdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClearInstall();
        }}>
          <section className="modalPanel nodeModalPanel" role="dialog" aria-modal="true" aria-labelledby="install-node-title">
            <header className="nodeModalHeader">
              <div>
                <h2 id="install-node-title">NODE INSTALL</h2>
                <p>Use this on the host that should run the node agent.</p>
              </div>
              <button type="button" className="iconButton modalCloseButton" onClick={onClearInstall} aria-label="Close install instructions">X</button>
            </header>
            <div className="nodeModalBody">
              <InstallInstructions result={installResult} method={installMethod} onMethodChange={onInstallMethodChange} onCopy={onCopy} />
            </div>
          </section>
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
        />
      )}
    </section>
  );
}
