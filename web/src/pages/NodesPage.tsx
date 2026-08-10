import { FormEvent, useMemo, useState } from "react";
import { InlineState } from "../components/InlineState";
import { AppIcon } from "../components/FileTypeIcon";
import { Button, EmptyState, MetricTile, PanelHeader, Spinner, StatusBadge, Toolbar } from "../components/UiPrimitives";
import { DialogSurface } from "../components/DialogSurface";
import type { ContextNode, CreateNodeResponse, NodeView, NodeInstallInstructions, NodeInstallResponse, NodeManualRecovery, NodeOperation, PlayerSnapshot } from "../types";
import { defaultNodeDataPath } from "../app/appConfig";
import { isNodeRuntimeUsable, nodeBlockReason } from "../utils/nodes";
import { NodeDetailsDrawer } from "./NodeDetailsDrawer";

export type AddNodeInput = {
  name: string;
  panelUrl: string;
  dataMount: string;
};

/* Keep dense fleets scannable without hiding the servers that matter most. The
   list uses two columns on wide screens, so six servers fill three compact rows. */
const collapsedServerLimit = 6;

function countLabel(count: number, singular: string) {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function onlinePlayers(snapshot?: PlayerSnapshot) {
  return !snapshot || snapshot.state === "unavailable" ? 0 : snapshot.online;
}

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

function playerCountLabel(snapshot?: PlayerSnapshot) {
  if (!snapshot || snapshot.state === "unavailable") return "-";
  return snapshot.maxPlayers ? `${snapshot.online}/${snapshot.maxPlayers}` : String(snapshot.online);
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

function nodePanelAddressHostProblem(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.startsWith("127.")) {
    return "localhost and loopback addresses point back to the node itself. Use this panel's LAN, VPN, or public address instead.";
  }
  if (host === "0.0.0.0" || host === "::" || host === "::1" || host === "0:0:0:0:0:0:0:0" || host === "0:0:0:0:0:0:0:1") {
    return "This address cannot be used by another computer. Use this panel's LAN, VPN, or public address instead.";
  }
  return "";
}

export function validateAddNodeInput(input: AddNodeInput) {
  const name = input.name.trim();
  const panelUrl = input.panelUrl.trim();
  const dataMount = input.dataMount.trim();
  if (name.length > 80 || /[\u0000-\u001f]/.test(name)) {
    return "Node name must be 80 characters or fewer.";
  }
  if (!panelUrl) {
    return "Enter the address this node will use to reach the panel.";
  }
  try {
    const url = new URL(panelUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "Panel address must start with http:// or https://.";
    }
    if (url.username || url.password) {
      return "Panel address cannot include a username or password.";
    }
    const hostProblem = nodePanelAddressHostProblem(url.hostname);
    if (hostProblem) return hostProblem;
  } catch {
    return "Enter a complete panel address, such as https://panel.example.com or http://192.168.1.50:8080.";
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
      {/* A group of toggles rather than a tablist: these buttons swap the snippet
          below in place and never own a tabpanel, so `role="tablist"` promised
          arrow-key semantics the markup could not deliver. */}
      <div className="installTabs" role="group" aria-label="Install method">
        <Button variant="ghost" compact className={method === "run" ? "active" : ""} aria-pressed={method === "run"} onClick={() => onMethodChange("run")}>
          docker run<span className="installTabBadge">Recommended</span>
        </Button>
        <Button variant="ghost" compact className={method === "compose" ? "active" : ""} aria-pressed={method === "compose"} onClick={() => onMethodChange("compose")}>Docker Compose</Button>
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

function isAddNodeSuccess(node?: NodeView) {
  return Boolean(node && node.status === "online" && isNodeRuntimeUsable(node));
}

function addNodeFlowState(node: NodeView | undefined, expiresAt: string): AddNodeFlowState {
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
          <li
            key={label}
            className={`addNodeStep ${isComplete ? "complete" : ""} ${isActive ? "active" : ""}`}
            aria-current={isActive ? "step" : undefined}
          >
            {index > 0 && <span className={`addNodeConnector ${index <= completedUntil ? "complete" : ""}`} aria-hidden="true" />}
            <span className="addNodeStepContent">
              <span className="addNodeStepCircle" aria-hidden="true">{isComplete ? "✓" : stepNumber}</span>
              <span className="addNodeStepLabel">{label}</span>
              {isComplete && <span className="srOnly">completed</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function AddNodeStatusCard({ nodeName, flowState }: { nodeName: string; flowState: AddNodeFlowState; node?: NodeView }) {
  if (flowState === "success") {
    return (
      <div className="addNodeStatusCard success" role="status" aria-live="polite">
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
      <div className="addNodeStatusCard error" role="alert">
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
      <div className="addNodeStatusCard error" role="alert">
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
      <Spinner size="lg" className="addNodeSpinner" />
      <div>
        <h3>Waiting for node connection</h3>
        <p>Run the install command on the host, then wait for the node to connect to this panel.</p>
      </div>
    </div>
  );
}

export function AddNodeModal({
  busy,
  browserPanelUrl,
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
  browserPanelUrl: string;
  created: CreateNodeResponse | null;
  currentNode?: NodeView;
  installMethod: "compose" | "run";
  onInstallMethodChange: (method: "compose" | "run") => void;
  onClose: () => void;
  onDone: () => void;
  onCreate: (input: AddNodeInput) => void;
  onCopy: (text: string) => void;
  formatDate: (value: string | number | Date) => string;
}) {
  const [name, setName] = useState("");
  const [panelUrl, setPanelUrl] = useState("");
  const [dataMount, setDataMount] = useState(defaultNodeDataPath);
  const [formError, setFormError] = useState("");
  const browserAddressProblem = validateAddNodeInput({ name: "", panelUrl: browserPanelUrl, dataMount: defaultNodeDataPath });
  const browserAddressUsable = !browserAddressProblem;

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
    <DialogSurface backdrop="nodeModalBackdrop" backdropDismiss={canClose} className="modalPanel nodeModalPanel" labelledBy="add-node-title" onClose={onClose}>
      <header className="nodeModalHeader">
        <div>
          <h2 id="add-node-title">Add node</h2>
          <p>Connect another computer to this ServerSentinel panel.</p>
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
              <span className="fieldHint">A friendly name for the computer that will run your Minecraft servers.</span>
            </label>
            <section className="nodeConnectionSetup" aria-labelledby="node-connection-title">
              <div className="nodeConnectionIntro">
                <div className="nodeConnectionDirection" aria-label="The node computer connects to this panel">
                  <span>Node computer</span>
                  <b aria-hidden="true">→</b>
                  <span>This panel</span>
                </div>
                <div>
                  <h3 id="node-connection-title">How the node connects</h3>
                  <p>The node opens a connection to this panel so you can manage servers on that computer. It needs an address for this panel that works from the node computer.</p>
                </div>
              </div>
              <label htmlFor="node-panel-address">
                Panel address for this node
                <input
                  id="node-panel-address"
                  name="panelUrl"
                  value={panelUrl}
                  onChange={(event) => setPanelUrl(event.target.value)}
                  placeholder="https://panel.example.com or http://192.168.1.50:8080"
                  aria-describedby="node-panel-address-hint"
                  required
                />
                <span className="fieldHint" id="node-panel-address-hint">This is the panel's address, not the new node's address. Include the port when your panel uses one.</span>
              </label>
              <div className={`panelAddressSuggestion ${browserAddressUsable ? "" : "warning"}`}>
                <div>
                  <span className="panelAddressSuggestionLabel">Address used by this browser</span>
                  <code>{browserPanelUrl}</code>
                  <p>{browserAddressUsable
                    ? "This may work if the node computer can open the same address."
                    : "This browser is using a local-only address. A Docker node would point that address back at itself, not at this panel."}</p>
                </div>
                {browserAddressUsable && (
                  <Button type="button" variant="secondary" compact onClick={() => setPanelUrl(browserPanelUrl)}>Use this address</Button>
                )}
              </div>
            </section>
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
              <Button type="submit" reserveLabel="Create install command">{busy ? "Creating..." : "Create install command"}</Button>
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
  );
}

export function NodesPage({
  nodes,
  panelVersion,
  panelBuildId,
  canManageNodes,
  busy,
  busyNodeId,
  browserPanelUrl,
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
  canImportServers,
  onImportServers,
  onClearInstall,
  onCopy,
  serverStateLabel,
  playerSnapshots,
  formatDate
}: {
  nodes: ContextNode[];
  panelVersion: string;
  panelBuildId?: string;
  canManageNodes: boolean;
  busy: boolean;
  busyNodeId: string;
  browserPanelUrl: string;
  selectedNode: NodeView | null;
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
  onViewDetails: (node: NodeView) => void;
  onShowInstall: (node: NodeView) => void;
  onRotateToken: (node: NodeView) => void;
  onUpdateNode: (node: NodeView) => void;
  onRestartNode: (node: NodeView) => void;
  onRemoveNode: (node: ContextNode, force?: boolean) => void;
  onCloseDetails: () => void;
  onSelectServer: (serverId: string) => void;
  onAddServer: (nodeId: string) => void;
  canImportServers: boolean;
  onImportServers: () => void;
  onClearInstall: () => void;
  onCopy: (text: string) => void;
  serverStateLabel: (serverId: string) => string;
  playerSnapshots: Record<string, PlayerSnapshot>;
  formatDate: (value: string | number | Date) => string;
}) {
  const [expandedNodeIds, setExpandedNodeIds] = useState<Record<string, boolean>>({});
  const addNodeCurrent = addNodeResult ? nodes.find((node) => node.id === addNodeResult.node.id) : undefined;
  const nodeVersionState = (node: NodeView) => {
    if (node.isInternal || !node.agentVersion) return "unknown";
    const comparison = compareVersions(node.agentVersion, panelVersion);
    if (comparison === 0) return "current";
    if (comparison === -1) return "older";
    if (comparison === 1) return "newer";
    return "mismatch";
  };
  const nodeBuildUpdateAvailable = (node: NodeView) => (
    !node.isInternal
    && Boolean(panelBuildId)
    && nodeVersionState(node) === "current"
    && node.buildId !== panelBuildId
  );
  const nodeUpdateAvailable = (node: NodeView) => nodeVersionState(node) === "older" || nodeBuildUpdateAvailable(node);
  const nodePanelUpdateRequired = (node: NodeView) => nodeVersionState(node) === "newer";
  const nodeVersionMismatch = (node: NodeView) => nodeVersionState(node) === "mismatch";
  const nodeCanPanelUpdate = (node: NodeView) => node.status === "online";
  const nodeUpdateTitle = (node: NodeView) => {
    if (!nodeUpdateAvailable(node)) return "Node agent is already current";
    if (!nodeCanPanelUpdate(node)) return "Bring the node online before updating";
    if (nodeBuildUpdateAvailable(node)) return `Update node image to build ${shortBuildId(panelBuildId)}`;
    return `Upgrade node agent to ${panelVersion}`;
  };

  // Derived inside the memo: splitting the list first meant the dependency was a fresh array on
  // every render, so this and everything keyed off it recomputed even when the fleet was unchanged.
  const sortedNodes = useMemo(() => {
    const internalNode = nodes.find((node) => node.isInternal || node.type === "local");
    const externalNodes = nodes.filter((node) => !(node.isInternal || node.type === "local"));
    return [
      ...(internalNode ? [internalNode] : []),
      ...externalNodes.sort((a, b) => a.name.localeCompare(b.name))
    ];
  }, [nodes]);
  const selectedContextNode = selectedNode ? sortedNodes.find((candidate) => candidate.id === selectedNode.id) : undefined;
  const selectedDetailsNode = selectedContextNode ?? selectedNode;
  const selectedOperation = selectedDetailsNode ? nodeOperations[selectedDetailsNode.id] : undefined;
  const selectedManualRecovery = selectedDetailsNode ? nodeManualRecoveryById[selectedDetailsNode.id] : undefined;

  const fleet = useMemo(() => {
    const servers = sortedNodes.flatMap((node) => node.servers);
    return {
      nodes: sortedNodes.length,
      nodesOnline: sortedNodes.filter((node) => node.status === "online").length,
      servers: servers.length,
      serversRunning: servers.filter((server) => serverStateLabel(server.id) === "RUNNING").length,
      players: servers.reduce((total, server) => total + onlinePlayers(playerSnapshots[server.id]), 0)
    };
  }, [playerSnapshots, serverStateLabel, sortedNodes]);

  const hasNodes = sortedNodes.length > 0;

  const addNodeButton = (
    <Button
      onClick={onOpenAddNode}
      disabled={busy || !canManageNodes}
      title={!canManageNodes ? "Manage nodes permission is required" : busy ? "A node action is already in progress" : "Add a remote node"}
    >
      Add node
    </Button>
  );

  return (
    <section className={`pageStack nodesPage layoutWide ${selectedDetailsNode ? "nodeDetailsOpen" : ""}`.trim()}>
      {hasNodes && (
        <>
          <section className="nodesFleetSummary" aria-label="Node fleet summary">
            <MetricTile
              variant="summary"
              tone={fleet.nodesOnline === fleet.nodes ? "success" : "danger"}
              label="Nodes"
              value={fleet.nodes}
              detail={`${fleet.nodesOnline} online`}
            />
            <MetricTile
              variant="summary"
              tone="info"
              label="Servers"
              value={fleet.servers}
              detail={`${fleet.serversRunning} running`}
            />
            <MetricTile
              variant="summary"
              tone="accent"
              label="Players"
              value={fleet.players}
              detail="Online now"
            />
          </section>

          <Toolbar
            className="nodesToolbar"
            primary={addNodeButton}
            meta={`${fleet.nodesOnline} of ${fleet.nodes} ${fleet.nodes === 1 ? "node" : "nodes"} online`}
            secondary={(
              <>
                {canImportServers && (
                  <Button variant="secondary" onClick={onImportServers} disabled={busy}>
                    <AppIcon name="fileUp" /> Import server
                  </Button>
                )}
                <Button
                  variant="secondary"
                  onClick={onRefresh}
                  disabled={busy}
                  title="Refresh node status"
                  reserveLabel={<><AppIcon name="refresh" />Refreshing…</>}
                >
                  <AppIcon name="refresh" />
                  {busy ? "Refreshing…" : "Refresh"}
                </Button>
              </>
            )}
          />
        </>
      )}

      <section className="nodesBoard">
        {hasNodes && (
          <PanelHeader
            className="nodesBoardHeader"
            headingLevel={3}
            title="Connected nodes"
            description="Hosts available to run and manage Minecraft servers."
          />
        )}
        {!hasNodes && (
          <EmptyState
            className="nodesEmptyState"
            title="No nodes yet"
            message="No host is connected yet. Add a node so serverSENTINEL has a place to run Minecraft servers."
            action={addNodeButton}
          />
        )}
        <div className="nodeList" role="list">
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
            const nodePlayers = node.servers.reduce((total, server) => total + onlinePlayers(playerSnapshots[server.id]), 0);
            const nodeMeta = [
              node.isInternal ? "Panel host" : "Remote host",
              node.isInternal ? "" : node.agentVersion ? `Agent ${node.agentVersion}` : "Agent version unknown"
            ].filter(Boolean);
            return (
              <article key={node.id} className="nodeListItem" role="listitem">
                <header className="nodeListRow">
                  <div className="nodeListIdentity">
                    <span className={`nodeListMark ${statusTone(node.status)}`} aria-hidden="true"><AppIcon name="server" /></span>
                    <div className="nodeListCopy">
                      <h3 className="nodeListName" title={node.name}>{node.name}</h3>
                      <p className="nodeListMeta">{nodeMeta.join(" · ")}</p>
                    </div>
                  </div>
                  <div className="nodeListStat nodeListStatServers">
                    <span>Servers</span>
                    <strong>{node.servers.length}</strong>
                  </div>
                  <div className="nodeListStat nodeListStatPlayers">
                    <span>Players</span>
                    <strong>{nodePlayers}</strong>
                  </div>
                  <div className="nodeListBadges">
                    <StatusBadge
                      tone={operation?.phase === "waiting" ? "accent" : operation?.phase === "timed-out" ? "danger" : sharedStatusTone(node.status)}
                      className={`nodeListStatus ${operation ? operation.phase : statusTone(node.status)}`}
                    >
                      {operation?.phase === "waiting" && <Spinner size="xs" />}
                      {operationLabel || node.status}
                    </StatusBadge>
                    {nodePanelUpdateRequired(node) && (
                      <StatusBadge tone="warning" className="nodeListStatus warning" title={`Node agent ${node.agentVersion} is newer than panel ${panelVersion}. Update the panel before changing this node.`}>Panel update required</StatusBadge>
                    )}
                    {nodeVersionMismatch(node) && (
                      <StatusBadge tone="warning" className="nodeListStatus warning" title={`Node agent ${node.agentVersion} does not match panel ${panelVersion}. Update both to matching release versions.`}>Version mismatch</StatusBadge>
                    )}
                  </div>
                  <div className="nodeListActions">
                    {nodeUpdateAvailable(node) && (
                      <Button
                        variant="secondary"
                        compact
                        className="nodeUpgradeButton"
                        onClick={() => onUpdateNode(node)}
                        disabled={busyNodeId === node.id || Boolean(operation) || !canManageNodes || !nodeCanPanelUpdate(node)}
                        title={nodeUpdateTitle(node)}
                        reserveLabel="Restarting…"
                      >
                        {operation?.phase === "waiting" ? operation.kind === "update" ? "Updating…" : "Restarting…" : nodeBuildUpdateAvailable(node) ? "Update" : "Upgrade"}
                      </Button>
                    )}
                    <Button variant="secondary" compact onClick={() => onViewDetails(node)} disabled={busyNodeId === node.id} title={busyNodeId === node.id ? "This node is being updated" : "View node details"}>Details</Button>
                  </div>
                </header>

                <section className="nodeServers" aria-label={`${node.name} servers`}>
                  <header className="nodeServersHeader">
                    <div>
                      <strong>Servers</strong>
                      <span>{countLabel(node.servers.length, "server")} on this node</span>
                    </div>
                    <Button variant="ghost" compact onClick={() => onAddServer(node.id)} disabled={!canAddServer} title={canAddServer ? `Add server to ${node.name}` : addServerReason}>
                      <AppIcon name="plus" /> Add server
                    </Button>
                  </header>
                  {visibleServers.length > 0 ? (
                    <div className="nodeServerList" id={`node-servers-${node.id}`}>
                      {visibleServers.map((server) => {
                        const state = serverStateLabel(server.id);
                        const snapshot = playerSnapshots[server.id];
                        const playerLabel = playerCountLabel(snapshot);
                        return (
                          <button key={server.id} type="button" className="nodeServerRow" onClick={() => onSelectServer(server.id)}>
                            <span className="nodeServerRowIcon" aria-hidden="true"><ServerRowIcon /></span>
                            <span className="nodeServerRowName" title={server.displayName}>{server.displayName}</span>
                            <span className={`nodeServerRowState ${state.toLowerCase()}`}>
                              <span className={`nodeStatusDot ${state === "RUNNING" ? "online" : state === "STOPPED" ? "offline" : "unknown"}`} aria-hidden="true" />
                              {state}
                            </span>
                            <span className={`nodeServerRowPlayers${snapshot?.state === "stale" ? " unknown" : ""}`} title={playerLabel === "-" ? "Player count unavailable" : `${playerLabel} players online${snapshot?.state === "stale" ? " (last verified snapshot)" : ""}`}>
                              {playerLabel !== "-" && <span className="nodePlayerIcon"><PlayerIcon /></span>}
                              {playerLabel === "-" ? "—" : playerLabel}
                            </span>
                            <span className="nodeServerRowArrow" aria-hidden="true"><AppIcon name="chevronRight" /></span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="nodeServersEmpty">No servers on this node yet.</p>
                  )}
                  {node.servers.length > collapsedServerLimit && (
                    <Button
                      variant="ghost"
                      compact
                      className="nodeListMore"
                      aria-expanded={expanded}
                      aria-controls={`node-servers-${node.id}`}
                      onClick={() => setExpandedNodeIds((current) => ({ ...current, [node.id]: !expanded }))}
                    >
                      {hiddenServerCount > 0 ? `Show all ${node.servers.length} servers` : "Show fewer servers"}
                      <AppIcon name={hiddenServerCount > 0 ? "chevronDown" : "chevronUp"} />
                    </Button>
                  )}
                </section>
              </article>
            );
          })}
        </div>
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
        <DialogSurface backdrop="nodeModalBackdrop" className="modalPanel nodeModalPanel" labelledBy="install-node-title" onClose={onClearInstall}>
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
      )}

      {addNodeOpen && (
        <AddNodeModal
          busy={busy}
          browserPanelUrl={browserPanelUrl}
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
