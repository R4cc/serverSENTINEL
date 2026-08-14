import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { defaultDockerImageForMinecraftVersion, serverRuntimeDefinition } from "@serversentinel/contracts";
import { api } from "../api";
import { dockerContainerNameInputPattern, runtimeJarFilenameInputPattern } from "../utils/inputPatterns";
import type { ManagedServer, RuntimeVersion } from "../types";
import {
  formatAdaptiveBytes,
  isValidServerPort,
  maxServerPort,
  memoryArgs,
  minecraftVersionInfo,
  minServerPort,
  parseJavaMemoryArgs,
  parseMaxMemoryGb,
  runtimeVersionInfo,
  versionSourceLabel,
  versionValue
} from "../utils/format";
import { AppIcon } from "../components/FileTypeIcon";
import { Banner, Button, FormField, PanelHeader, Spinner, StatusBadge } from "../components/UiPrimitives";
import type { ServerExportArtifact, ServerExportState } from "../features/exports/useExportWorkspace";
import {
  clampNumber,
  fallbackFabricRuntimeVersions,
  fallbackMinecraftVersions,
  formatManagedPortBindings,
  memoryBoundsForNode,
  parseAdditionalPortBindings,
  portBindingId,
  queryPortForServer,
  serverPortForServer,
  syncJavaMemoryArgs,
  wizardJavaArgs,
  type PortBindingRow
} from "./serverSettingsHelpers";
import { MemoryNumberInput, MemoryRangeControl } from "./ServerSettingsShared";

function AdditionalPortBindingsEditor({
  initialValue,
  serverPort,
  queryPort,
  onChange
}: {
  initialValue?: string;
  serverPort: string;
  queryPort: string;
  onChange?: () => void;
}) {
  const [bindings, setBindings] = useState(() => parseAdditionalPortBindings(initialValue, serverPort, queryPort));
  const serializedBindings = formatManagedPortBindings(serverPort, queryPort, bindings);

  useEffect(() => {
    setBindings((current) => current.filter((row) => {
      const [containerPort, protocol = "tcp"] = row.target.split("/", 2);
      return !(row.hostPort === serverPort && containerPort === serverPort && protocol === "tcp")
        && !(row.hostPort === queryPort && containerPort === queryPort && protocol === "udp");
    }));
  }, [serverPort, queryPort]);

  function updateBinding(id: string, patch: Partial<PortBindingRow>) {
    onChange?.();
    setBindings((current) => current.map((binding) => binding.id === id ? { ...binding, ...patch } : binding));
  }

  function addBinding() {
    onChange?.();
    setBindings((current) => [...current, { id: portBindingId(), hostPort: "", target: "" }]);
  }

  function removeBinding(id: string) {
    onChange?.();
    setBindings((current) => current.filter((binding) => binding.id !== id));
  }

  return (
    <div className={`portBindingsEditor ${bindings.length > 1 ? "hasExtraBindings" : ""}`}>
      <span className="fieldLabel">Additional port bindings</span>
      <input type="hidden" name="dockerPorts" value={serializedBindings} />
      <div className="portBindingRows">
        {bindings.map((binding) => (
          <div key={binding.id} className="portBindingRow">
            <input
              type="text"
              inputMode="numeric"
              value={binding.hostPort}
              onChange={(event) => updateBinding(binding.id, { hostPort: event.target.value })}
              placeholder="24454"
              aria-label="Additional host port"
            />
            <span className="portBindingColon" aria-hidden="true">:</span>
            <input
              type="text"
              value={binding.target}
              onChange={(event) => updateBinding(binding.id, { target: event.target.value })}
              placeholder="24454/udp"
              aria-label="Additional container port and protocol"
            />
            <Button
              variant="ghost"
              iconOnly
              className="iconDangerButton portBindingRemoveButton"
              onClick={() => removeBinding(binding.id)}
              aria-label="Remove port binding"
              title="Remove port binding"
            >
              <AppIcon name="trash" />
            </Button>
          </div>
        ))}
      </div>
      <Button variant="secondary" compact className="portBindingAddButton" onClick={addBinding}>
        <AppIcon name="plus" />
        <span>Add port binding</span>
      </Button>
      <span className="fieldHint">Use host port on the left and container port/protocol on the right, for example 24454 : 24454/udp.</span>
    </div>
  );
}

function MinecraftPortsSection({
  serverPort,
  queryPort,
  onServerPortChange,
  onQueryPortChange,
  serverPortValid,
  queryPortValid,
  portConflict
}: {
  serverPort: string;
  queryPort: string;
  onServerPortChange: (value: string) => void;
  onQueryPortChange: (value: string) => void;
  serverPortValid: boolean;
  queryPortValid: boolean;
  portConflict: boolean;
}) {
  // Each range error sits under the field it belongs to; the conflict is about the
  // pair, so it stays one message that both inputs point at.
  const conflictId = portConflict ? "properties-port-conflict" : undefined;
  const describedBy = (hintId: string, errorId?: string) => [hintId, errorId, conflictId].filter(Boolean).join(" ");
  const serverPortError = serverPortValid ? undefined : `Use a server port from ${minServerPort} to ${maxServerPort}.`;
  const queryPortError = queryPortValid ? undefined : `Use a Query port from ${minServerPort} to ${maxServerPort}.`;

  return (
    <section className="minecraftPortsSection" aria-label="Minecraft network ports">
      <div className="minecraftPortsGrid">
        <FormField
          label="Server port"
          htmlFor="properties-server-port"
          required
          description={<span id="properties-server-port-hint">TCP port used by Minecraft clients.</span>}
          error={serverPortError && <span id="properties-server-port-error">{serverPortError}</span>}
        >
          <input
            id="properties-server-port"
            name="serverPort"
            type="number"
            min={minServerPort}
            max={maxServerPort}
            value={serverPort}
            onChange={(event) => onServerPortChange(event.target.value)}
            aria-invalid={!serverPortValid || portConflict}
            aria-describedby={describedBy("properties-server-port-hint", serverPortError && "properties-server-port-error")}
            required
          />
        </FormField>
        <FormField
          label="Query port"
          htmlFor="properties-query-port"
          required
          description={<span id="properties-query-port-hint">UDP port used by serverSENTINEL for quiet player metrics.</span>}
          error={queryPortError && <span id="properties-query-port-error">{queryPortError}</span>}
        >
          <input
            id="properties-query-port"
            name="queryPort"
            type="number"
            min={minServerPort}
            max={maxServerPort}
            value={queryPort}
            onChange={(event) => onQueryPortChange(event.target.value)}
            aria-invalid={!queryPortValid || portConflict}
            aria-describedby={describedBy("properties-query-port-hint", queryPortError && "properties-query-port-error")}
            required
          />
        </FormField>
      </div>
      {portConflict && (
        <span className="uiFormFieldError" id="properties-port-conflict" role="alert">Server port and Query port must be different.</span>
      )}
    </section>
  );
}

export function ServerEditForm({
  server,
  totalMemory,
  onSubmit,
  exportPanel,
  dangerZone,
  disabledReason = "",
  disabled = false,
  saving = false
}: {
  server: ManagedServer;
  totalMemory: number;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | boolean | Promise<void | boolean>;
  exportPanel?: ReactNode;
  dangerZone?: ReactNode;
  disabledReason?: string;
  disabled?: boolean;
  saving?: boolean;
}) {
  const initialJavaArgs = server.javaArgs || memoryArgs(parseMaxMemoryGb(server.javaArgs));
  const initialMemory = parseJavaMemoryArgs(initialJavaArgs);
  const initialMaximumHeapGb = parseMaxMemoryGb(initialJavaArgs);
  const initialMinimumHeapGb = initialMemory.xmsGb ?? initialMaximumHeapGb;
  const memoryBounds = useMemo(() => memoryBoundsForNode(totalMemory), [totalMemory]);
  const formId = `server-settings-form-${server.id}`;
  const [displayName, setDisplayName] = useState(server.displayName);
  const runtime = serverRuntimeDefinition(server.runtimeProfile.runtimeType);
  const [minecraftVersion, setMinecraftVersion] = useState(server.runtimeProfile.minecraftVersion);
  const [runtimeVersion, setRuntimeVersion] = useState(server.runtimeProfile.runtimeVersion);
  const [availableMinecraftVersions, setAvailableMinecraftVersions] = useState(() => runtime.type === "fabric"
    ? fallbackMinecraftVersions
    : [{ version: server.runtimeProfile.minecraftVersion, stable: true, type: "release" as const }]);
  const [availableRuntimeVersions, setAvailableRuntimeVersions] = useState<RuntimeVersion[]>(() => runtime.type === "fabric"
    ? fallbackFabricRuntimeVersions
    : []);
  const [dockerImage, setDockerImage] = useState(server.dockerImage || defaultDockerImageForMinecraftVersion(server.runtimeProfile.minecraftVersion));
  const [serverJar, setServerJar] = useState(server.runtimeProfile.jarArtifact.filename);
  const [dockerContainer, setDockerContainer] = useState(server.dockerContainer || "");
  const [minimumHeapGb, setMinimumHeapGb] = useState(() => clampNumber(initialMinimumHeapGb, memoryBounds.min, memoryBounds.max));
  const [maximumHeapGb, setMaximumHeapGb] = useState(() => clampNumber(initialMaximumHeapGb, memoryBounds.min, memoryBounds.max));
  const [javaArgs, setJavaArgs] = useState(() => wizardJavaArgs(
    clampNumber(initialMinimumHeapGb, memoryBounds.min, memoryBounds.max),
    clampNumber(initialMaximumHeapGb, memoryBounds.min, memoryBounds.max),
    initialJavaArgs
  ));
  const [serverPort, setServerPort] = useState(() => serverPortForServer(server));
  const [queryPort, setQueryPort] = useState(() => queryPortForServer(server));
  const [startOnNodeStart, setStartOnNodeStart] = useState(server.startOnNodeStart ?? false);
  const [resetVersion, setResetVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const detectedMinecraftVersion = minecraftVersionInfo(server);
  const detectedRuntimeVersion = runtimeVersionInfo(server);
  const serverPortValid = isValidServerPort(serverPort);
  const queryPortValid = isValidServerPort(queryPort);
  const portConflict = serverPort === queryPort;
  const memoryWarning = maximumHeapGb > memoryBounds.max * 0.8;
  const currentMinecraftVersionListed = availableMinecraftVersions.some((version) => version.version === minecraftVersion);
  const currentRuntimeVersionListed = !runtimeVersion || availableRuntimeVersions.some((version) => version.runtimeVersion === runtimeVersion);

  useEffect(() => {
    resetFormState();
  }, [server.id, server.updatedAt]);

  useEffect(() => {
    let cancelled = false;
    api<{ versions: Array<{ id: string; type?: "release" | "snapshot" | "unknown"; supported?: boolean; recommended?: boolean }> }>(`/api/runtime/${runtime.type}/minecraft-versions`)
      .then((result) => {
        if (!cancelled) setAvailableMinecraftVersions(result.versions.map((version) => ({
          version: version.id,
          stable: version.type === "release" && version.supported !== false,
          recommended: version.recommended,
          type: version.type ?? "unknown"
        })));
      })
      .catch(() => {
        if (!cancelled) setAvailableMinecraftVersions(runtime.type === "fabric"
          ? fallbackMinecraftVersions
          : [{ version: server.runtimeProfile.minecraftVersion, stable: true, type: "release" }]);
      });
    return () => {
      cancelled = true;
    };
  }, [runtime.type, server.id, server.runtimeProfile.minecraftVersion]);

  useEffect(() => {
    if (!minecraftVersion) {
      setAvailableRuntimeVersions([]);
      return;
    }
    let cancelled = false;
    api<{ runtimeVersions: RuntimeVersion[] }>(`/api/runtime/${runtime.type}/versions?minecraftVersion=${encodeURIComponent(minecraftVersion)}`)
      .then((result) => {
        if (!cancelled) setAvailableRuntimeVersions(result.runtimeVersions);
      })
      .catch(() => {
        if (!cancelled) setAvailableRuntimeVersions(runtime.type === "fabric"
          ? fallbackFabricRuntimeVersions
          : []);
      });
    return () => {
      cancelled = true;
    };
  }, [minecraftVersion, runtime.type]);

  useEffect(() => {
    setServerPort(serverPortForServer(server));
    setQueryPort(queryPortForServer(server));
  }, [server.id, server.dockerPorts, server.managedPorts]);

  useEffect(() => {
    setMinimumHeapGb((current) => Math.min(clampNumber(current, memoryBounds.min, memoryBounds.max), maximumHeapGb));
    setMaximumHeapGb((current) => Math.max(clampNumber(current, memoryBounds.min, memoryBounds.max), minimumHeapGb));
  }, [maximumHeapGb, memoryBounds.max, memoryBounds.min, minimumHeapGb]);

  function resetFormState() {
    const nextJavaArgs = server.javaArgs || memoryArgs(parseMaxMemoryGb(server.javaArgs));
    const nextMemory = parseJavaMemoryArgs(nextJavaArgs);
    const nextMaximum = clampNumber(nextMemory.xmxGb ?? parseMaxMemoryGb(nextJavaArgs), memoryBounds.min, memoryBounds.max);
    const nextMinimum = clampNumber(nextMemory.xmsGb ?? nextMaximum, memoryBounds.min, nextMaximum);
    setDisplayName(server.displayName);
    setMinecraftVersion(server.runtimeProfile.minecraftVersion);
    setRuntimeVersion(server.runtimeProfile.runtimeVersion);
    setDockerImage(server.dockerImage || defaultDockerImageForMinecraftVersion(server.runtimeProfile.minecraftVersion));
    setServerJar(server.runtimeProfile.jarArtifact.filename);
    setDockerContainer(server.dockerContainer || "");
    setMinimumHeapGb(nextMinimum);
    setMaximumHeapGb(nextMaximum);
    setJavaArgs(wizardJavaArgs(nextMinimum, nextMaximum, nextJavaArgs));
    setServerPort(serverPortForServer(server));
    setQueryPort(queryPortForServer(server));
    setStartOnNodeStart(server.startOnNodeStart ?? false);
    setResetVersion((current) => current + 1);
    setDirty(false);
  }

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    const saved = await onSubmit(event);
    if (saved === true) setDirty(false);
  }

  function updateMinimumHeap(value: number) {
    const next = clampNumber(Math.round(value), memoryBounds.min, Math.min(memoryBounds.max, maximumHeapGb));
    setMinimumHeapGb(next);
    setJavaArgs((current) => wizardJavaArgs(next, maximumHeapGb, current));
  }

  function updateMaximumHeap(value: number) {
    const next = clampNumber(Math.round(value), Math.max(memoryBounds.min, minimumHeapGb), memoryBounds.max);
    setMaximumHeapGb(next);
    setJavaArgs((current) => wizardJavaArgs(minimumHeapGb, next, current));
  }

  function updateJavaArgs(value: string) {
    setJavaArgs(value);
    syncJavaMemoryArgs(value, memoryBounds, minimumHeapGb, maximumHeapGb, setMinimumHeapGb, setMaximumHeapGb);
  }

  return (
    <div className="serverPropertiesWorkspace">
      <form id={formId} onSubmit={submitForm} onChange={() => setDirty(true)} className="serverPropertiesForm">
        {disabled && disabledReason && !saving && <Banner tone="warning" className="propertiesLockBanner" title={disabledReason} />}
        <fieldset disabled={disabled}>
          <input type="hidden" name="runtimeType" value={server.runtimeProfile.runtimeType} />
          <section className="propertiesSettingsSurface">
            <section className="propertiesSection propertiesSectionGeneral">
              <PanelHeader
                title="General"
              />
              <div className="propertiesFieldGrid three">
                <FormField htmlFor="properties-display-name" label="Display name" required>
                  <input id="properties-display-name" name="displayName" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={80} />
                </FormField>
                <FormField htmlFor="properties-minecraft-version" label="Minecraft version" description={<>Current: {versionValue(detectedMinecraftVersion)} ({versionSourceLabel(detectedMinecraftVersion.source)})</>}>
                  <select id="properties-minecraft-version" name="minecraftVersion" value={minecraftVersion} onChange={(event) => {
                    setMinecraftVersion(event.target.value);
                    setRuntimeVersion("");
                  }}>
                    {minecraftVersion && !currentMinecraftVersionListed && <option value={minecraftVersion}>{minecraftVersion}</option>}
                    {runtime.managedProvisioning && availableMinecraftVersions.length ? availableMinecraftVersions.map((version) => (
                      <option key={version.version} value={version.version}>{version.version}</option>
                    )) : <option value={server.runtimeProfile.minecraftVersion}>{server.runtimeProfile.minecraftVersion}</option>}
                  </select>
                </FormField>
                <FormField htmlFor="properties-runtime-version" label={runtime.versionLabel} description={<>Current: {versionValue(detectedRuntimeVersion)} ({versionSourceLabel(detectedRuntimeVersion.source)})</>}>
                  <select id="properties-runtime-version" name="runtimeVersion" value={runtimeVersion} onChange={(event) => setRuntimeVersion(event.target.value)}>
                    {runtime.managedProvisioning && <option value="">Latest stable</option>}
                    {runtimeVersion && (!runtime.managedProvisioning || !currentRuntimeVersionListed) && <option value={runtimeVersion}>{runtimeVersion}</option>}
                    {runtime.managedProvisioning && availableRuntimeVersions.map((version) => (
                      <option key={version.id} value={version.runtimeVersion}>{version.runtimeVersion}{version.stable === false ? " (Development)" : ""}</option>
                    ))}
                  </select>
                </FormField>
              </div>
              <label className="propertiesStartupToggle">
                <span className="switch">
                  <input
                    name="startOnNodeStart"
                    type="checkbox"
                    checked={startOnNodeStart}
                    onChange={(event) => setStartOnNodeStart(event.target.checked)}
                  />
                  <span className="slider" />
                </span>
                <span>
                  <strong>Start when node starts</strong>
                </span>
              </label>
            </section>

            <section className="propertiesSection propertiesSectionResources">
              <PanelHeader
                title="Resources"
              />
              <section className="resourceStepSection propertiesMemorySection" aria-label="Minecraft memory">
                <div className="memoryRangeLayout">
                  <MemoryRangeControl
                    bounds={memoryBounds}
                    minimumHeapGb={minimumHeapGb}
                    maximumHeapGb={maximumHeapGb}
                    onMinimumHeapChange={updateMinimumHeap}
                    onMaximumHeapChange={updateMaximumHeap}
                  />
                  <div className="memoryNumberFields">
                    <MemoryNumberInput
                      id="edit-minimum-heap"
                      label="Minimum heap (Xms)"
                      value={minimumHeapGb}
                      min={memoryBounds.min}
                      max={maximumHeapGb}
                      onChange={updateMinimumHeap}
                    />
                    <span className="memoryHeapDivider" aria-hidden="true">/</span>
                    <MemoryNumberInput
                      id="edit-maximum-heap"
                      label="Maximum heap (Xmx)"
                      value={maximumHeapGb}
                      min={minimumHeapGb}
                      max={memoryBounds.max}
                      onChange={updateMaximumHeap}
                    />
                  </div>
                </div>
                <div className="memoryRangeMeta">
                  <span>Recommended: {memoryBounds.recommendedMin} GB - {memoryBounds.recommendedMax} GB</span>
                  <span>Total available: {memoryBounds.max} GB</span>
                </div>
                {memoryWarning && (
                  <span className="propertiesMemoryWarning">Leave some RAM for the host. Using nearly all memory may cause instability.</span>
                )}
                <input type="hidden" name="javaArgs" value={javaArgs} />
              </section>
            </section>

            <section className="propertiesSection propertiesSectionNetwork">
              <PanelHeader
                title="Network"
              />
              <MinecraftPortsSection
                serverPort={serverPort}
                queryPort={queryPort}
                onServerPortChange={setServerPort}
                onQueryPortChange={setQueryPort}
                serverPortValid={serverPortValid}
                queryPortValid={queryPortValid}
                portConflict={portConflict}
              />
            </section>

            <details className="resourceDisclosure advancedResourceDisclosure propertiesDisclosure">
              <summary>
                <span className="propertiesDisclosureCopy">
                  <strong>Advanced</strong>
                  <small>Container, Java, and additional port settings.</small>
                </span>
              </summary>
              <div className="advancedResourceBody propertiesAdvancedBody">
                {/* The same field primitive the General section uses, so a label,
                    its help text and its control line up the same way everywhere. */}
                <div className="propertiesFieldGrid two">
                  <FormField
                    label="Docker runtime image"
                    htmlFor="edit-docker-image"
                    description={<span id="edit-docker-image-description">Java runtime image used for the server container.</span>}
                  >
                    <select id="edit-docker-image" name="dockerImage" value={dockerImage} onChange={(event) => setDockerImage(event.target.value)} aria-describedby="edit-docker-image-description">
                      <option value="eclipse-temurin:21-jre">Java 21 runtime</option>
                      <option value="eclipse-temurin:17-jre">Java 17 runtime</option>
                      <option value="eclipse-temurin:25-jre">Java 25 runtime</option>
                    </select>
                  </FormField>
                  <FormField
                    label="Server jar filename"
                    htmlFor="edit-server-jar"
                    description={<span id="edit-server-jar-description">A local .jar filename, not a path.</span>}
                  >
                    <input id="edit-server-jar" name="serverJar" value={serverJar} onChange={(event) => setServerJar(event.target.value)} pattern={runtimeJarFilenameInputPattern} title="Use a local .jar filename, not a path." aria-describedby="edit-server-jar-description" />
                  </FormField>
                  <FormField
                    className="propertiesFieldWide"
                    label="Docker container name"
                    htmlFor="edit-docker-container"
                    description={<span id="edit-docker-container-description">Letters, numbers, dots, dashes, and underscores.</span>}
                  >
                    <input
                      id="edit-docker-container"
                      name="dockerContainer"
                      value={dockerContainer}
                      onChange={(event) => setDockerContainer(event.target.value)}
                      pattern={dockerContainerNameInputPattern}
                      title="Use letters, numbers, dots, dashes, and underscores."
                      aria-describedby="edit-docker-container-description"
                    />
                  </FormField>
                  <FormField
                    className="propertiesFieldWide"
                    label="Java arguments"
                    htmlFor="edit-java-args"
                    description={<span id="edit-java-args-description">Launch flags used by the Minecraft runtime. Memory flags follow the heap sliders above.</span>}
                  >
                    <textarea
                      id="edit-java-args"
                      className="javaArgsInput"
                      value={javaArgs}
                      onChange={(event) => updateJavaArgs(event.target.value)}
                      rows={4}
                      spellCheck={false}
                      aria-describedby="edit-java-args-description"
                    />
                  </FormField>
                </div>
                <div className="propertiesAdvancedPorts">
                  <AdditionalPortBindingsEditor key={`${server.id}-${resetVersion}`} initialValue={server.dockerPorts} serverPort={serverPort} queryPort={queryPort} onChange={() => setDirty(true)} />
                </div>
              </div>
            </details>
          </section>
        </fieldset>
        {(dirty || saving) && (
          <div className="propertiesSaveDock" aria-live="polite">
            <div className="propertiesSaveDockCopy">
              <strong>Unsaved changes</strong>
              <span>Apply or discard your server configuration changes.</span>
            </div>
            <div className="propertiesActionButtons">
              <Button variant="secondary" onClick={resetFormState} disabled={saving}>
                Discard
              </Button>
              <Button
                type="submit"
                disabled={disabled || !serverPortValid || !queryPortValid || portConflict}
                aria-busy={saving}
                reserveLabel="Saving changes"
              >
                {saving ? <><Spinner size="xs" tone="current" />Saving changes</> : "Save changes"}
              </Button>
            </div>
          </div>
        )}
      </form>

      {/* Both live outside the settings form so their own buttons cannot submit it. */}
      {(exportPanel || dangerZone) && (
        <div className={`propertiesSideCards${exportPanel && dangerZone ? " propertiesSideCards--paired" : ""}`}>
          {exportPanel && <div className="propertiesExportZone">{exportPanel}</div>}
          {dangerZone && <div className="propertiesDangerZone">{dangerZone}</div>}
        </div>
      )}
    </div>
  );
}

export function ExportServerPanel({
  server,
  onExport,
  onCancel,
  onDelete,
  state,
  loading = false,
  error = "",
  formatDate = (value) => new Date(value).toLocaleString(),
  disabled = false,
  deletingExportId = ""
}: {
  server: ManagedServer;
  onExport: () => void;
  onCancel?: (operationId: string) => void;
  onDelete?: (artifact: ServerExportArtifact) => void;
  state?: ServerExportState;
  loading?: boolean;
  error?: string;
  formatDate?: (value: string | number | Date) => string;
  disabled?: boolean;
  deletingExportId?: string;
}) {
  const latest = state?.latest ?? null;
  const artifact = state?.artifact ?? null;
  const active = latest?.status === "queued" || latest?.status === "running";
  const cancelling = active && latest.task === "Cancelling export";
  const statusLabel = latest?.status === "succeeded"
    ? "Ready"
    : latest?.status === "failed"
      ? "Failed"
      : latest?.status === "cancelled"
        ? "Cancelled"
        : cancelling ? "Cancelling" : active ? "Running" : "No exports";
  const statusTone = latest?.status === "succeeded"
    ? "success"
    : latest?.status === "failed"
      ? "danger"
      : latest?.status === "cancelled"
        ? "warning"
        : active ? "accent" : "neutral";
  const retainedIsPrevious = Boolean(artifact && latest && artifact.operationId !== latest.id);

  return (
    <section className="propertiesSideCard exportPanel">
      <PanelHeader
        title="Exports"
        description={`Download ${server.displayName} as a ZIP archive you can import back into this panel or another one.`}
        actions={<StatusBadge tone={statusTone}>{statusLabel}</StatusBadge>}
      />
      {latest ? (
        <div className="exportTaskSummary" role={active ? "status" : undefined}>
          <div className="exportTaskCopy">
            <strong>{latest.task || statusLabel}</strong>
            <small>{formatDate(latest.finishedAt ?? latest.startedAt ?? latest.createdAt)}</small>
          </div>
          {active && (
            <div className="exportTaskProgress">
              <progress aria-label="Export progress" value={latest.progress} max={100} />
              <span>{latest.progress}%</span>
            </div>
          )}
          {(latest.status === "failed" || latest.status === "cancelled") && latest.errorMessage && (
            <p className="exportTaskError">{latest.errorMessage}</p>
          )}
          {active && !latest.canCancel && latest.task !== "Finalizing export" && !latest.startedByRequester && (
            <small>This export was started by another user.</small>
          )}
        </div>
      ) : (
        <p className="exportTaskEmpty">{loading ? "Loading export status…" : error || "No export has been created yet."}</p>
      )}

      {artifact && (
        <div className="exportArtifactRow">
          <div className="exportArtifactCopy">
            <strong>{retainedIsPrevious ? "Last successful export" : artifact.filename}</strong>
            <small>
              {retainedIsPrevious ? `${artifact.filename} · ` : ""}
              {artifact.size !== undefined && (
                <span className="exportSizeValue" title={`${artifact.size.toLocaleString()} ${artifact.size === 1 ? "byte" : "bytes"}`}>
                  {formatAdaptiveBytes(artifact.size)}
                </span>
              )}
              {` · ${formatDate(artifact.createdAt)}`}
            </small>
          </div>
          {artifact.downloadUrl ? (
            <div className="exportArtifactActions">
              <a className="uiButton uiButton--secondary uiButton--compact" href={artifact.downloadUrl} download>
                <AppIcon name="download" /> Download
              </a>
              {onDelete && (
                <Button
                  variant="critical"
                  compact
                  onClick={() => onDelete(artifact)}
                  disabled={disabled || deletingExportId === artifact.operationId}
                  aria-busy={deletingExportId === artifact.operationId}
                  reserveLabel="Deleting…"
                >
                  <AppIcon name="trash" /> {deletingExportId === artifact.operationId ? "Deleting…" : "Delete"}
                </Button>
              )}
            </div>
          ) : <small>Download available to the user who created it.</small>}
        </div>
      )}

      {error && latest && <p className="exportTaskError">{error}</p>}
      <div className="exportPanelActions">
        <Button variant="secondary" onClick={onExport} disabled={disabled || active}>
          <AppIcon name="download" /> {latest ? "New export" : "Export server"}
        </Button>
        {active && latest.canCancel && (
          <Button variant="critical" onClick={() => onCancel?.(latest.id)} disabled={cancelling}>
            <AppIcon name="x" /> {cancelling ? "Cancelling…" : "Abort"}
          </Button>
        )}
      </div>
    </section>
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
    <section className="propertiesSideCard dangerPanel">
      <PanelHeader
        title="Danger zone"
        description="Deleting a server is permanent and cannot be undone."
      />
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
            autoComplete="off"
            aria-invalid={confirmName.length > 0 && !deleteConfirmed}
            aria-describedby="delete-server-confirm-hint"
          />
          <small id="delete-server-confirm-hint" className="fieldHint">Enter “{server.displayName}” exactly to enable deletion.</small>
        </label>
        <label className="checkLine dangerCheck">
          <input name="deleteFiles" type="checkbox" />
          Also delete this server's files from disk
        </label>
        <Button type="submit" variant="critical" disabled={!deleteConfirmed} title={deleteConfirmed ? "Permanently delete this server" : `Enter “${server.displayName}” exactly to enable deletion`}>Delete server</Button>
        </fieldset>
      </form>
    </section>
  );
}
