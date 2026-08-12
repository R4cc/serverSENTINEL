import { useEffect, useMemo, useState } from "react";
import { isNodeRuntimeUsable, nodeBlockReason } from "../utils/nodes";
import type { ContextNode, ManagedServer } from "../types";
import { AppIcon } from "./FileTypeIcon";
import { DialogSurface } from "./DialogSurface";
import { Banner, Button, StatusBadge, Surface } from "./UiPrimitives";

const onboardingSteps = ["Host", "Server", "Start", "Finish"] as const;

export function onboardingRecommendedStep(input: {
  serverCount: number;
  serverRunning: boolean;
}): 1 | 2 | 3 | 4 {
  if (input.serverCount === 0) return 1;
  return input.serverRunning ? 4 : 3;
}

function stepDescription(step: number) {
  if (step === 1) return "Choose the computer that will run your first Minecraft server.";
  if (step === 2) return "Create a new server or restore a serverSENTINEL export.";
  if (step === 3) return "Start the server and verify that its runtime is healthy.";
  return "Review optional integrations, then hand control over to the full panel.";
}

function NodeChoice({
  node,
  selected,
  onSelect
}: {
  node: ContextNode;
  selected: boolean;
  onSelect(): void;
}) {
  const usable = isNodeRuntimeUsable(node);
  return (
    <Surface as="article" material="solid" className={`onboardingChoiceCard ${selected ? "selected" : ""}`.trim()}>
      <div className="onboardingChoiceHeader">
        <span className="onboardingChoiceIcon" aria-hidden="true"><AppIcon name="server" /></span>
        <div>
          <strong>{node.isInternal ? "This machine" : node.name}</strong>
          <span>{node.isInternal ? "Use the Docker engine connected to this panel." : "Use this connected remote node."}</span>
        </div>
        <StatusBadge tone={usable ? "success" : "warning"}>{usable ? "Ready" : "Unavailable"}</StatusBadge>
      </div>
      {!usable && <p>{nodeBlockReason(node) || "This host is not ready to create servers."}</p>}
      <Button variant={selected ? "primary" : "secondary"} onClick={onSelect} disabled={!usable}>
        {selected ? <AppIcon name="check" /> : null}
        {selected ? "Selected" : "Use this host"}
      </Button>
    </Surface>
  );
}

export function OnboardingResumeBanner({
  step,
  onResume
}: {
  step: 1 | 2 | 3 | 4;
  onResume(): void;
}) {
  return (
    <Banner
      className="onboardingResumeBanner"
      tone="info"
      title={`Initial setup · ${onboardingSteps[step - 1]}`}
      message={stepDescription(step)}
      action={<Button compact onClick={onResume}>Continue setup</Button>}
    />
  );
}

export function OnboardingFlow({
  open,
  nodes,
  servers,
  activeServerId,
  serverRunning,
  runtimeMode,
  panelTimeZone,
  modrinthConfigured,
  playerHeadsEnabled,
  playerHeadsBusy,
  canCreateServers,
  canManageNodes,
  canControlServers,
  canManageIntegrations,
  startingServer,
  onClose,
  onAddNode,
  onCreateServer,
  onImportServer,
  onOpenServer,
  onStartServer,
  onOpenSettings,
  onFinish
}: {
  open: boolean;
  nodes: ContextNode[];
  servers: ManagedServer[];
  activeServerId?: string;
  serverRunning: boolean;
  runtimeMode?: "all-in-one" | "panel" | "node";
  panelTimeZone: string;
  modrinthConfigured: boolean;
  playerHeadsEnabled: boolean;
  playerHeadsBusy: boolean;
  canCreateServers: boolean;
  canManageNodes: boolean;
  canControlServers: boolean;
  canManageIntegrations: boolean;
  startingServer: boolean;
  onClose(): void;
  onAddNode(): void;
  onCreateServer(nodeId: string): void;
  onImportServer(nodeId: string): void;
  onOpenServer(serverId: string): void;
  onStartServer(): Promise<void> | void;
  onOpenSettings(): void;
  onFinish(playerHeadsEnabled: boolean): Promise<void> | void;
}) {
  const readyNodes = useMemo(() => nodes.filter(isNodeRuntimeUsable), [nodes]);
  const localNode = readyNodes.find((node) => node.isInternal || node.type === "local");
  const firstRemoteNode = readyNodes.find((node) => !node.isInternal && node.type !== "local");
  const [step, setStep] = useState<1 | 2 | 3 | 4>(() => onboardingRecommendedStep({ serverCount: servers.length, serverRunning }));
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [playerHeadsChoice, setPlayerHeadsChoice] = useState(playerHeadsEnabled);
  const [finishing, setFinishing] = useState(false);
  const selectedNode = readyNodes.find((node) => node.id === selectedNodeId);
  const firstServer = servers.find((server) => server.id === activeServerId) ?? servers[0];

  useEffect(() => {
    if (!open) return;
    setStep(onboardingRecommendedStep({ serverCount: servers.length, serverRunning }));
    setPlayerHeadsChoice(playerHeadsEnabled);
    if (selectedNodeId && readyNodes.some((node) => node.id === selectedNodeId)) return;
    setSelectedNodeId(localNode?.id ?? firstRemoteNode?.id ?? "");
  }, [firstRemoteNode?.id, localNode?.id, open, playerHeadsEnabled, readyNodes, selectedNodeId, serverRunning, servers.length]);

  if (!open) return null;

  const chooseNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setStep(2);
  };

  async function finish() {
    if (finishing) return;
    setFinishing(true);
    try {
      await onFinish(playerHeadsChoice);
    } finally {
      setFinishing(false);
    }
  }

  return (
    <DialogSurface
      backdrop="onboardingBackdrop"
      className="modalPanel onboardingPanel"
      labelledBy="onboarding-title"
      describedBy="onboarding-description"
      onClose={onClose}
      backdropDismiss={false}
      allowDocumentScrollOnPhone
    >
      <header className="onboardingHeader">
        <div className="onboardingBrandMark" aria-hidden="true"><AppIcon name="shield" /></div>
        <div className="onboardingHeaderCopy">
          <span className="onboardingEyebrow">Initial setup</span>
          <h2 id="onboarding-title">Bring your first server online</h2>
          <p id="onboarding-description">A short, resumable path through hosting, creation, and the first successful start.</p>
        </div>
        <Button variant="ghost" iconOnly onClick={onClose} aria-label="Continue setup later" title="Continue setup later"><AppIcon name="x" /></Button>
      </header>

      <ol className="onboardingStepper" aria-label="Initial setup progress">
        {onboardingSteps.map((label, index) => {
          const number = (index + 1) as 1 | 2 | 3 | 4;
          const completed = number < step;
          return (
            <li key={label} className={`${number === step ? "active" : ""} ${completed ? "completed" : ""}`.trim()} aria-current={number === step ? "step" : undefined}>
              <span>{completed ? <AppIcon name="check" /> : number}</span>
              <div><strong>{label}</strong><small>{number === step ? stepDescription(number) : ""}</small></div>
            </li>
          );
        })}
      </ol>

      <div className="onboardingBody">
        {step === 1 && (
          <section className="onboardingStage" aria-labelledby="onboarding-host-title">
            <div className="onboardingStageHeading">
              <span>Step 1</span>
              <h3 id="onboarding-host-title">Where should the first server run?</h3>
              <p>This choice is only the initial placement. Additional nodes remain available from the Nodes page.</p>
            </div>

            <div className="onboardingChoiceGrid">
              {localNode ? <NodeChoice node={localNode} selected={selectedNodeId === localNode.id} onSelect={() => chooseNode(localNode.id)} /> : (
                <Surface as="article" material="solid" className="onboardingChoiceCard unavailable">
                  <div className="onboardingChoiceHeader">
                    <span className="onboardingChoiceIcon" aria-hidden="true"><AppIcon name="server" /></span>
                    <div><strong>This machine</strong><span>Run Minecraft beside the panel.</span></div>
                    <StatusBadge tone="warning">Unavailable</StatusBadge>
                  </div>
                  <p>{runtimeMode === "panel" ? "Panel mode intentionally uses connected nodes for runtime work." : "Docker is not reachable from the panel container."}</p>
                  <Button variant="secondary" disabled>Local hosting unavailable</Button>
                </Surface>
              )}

              {firstRemoteNode ? <NodeChoice node={firstRemoteNode} selected={selectedNodeId === firstRemoteNode.id} onSelect={() => chooseNode(firstRemoteNode.id)} /> : (
                <Surface as="article" material="solid" className="onboardingChoiceCard">
                  <div className="onboardingChoiceHeader">
                    <span className="onboardingChoiceIcon" aria-hidden="true"><AppIcon name="plus" /></span>
                    <div><strong>Another machine</strong><span>Connect a Docker host with the guided node installer.</span></div>
                    <StatusBadge tone="neutral">Optional</StatusBadge>
                  </div>
                  <p>The node opens an outbound connection to this panel; no inbound node port is required.</p>
                  <Button variant={localNode ? "secondary" : "primary"} onClick={onAddNode} disabled={!canManageNodes}>Add remote node</Button>
                </Surface>
              )}
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="onboardingStage" aria-labelledby="onboarding-server-title">
            <div className="onboardingStageHeading">
              <span>Step 2</span>
              <h3 id="onboarding-server-title">Create or restore your first server</h3>
              <p>{selectedNode ? `${selectedNode.isInternal ? "This machine" : selectedNode.name} is ready.` : "Choose a ready host before continuing."} Recommended runtime, memory, and ports are filled automatically.</p>
            </div>
            <div className="onboardingActionGrid">
              <Surface as="article" material="solid" className="onboardingActionCard">
                <span className="onboardingActionIcon" aria-hidden="true"><AppIcon name="server" /></span>
                <div><strong>Create a new server</strong><p>Choose Fabric or Paper, a Minecraft version, and a name. Advanced Docker and network controls remain available.</p></div>
                <Button onClick={() => selectedNode && onCreateServer(selectedNode.id)} disabled={!selectedNode || !canCreateServers}>Create server</Button>
              </Surface>
              <Surface as="article" material="solid" className="onboardingActionCard">
                <span className="onboardingActionIcon" aria-hidden="true"><AppIcon name="extract" /></span>
                <div><strong>Restore an export</strong><p>Import a serverSENTINEL ZIP as a new server on the selected host.</p></div>
                <Button variant="secondary" onClick={() => selectedNode && onImportServer(selectedNode.id)} disabled={!selectedNode || !canCreateServers}>Import export</Button>
              </Surface>
            </div>
            <div className="onboardingStageFooter"><Button variant="ghost" onClick={() => setStep(1)}><AppIcon name="chevronLeft" />Back to host</Button></div>
          </section>
        )}

        {step === 3 && (
          <section className="onboardingStage" aria-labelledby="onboarding-start-title">
            <div className="onboardingStageHeading">
              <span>Step 3</span>
              <h3 id="onboarding-start-title">Start and verify the runtime</h3>
              <p>The server was created in a stopped state so you stay in control of its first launch.</p>
            </div>
            {firstServer ? (
              <Surface as="article" material="solid" className="onboardingServerReadyCard">
                <div className="onboardingServerReadyCopy">
                  <span className="onboardingServerReadyIcon" aria-hidden="true"><AppIcon name="server" /></span>
                  <div><span>First managed server</span><strong>{firstServer.displayName}</strong><small>{serverRunning ? "Runtime is running" : "Ready for its first start"}</small></div>
                </div>
                <StatusBadge tone={serverRunning ? "success" : "accent"}>{serverRunning ? "Running" : "Stopped"}</StatusBadge>
                <div className="onboardingServerReadyActions">
                  <Button variant="secondary" onClick={() => onOpenServer(firstServer.id)}>Open Overview</Button>
                  {serverRunning ? <Button onClick={() => setStep(4)}>Continue</Button> : <Button onClick={() => void onStartServer()} disabled={!canControlServers || startingServer} reserveLabel="Starting server">{startingServer ? "Starting…" : "Start server"}</Button>}
                </div>
              </Surface>
            ) : <Banner tone="warning" title="No server found" message="Create or import a server before attempting its first start." action={<Button onClick={() => setStep(1)}>Choose host</Button>} />}
          </section>
        )}

        {step === 4 && (
          <section className="onboardingStage" aria-labelledby="onboarding-finish-title">
            <div className="onboardingStageHeading">
              <span>Step 4</span>
              <h3 id="onboarding-finish-title">Make the panel yours</h3>
              <p>These choices are optional. Everything remains editable from Settings and Nodes.</p>
            </div>

            <div className="onboardingFinishGrid">
              <Surface as="article" material="solid" className="onboardingFinishCard">
                <div><strong>Player heads</strong><StatusBadge tone={playerHeadsChoice ? "success" : "neutral"}>{playerHeadsChoice ? "Enabled" : "Private by default"}</StatusBadge></div>
                <p>When enabled, player usernames are sent from the panel host to MCHeads to retrieve avatar images.</p>
                <div className="onboardingSegmentedChoice" role="group" aria-label="Player heads preference">
                  <Button variant={!playerHeadsChoice ? "primary" : "secondary"} compact onClick={() => setPlayerHeadsChoice(false)} disabled={!canManageIntegrations || playerHeadsBusy}>Keep disabled</Button>
                  <Button variant={playerHeadsChoice ? "primary" : "secondary"} compact onClick={() => setPlayerHeadsChoice(true)} disabled={!canManageIntegrations || playerHeadsBusy}>Enable</Button>
                </div>
              </Surface>
              <Surface as="article" material="solid" className="onboardingFinishCard">
                <div><strong>Modrinth</strong><StatusBadge tone={modrinthConfigured ? "success" : "neutral"}>{modrinthConfigured ? "Configured" : "Optional"}</StatusBadge></div>
                <p>Add an API key for managed mod and plugin discovery, compatibility checks, and installs.</p>
                <Button variant="secondary" compact onClick={onOpenSettings}>Open integrations</Button>
              </Surface>
              <Surface as="article" material="solid" className="onboardingFinishCard">
                <div><strong>Scheduling time zone</strong><StatusBadge tone="accent">{panelTimeZone}</StatusBadge></div>
                <p>Schedules use this panel time zone. Display formatting can be customized independently in Settings.</p>
                <Button variant="secondary" compact onClick={onOpenSettings}>Open appearance</Button>
              </Surface>
              <Surface as="article" material="solid" className="onboardingFinishCard">
                <div><strong>Grow later</strong><StatusBadge tone="neutral">Always available</StatusBadge></div>
                <p>Add more nodes, create users, or restore additional servers whenever the fleet grows.</p>
                <Button variant="secondary" compact onClick={onAddNode} disabled={!canManageNodes}>Add another node</Button>
              </Surface>
            </div>
            <div className="onboardingCompletion">
              <div><strong>Setup is ready</strong><span>The guide will disappear after completion and can be replaced by the normal Overview.</span></div>
              <Button onClick={() => void finish()} disabled={finishing || playerHeadsBusy} reserveLabel="Finish setup">{finishing ? "Saving…" : "Finish setup"}<AppIcon name="chevronRight" /></Button>
            </div>
          </section>
        )}
      </div>
    </DialogSurface>
  );
}
