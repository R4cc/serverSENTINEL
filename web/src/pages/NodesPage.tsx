import { FormEvent, useEffect, useMemo, useState } from "react";
import type { ContextNode, CreateNodeResponse, ManagedNode, NodeInstallInstructions, NodeInstallResponse } from "../types";
import { isNodeRuntimeUsable, nodeBlockReason, nodeCompatibilityLabel, nodeDataPathLabel, nodeDockerLabel, nodeStatusLabel, nodeWarnings } from "../utils/nodes";

type AddNodeInput = {
  name: string;
  panelUrl: string;
  dataMount: string;
};

function formatNodeDate(value?: string, formatter?: (value: string | number | Date) => string) {
  if (!value) return "Never";
  return formatter ? formatter(value) : new Date(value).toLocaleString();
}

function statusTone(value?: string) {
  if (value === "online" || value === "available" || value === "compatible" || value === "ready") return "ready";
  if (value === "offline" || value === "unavailable" || value === "incompatible" || value === "missing") return "limited";
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
          <h3>Install {result.node.name}</h3>
          <p>{expiresAt ? `Join token expires ${formatNodeDate(expiresAt)}` : result.install.tokenRequired ? "Rotate the join token before installing this node." : "Token is not included in this snippet."}</p>
        </div>
        <button type="button" className="secondaryButton" onClick={() => onCopy(snippet)}>Copy</button>
      </div>
      <div className="installTabs" role="tablist" aria-label="Install method">
        <button type="button" className={method === "compose" ? "active" : ""} onClick={() => onMethodChange("compose")}>Docker Compose</button>
        <button type="button" className={method === "run" ? "active" : ""} onClick={() => onMethodChange("run")}>docker run</button>
      </div>
      <pre className="installSnippet"><code>{snippet}</code></pre>
    </section>
  );
}

function NodeSetupState({ node }: { node?: ManagedNode }) {
  const steps = [
    { label: "Waiting for node", done: Boolean(node && node.status !== "unknown"), active: !node || node.status === "unknown" },
    { label: "Token accepted", done: Boolean(node?.connectedAt || (node && !node.hasPendingJoinToken && node.status !== "unknown")) },
    { label: "Docker available", done: node?.dockerStatus === "available" },
    { label: "Data path writable", done: node?.dataPathStatus === "ready" },
    { label: "Node ready", done: Boolean(node && isNodeRuntimeUsable(node) && node.dataPathStatus === "ready") }
  ];

  return (
    <div className="nodeSetupState">
      {steps.map((step) => (
        <div key={step.label} className={`nodeSetupStep ${step.done ? "done" : step.active ? "active" : ""}`}>
          <span className={`nodeStatusDot ${step.done ? "online" : step.active ? "unknown" : "offline"}`} aria-hidden="true" />
          <span>{step.label}</span>
        </div>
      ))}
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
  onCreate: (input: AddNodeInput) => void;
  onCopy: (text: string) => void;
}) {
  const [name, setName] = useState("");
  const [panelUrl, setPanelUrl] = useState(defaultPanelUrl);
  const [dataMount, setDataMount] = useState("/srv/serversentinel");

  useEffect(() => {
    if (!panelUrl) setPanelUrl(defaultPanelUrl);
  }, [defaultPanelUrl, panelUrl]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onCreate({ name, panelUrl, dataMount });
  }

  return (
    <div className="modalBackdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="modalPanel nodeModalPanel" role="dialog" aria-modal="true" aria-labelledby="add-node-title">
        <header className="nodeModalHeader">
          <div>
            <h2 id="add-node-title">ADD NODE</h2>
            <p>Create a pending node, then run the generated install command on the host.</p>
          </div>
          <button type="button" className="iconButton contextCloseButton" onClick={onClose} aria-label="Close add node modal">X</button>
        </header>

        {!created ? (
          <form className="appForm nodeModalBody" onSubmit={submit}>
            <fieldset disabled={busy}>
              <label>
                Node name
                <input name="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="MC-NODE-01" maxLength={80} required />
              </label>
              <label>
                Panel URL reachable from the node
                <input name="panelUrl" value={panelUrl} onChange={(event) => setPanelUrl(event.target.value)} placeholder="https://panel.example.com" required />
              </label>
              <label>
                Host data path
                <input name="dataMount" value={dataMount} onChange={(event) => setDataMount(event.target.value)} placeholder="/srv/serversentinel" required />
              </label>
              <div className="nodeModalFooter inline">
                <button type="submit">{busy ? "Creating..." : "Create pending node"}</button>
                <button type="button" className="secondaryButton" onClick={onClose}>Cancel</button>
              </div>
            </fieldset>
          </form>
        ) : (
          <div className="nodeModalBody">
            <NodeSetupState node={currentNode ?? created.node} />
            <InstallInstructions result={created} method={installMethod} onMethodChange={onInstallMethodChange} onCopy={onCopy} />
            <div className="nodeModalFooter inline">
              <button type="button" className="secondaryButton" onClick={onClose}>Done</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export function NodesPage({
  nodes,
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
  onCreateNode,
  onRefresh,
  onViewDetails,
  onShowInstall,
  onRotateToken,
  onRemoveNode,
  onClearInstall,
  onCopy,
  formatDate
}: {
  nodes: ContextNode[];
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
  onCreateNode: (input: AddNodeInput) => void;
  onRefresh: () => void;
  onViewDetails: (node: ManagedNode) => void;
  onShowInstall: (node: ManagedNode) => void;
  onRotateToken: (node: ManagedNode) => void;
  onRemoveNode: (node: ContextNode) => void;
  onClearInstall: () => void;
  onCopy: (text: string) => void;
  formatDate: (value: string | number | Date) => string;
}) {
  const internalNode = nodes.find((node) => node.isInternal || node.type === "local");
  const externalNodes = nodes.filter((node) => !(node.isInternal || node.type === "local"));
  const addNodeCurrent = addNodeResult ? nodes.find((node) => node.id === addNodeResult.node.id) : undefined;

  const sortedNodes = useMemo(() => {
    return [
      ...(internalNode ? [internalNode] : []),
      ...externalNodes.sort((a, b) => a.name.localeCompare(b.name))
    ];
  }, [externalNodes, internalNode]);

  return (
    <section className="pageStack nodesPage">
      <section className="panel nodesToolbar">
        <div>
          <h2>NODES</h2>
          <p className="muted">{internalNode ? "Manage the internal node and remote nodes that can host servers." : "Manage remote nodes that can host servers."}</p>
        </div>
        <div className="buttonRow">
          <button type="button" className="secondaryButton" onClick={onRefresh} disabled={busy}>Refresh status</button>
          <button type="button" onClick={onOpenAddNode} disabled={busy || !canManageNodes} title={!canManageNodes ? "Manage users permission is required" : "Add a remote node"}>Add Node</button>
        </div>
      </section>

      <section className="nodesGrid">
        {sortedNodes.length === 0 && (
          <div className="emptyState nodesEmptyState">
            <h2>No Nodes Yet</h2>
            <p>Add a node to connect a host that can run Minecraft server containers.</p>
            <button type="button" onClick={onOpenAddNode} disabled={busy || !canManageNodes}>Add Node</button>
          </div>
        )}
        {sortedNodes.map((node) => {
          const warnings = nodeWarnings(node);
          const removeBlocked = node.isInternal || node.servers.length > 0;
          return (
            <article key={node.id} className={`panel nodeCard ${node.status}`}>
              <header className="nodeCardHeader">
                <div>
                  <div className="nodeCardTitle">
                    <span className={`nodeStatusDot ${node.status}`} title={nodeStatusLabel(node.status)} aria-label={nodeStatusLabel(node.status)} />
                    <h3>{node.name}</h3>
                  </div>
                  <p>{node.isInternal ? "Internal Node" : "External Node"}</p>
                </div>
                <span className={`settingsStatus ${statusTone(node.status)}`}>{node.status}</span>
              </header>

              <dl className="nodeFacts">
                <div><dt>Servers</dt><dd>{node.servers.length}</dd></div>
                <div><dt>Agent</dt><dd>{node.agentVersion || "Unknown"}</dd></div>
                <div><dt>Protocol</dt><dd>{node.protocolVersion || "Unknown"}</dd></div>
                <div><dt>Compatibility</dt><dd className={statusTone(node.compatibility)}>{nodeCompatibilityLabel(node)}</dd></div>
                <div><dt>Docker</dt><dd className={statusTone(node.dockerStatus)}>{nodeDockerLabel(node)}</dd></div>
                <div><dt>Data path</dt><dd className={statusTone(node.dataPathStatus)}>{nodeDataPathLabel(node)}</dd></div>
                <div><dt>Last seen</dt><dd>{formatNodeDate(node.lastSeenAt ?? node.connectedAt, formatDate)}</dd></div>
              </dl>

              {warnings.length > 0 && (
                <div className="nodeWarnings">
                  {warnings.slice(0, 3).map((warning) => <span key={warning}>{warning}</span>)}
                </div>
              )}

              <div className="nodeActions">
                <button type="button" className="secondaryButton compactButton" onClick={() => onViewDetails(node)} disabled={busyNodeId === node.id}>Details</button>
                <button type="button" className="secondaryButton compactButton" onClick={() => onShowInstall(node)} disabled={busyNodeId === node.id}>Install</button>
                <button type="button" className="secondaryButton compactButton" onClick={() => onRotateToken(node)} disabled={busyNodeId === node.id || node.isInternal || !canManageNodes} title={node.isInternal ? "Internal node tokens cannot be rotated" : ""}>Rotate token</button>
                <button type="button" className="secondaryButton compactButton" onClick={onRefresh} disabled={busy}>Refresh</button>
                <button type="button" className="dangerButton compactButton" onClick={() => onRemoveNode(node)} disabled={busyNodeId === node.id || removeBlocked || !canManageNodes} title={node.isInternal ? "Internal node cannot be deleted" : node.servers.length > 0 ? "Move or delete assigned servers first" : ""}>Remove</button>
              </div>

              {!isNodeRuntimeUsable(node) && (
                <p className="nodeBlockedNote">{nodeBlockReason(node) || "Runtime actions may be limited."}</p>
              )}
            </article>
          );
        })}
      </section>

      {selectedNode && (
        <section className="panel nodeDetailsPanel">
          <div className="panelHeader">
            <div>
              <h2>{selectedNode.name}</h2>
              <p className="muted">Node details from the backend.</p>
            </div>
          </div>
          <dl className="nodeFacts detailed">
            <div><dt>ID</dt><dd>{selectedNode.id}</dd></div>
            <div><dt>Type</dt><dd>{selectedNode.type}</dd></div>
            <div><dt>Created</dt><dd>{formatNodeDate(selectedNode.createdAt, formatDate)}</dd></div>
            <div><dt>Updated</dt><dd>{formatNodeDate(selectedNode.updatedAt, formatDate)}</dd></div>
            <div><dt>Connected</dt><dd>{formatNodeDate(selectedNode.connectedAt, formatDate)}</dd></div>
            <div><dt>Capabilities</dt><dd>{selectedNode.capabilities?.length ? selectedNode.capabilities.join(", ") : "None advertised"}</dd></div>
          </dl>
        </section>
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
              <button type="button" className="iconButton contextCloseButton" onClick={onClearInstall} aria-label="Close install instructions">X</button>
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
          onCreate={onCreateNode}
          onCopy={onCopy}
        />
      )}
    </section>
  );
}
