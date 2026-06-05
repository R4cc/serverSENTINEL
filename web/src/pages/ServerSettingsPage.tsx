import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { ContextNode, FabricVersions, ManagedServer } from '../types';
import { defaultDockerImageForMinecraftVersion, defaultServerPort, fabricLoaderVersionInfo, isValidServerPort, maxServerPort, memoryArgs, minecraftVersionInfo, minServerPort, parseMaxMemoryGb, replaceMemoryArgs, totalMemoryGb, versionSourceLabel, versionValue } from '../utils/format';
import { isNodeRuntimeUsable, nodeBlockReason, nodeCompatibilityLabel, nodeDockerLabel, nodeStatusLabel } from '../utils/nodes';

export function MemorySelector({
  totalMemory,
  initialMemoryGb = 4,
  javaArgs,
  onJavaArgsChange
}: {
  totalMemory: number;
  initialMemoryGb?: number;
  javaArgs: string;
  onJavaArgsChange: (value: string) => void;
}) {
  const totalRamGb = totalMemoryGb(totalMemory);
  const [memoryGb, setMemoryGb] = useState(() => Math.min(Math.max(1, initialMemoryGb), totalRamGb));

  useEffect(() => {
    setMemoryGb((current) => Math.min(Math.max(1, current), totalRamGb));
  }, [totalRamGb]);

  function updateMemory(value: number) {
    if (!Number.isFinite(value)) return;
    const nextMemoryGb = Math.min(Math.max(1, Math.round(value)), totalRamGb);
    setMemoryGb(nextMemoryGb);
    onJavaArgsChange(replaceMemoryArgs(javaArgs, nextMemoryGb));
  }

  return (
    <div className="memorySelector">
      <div className="memorySelectorHeader">
        <label htmlFor="memoryGb">Memory</label>
        <span className="totalRamLabel">Machine RAM: {totalRamGb} GB total</span>
      </div>
      <div className="memorySelectorControls">
        <input
          id="memoryGb"
          type="range"
          min="1"
          max={totalRamGb}
          value={memoryGb}
          onChange={(event) => updateMemory(Number(event.target.value))}
          className="memorySlider"
        />
        <div className="memoryInputWrap">
          <input
            type="number"
            min="1"
            max={totalRamGb}
            value={memoryGb}
            onChange={(event) => updateMemory(Number(event.target.value))}
            className="memoryNumberInput"
          />
          <span className="unit">GB</span>
        </div>
      </div>
      <p className="safelyAllocateTip">
        {memoryGb > totalRamGb * 0.8 ? (
          <span className="warn">Allocating over 80% of RAM may cause host instability.</span>
        ) : (
          <span className="ok">Safe allocation level for this host.</span>
        )}
      </p>
    </div>
  );
}

export function ServerEditForm({
  server,
  versions,
  totalMemory,
  onSubmit,
  disabled = false
}: {
  server: ManagedServer;
  versions: FabricVersions;
  totalMemory: number;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  disabled?: boolean;
}) {
  const [javaArgs, setJavaArgs] = useState(server.javaArgs || memoryArgs(parseMaxMemoryGb(server.javaArgs)));
  const [limitContainerMemory, setLimitContainerMemory] = useState(server.limitContainerMemory !== false);
  const detectedMinecraftVersion = minecraftVersionInfo(server);
  const detectedFabricLoaderVersion = fabricLoaderVersionInfo(server);

  return (
    <form onSubmit={onSubmit} className="appForm">
      <fieldset disabled={disabled}>
      <label>
        Display name
        <input name="displayName" defaultValue={server.displayName} required maxLength={80} />
      </label>
      <label>
        Minecraft version
        <select name="minecraftVersion" defaultValue={server.minecraftVersion}>
          {versions.game.length ? versions.game.map((version) => (
            <option key={version.version} value={version.version}>{version.version}</option>
          )) : <option value={server.minecraftVersion}>{server.minecraftVersion}</option>}
        </select>
        <span className="fieldHint">Current: {versionValue(detectedMinecraftVersion)} ({versionSourceLabel(detectedMinecraftVersion.source)})</span>
      </label>
      <label>
        Fabric loader version
        <select name="loaderVersion" defaultValue={server.loaderVersion ?? ""}>
          <option value="">Latest stable</option>
          {versions.loader.map((version) => (
            <option key={version.version} value={version.version}>{version.version}</option>
          ))}
        </select>
        <span className="fieldHint">Current: {versionValue(detectedFabricLoaderVersion)} ({versionSourceLabel(detectedFabricLoaderVersion.source)})</span>
      </label>
      <label>
        Fabric installer version
        <select name="installerVersion" defaultValue={server.installerVersion ?? ""}>
          <option value="">Latest stable</option>
          {versions.installer.map((version) => (
            <option key={version.version} value={version.version}>{version.version}</option>
          ))}
        </select>
      </label>
      <MemorySelector
        totalMemory={totalMemory}
        initialMemoryGb={parseMaxMemoryGb(javaArgs)}
        javaArgs={javaArgs}
        onJavaArgsChange={setJavaArgs}
      />
      <input type="hidden" name="limitContainerMemory" value={limitContainerMemory ? "true" : "false"} />
      <label className="checkLine">
        <input
          type="checkbox"
          checked={!limitContainerMemory}
          onChange={(event) => setLimitContainerMemory(!event.target.checked)}
        />
        Do not limit container memory
      </label>
      <p className="fieldHint">Java -Xmx still controls the Minecraft heap. This only removes Docker's outer memory cap.</p>
      <label>
        Java arguments
        <textarea
          className="javaArgsInput"
          name="javaArgs"
          value={javaArgs}
          onChange={(event) => setJavaArgs(event.target.value)}
          rows={4}
          spellCheck={false}
        />
      </label>
      <label>
        Docker runtime image
        <select name="dockerImage" defaultValue={server.dockerImage || "eclipse-temurin:21-jre"}>
          <option value="eclipse-temurin:21-jre">Java 21 runtime</option>
          <option value="eclipse-temurin:17-jre">Java 17 runtime</option>
          <option value="eclipse-temurin:25-jre">Java 25 runtime</option>
        </select>
      </label>
      <label>
        Server jar filename
        <input name="serverJar" defaultValue={server.serverJar || "fabric-server-launch.jar"} pattern="^[^\\/]+\.jar$" title="Use a local .jar filename, not a path." />
      </label>
      <label>
        Docker container name
        <input name="dockerContainer" defaultValue={server.dockerContainer || ""} pattern="^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$" title="Use letters, numbers, dots, dashes, and underscores." />
      </label>
      <label>
        Port bindings
        <input name="dockerPorts" defaultValue={server.dockerPorts || "25565:25565/tcp"} title="Use formats like 25565 or 25565:25565/tcp. Separate multiple bindings with commas." />
      </label>
      <button>Save server settings</button>
      </fieldset>
    </form>
  );
}

export function DeleteServerPanel({
  server,
  onSubmit,
  disabled = false
}: {
  server: ManagedServer;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  disabled?: boolean;
}) {
  const [confirmName, setConfirmName] = useState("");
  const deleteConfirmed = confirmName === server.displayName;

  useEffect(() => {
    setConfirmName("");
  }, [server.id]);

  return (
    <section className="panel dangerPanel">
      <h2>Delete Server</h2>
      <p className="muted">This removes the server from ServerSentinel. File deletion is optional and cannot be undone.</p>
      <form onSubmit={onSubmit} className="appForm">
        <fieldset disabled={disabled}>
        <label>
          Type server name to confirm
          <input
            name="confirmName"
            placeholder={server.displayName}
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
            required
          />
        </label>
        <label className="checkLine dangerCheck">
          <input name="deleteFiles" type="checkbox" />
          Also delete this server's files from disk
        </label>
        <button className="dangerButton" disabled={!deleteConfirmed}>Delete Server</button>
        </fieldset>
      </form>
    </section>
  );
}

export function ManagedServerForm({
  onSubmit,
  dockerSocketMounted,
  nodes = [],
  preferredNodeId = "",
  versions,
  totalMemory = 0,
  provisioning = false,
  disabledReason = ""
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  dockerSocketMounted: boolean;
  nodes?: ContextNode[];
  preferredNodeId?: string;
  versions: FabricVersions;
  totalMemory?: number;
  provisioning?: boolean;
  disabledReason?: string;
}) {
  const runtimeImages = [
    { value: "eclipse-temurin:21-jre", label: "Java 21 runtime (recommended)" },
    { value: "eclipse-temurin:17-jre", label: "Java 17 runtime" },
    { value: "eclipse-temurin:25-jre", label: "Java 25 runtime" }
  ];
  const defaultMinecraftVersion = versions.game[0]?.version ?? "1.21.4";
  const [minecraftVersion, setMinecraftVersion] = useState(defaultMinecraftVersion);
  const [dockerImage, setDockerImage] = useState(defaultDockerImageForMinecraftVersion(defaultMinecraftVersion));
  const [serverPort, setServerPort] = useState(String(defaultServerPort));
  const [javaArgs, setJavaArgs] = useState(memoryArgs(4));
  const [limitContainerMemory, setLimitContainerMemory] = useState(true);
  const usableNodes = useMemo(() => nodes.filter(isNodeRuntimeUsable), [nodes]);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const serverPortValid = isValidServerPort(serverPort);
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const placementBlocked = nodes.length === 0 || usableNodes.length === 0 || !selectedNode || !isNodeRuntimeUsable(selectedNode);
  const placementBlockedReason = nodes.length === 0
    ? "Add a node before creating a server."
    : usableNodes.length === 0
      ? "No node is online, compatible, and Docker-ready."
      : !selectedNode
        ? "Choose a node before creating this server."
        : nodeBlockReason(selectedNode) || "Choose a ready node before creating this server.";

  useEffect(() => {
    const nextVersion = versions.game[0]?.version;
    if (!nextVersion) return;
    setMinecraftVersion((current) => current === "1.21.4" ? nextVersion : current || nextVersion);
    setDockerImage(defaultDockerImageForMinecraftVersion(nextVersion));
  }, [versions.game]);

  useEffect(() => {
    if (preferredNodeId && usableNodes.some((node) => node.id === preferredNodeId)) {
      setSelectedNodeId(preferredNodeId);
      return;
    }
    if (usableNodes.length === 1) {
      setSelectedNodeId(usableNodes[0].id);
      return;
    }
    if (selectedNodeId && usableNodes.some((node) => node.id === selectedNodeId)) return;
    setSelectedNodeId(usableNodes[0]?.id ?? "");
  }, [preferredNodeId, selectedNodeId, usableNodes]);

  return (
    <form onSubmit={onSubmit} className="appForm">
      <fieldset disabled={provisioning}>
      <section className="placementStep" aria-labelledby="placement-title">
        <div className="placementHeader">
          <span>Placement</span>
          <h3 id="placement-title">Where should this server run?</h3>
        </div>
        {nodes.length === 0 ? (
          <div className="systemBanner warning placementWarning">
            <strong>No nodes available.</strong>
            <span>Add a node first so ServerSentinel has a host where it can create this server.</span>
          </div>
        ) : (
          <div className="nodePlacementGrid">
            {nodes.map((node) => {
              const usable = isNodeRuntimeUsable(node);
              const selected = selectedNodeId === node.id;
              const reason = nodeBlockReason(node);
              return (
                <label key={node.id} className={`nodePlacementCard ${selected ? "selected" : ""} ${!usable ? "disabled" : ""}`}>
                  <input
                    type="radio"
                    name="nodeId"
                    value={node.id}
                    checked={selected}
                    disabled={!usable}
                    onChange={() => setSelectedNodeId(node.id)}
                    required
                    title={!usable ? reason || "This node cannot host new servers right now." : `Run this server on ${node.name}`}
                  />
                  <span className="nodePlacementTitle">
                    <span className={`nodeStatusDot ${node.status}`} title={nodeStatusLabel(node.status)} aria-label={nodeStatusLabel(node.status)} />
                    <strong>{node.isInternal ? "Internal Node" : node.name}</strong>
                  </span>
                  <span>{node.servers.length} {node.servers.length === 1 ? "server" : "servers"}</span>
                  <span>{nodeDockerLabel(node)}</span>
                  <span>{nodeCompatibilityLabel(node)}</span>
                  {reason && <em>{reason}</em>}
                </label>
              );
            })}
          </div>
        )}
        {placementBlocked && nodes.length > 0 && (
          <p className="fieldError">{placementBlockedReason} If none are ready, open Nodes to see what needs attention.</p>
        )}
      </section>
      <label>
        Display name
        <input name="displayName" placeholder="Survival" required maxLength={80} />
      </label>
      <label>
        Minecraft version
        <select
          name="minecraftVersion"
          required
          value={minecraftVersion}
          onChange={(event) => {
            setMinecraftVersion(event.target.value);
            setDockerImage(defaultDockerImageForMinecraftVersion(event.target.value));
          }}
        >
          {versions.game.length ? versions.game.map((version) => (
            <option key={version.version} value={version.version}>{version.version}</option>
          )) : <option value="1.21.4">1.21.4</option>}
        </select>
      </label>
      <label>
        Server port
        <input
          name="serverPort"
          type="number"
          min={minServerPort}
          max={maxServerPort}
          value={serverPort}
          onChange={(event) => setServerPort(event.target.value)}
          aria-invalid={!serverPortValid}
          required
        />
        {!serverPortValid && (
          <span className="fieldError">Use a port from {minServerPort} to {maxServerPort}.</span>
        )}
      </label>
      <label className="checkLine">
        <input name="acceptEula" type="checkbox" required />
        I accept the Minecraft EULA for this server.
      </label>
      <details className="advanced">
        <summary>Advanced settings</summary>
        <MemorySelector
          totalMemory={totalMemory}
          initialMemoryGb={parseMaxMemoryGb(javaArgs)}
          javaArgs={javaArgs}
          onJavaArgsChange={setJavaArgs}
        />
        <input type="hidden" name="limitContainerMemory" value={limitContainerMemory ? "true" : "false"} />
        <label className="checkLine">
          <input
            type="checkbox"
            checked={!limitContainerMemory}
            onChange={(event) => setLimitContainerMemory(!event.target.checked)}
          />
          Do not limit container memory
        </label>
        <p className="fieldHint">Java -Xmx still controls the Minecraft heap. This only removes Docker's outer memory cap.</p>
        <label>
          Java arguments
          <textarea
            className="javaArgsInput"
            name="javaArgs"
            value={javaArgs}
            onChange={(event) => setJavaArgs(event.target.value)}
            rows={4}
            spellCheck={false}
          />
        </label>
        <label>
          Fabric loader version
          <select name="loaderVersion" defaultValue="">
            <option value="">Latest stable</option>
            {versions.loader.map((version) => (
              <option key={version.version} value={version.version}>{version.version}</option>
            ))}
          </select>
        </label>
        <label>
          Fabric installer version
          <select name="installerVersion" defaultValue="">
            <option value="">Latest stable</option>
            {versions.installer.map((version) => (
              <option key={version.version} value={version.version}>{version.version}</option>
            ))}
          </select>
        </label>
        <label>
          Server jar filename
          <input name="serverJar" placeholder="fabric-server-launch.jar" pattern="^[^\\/]+\.jar$" title="Use a local .jar filename, not a path." />
        </label>
        <label>
          Docker container name
          <input name="dockerContainer" placeholder="serversentinel-survival" pattern="^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$" title="Use letters, numbers, dots, dashes, and underscores." />
        </label>
        <label>
          Docker runtime image
          <select name="dockerImage" value={dockerImage} onChange={(event) => setDockerImage(event.target.value)}>
            {runtimeImages.map((image) => (
              <option key={image.value} value={image.value}>{image.label}</option>
            ))}
          </select>
        </label>
        <label>
          Port bindings
          <input name="dockerPorts" placeholder="25565:25565/tcp" title="Use formats like 25565 or 25565:25565/tcp. Separate multiple bindings with commas." />
        </label>
      </details>
      <p className="muted">
        {dockerSocketMounted ? "Docker is connected, so ServerSentinel can create and control this server." : "Docker is not connected yet. Connect Docker in Settings before using local runtime controls."}
      </p>
      <button
        disabled={provisioning || !serverPortValid || placementBlocked}
        title={provisioning ? disabledReason || "Server setup is still running." : !serverPortValid ? `Use a port from ${minServerPort} to ${maxServerPort}.` : placementBlocked ? placementBlockedReason : "Create managed server"}
      >
        {provisioning ? "Setting up..." : "Create Managed Server"}
      </button>
      </fieldset>
    </form>
  );
}
