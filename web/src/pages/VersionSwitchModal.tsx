import { useId, useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import { compareMinecraftVersions, serverRuntimeDefinition, type VersionSwitchPlan, type VersionSwitchResult } from "@serversentinel/contracts";
import { api } from "../api";
import { DialogSurface } from "../components/DialogSurface";
import { AppIcon } from "../components/FileTypeIcon";
import { Banner, Button, FormField, Spinner, StatusBadge } from "../components/UiPrimitives";
import { ModIconImage } from "../features/mods/ModIconImage";
import type { ManagedServer } from "../types";
import { modIconSource } from "../utils/appHelpers";
import { useMinecraftVersions, useRuntimeVersions } from "./useServerSettings";
import { versionSwitchOutcomeGroups, versionSwitchPlanGroups, versionSwitchPlanSummary, type VersionSwitchGroup } from "./versionSwitchHelpers";

type Step = "choose" | "review" | "applying" | "done";

export type VersionSwitchRequestBody = { minecraftVersion: string; runtimeVersion?: string };

/** Demo servers live in the browser; the page supplies these instead of calling the panel. */
export type VersionSwitchSimulation = {
  plan: (request: VersionSwitchRequestBody) => Promise<VersionSwitchPlan>;
  apply: (request: VersionSwitchRequestBody) => Promise<VersionSwitchResult>;
};

function VersionSwitchGroups({ groups, label }: { groups: VersionSwitchGroup[]; label: string }) {
  if (!groups.length) return null;
  return (
    <div className="versionSwitchGroups" aria-label={label}>
      {groups.map((group) => {
        const list = (
          <ul className="versionSwitchRows">
            {group.rows.map((row) => (
              <li key={row.key} className="versionSwitchRow">
                <ModIconImage src={modIconSource(row.iconUrl)} fallback="JAR" />
                <span className="versionSwitchRowCopy">
                  <strong title={row.name}>{row.name}</strong>
                  {row.detail && <small>{row.detail}</small>}
                </span>
                {(row.fromVersion || row.toVersion) && (
                  <span className="versionSwitchRowVersions">
                    {row.fromVersion && <span title={row.fromVersion}>{row.fromVersion}</span>}
                    {row.fromVersion && row.toVersion && <ArrowRight aria-label="to" />}
                    {row.toVersion && <span title={row.toVersion}>{row.toVersion}</span>}
                  </span>
                )}
              </li>
            ))}
          </ul>
        );
        const heading = (
          <>
            <span>{group.title}</span>
            <StatusBadge tone={group.tone}>{group.rows.length}</StatusBadge>
          </>
        );
        return group.collapsed ? (
          <details key={group.id} className={`versionSwitchGroup versionSwitchGroup--${group.tone}`}>
            <summary className="versionSwitchGroupTitle">{heading}<AppIcon name="chevronDown" /></summary>
            {list}
          </details>
        ) : (
          <section key={group.id} className={`versionSwitchGroup versionSwitchGroup--${group.tone}`}>
            <h3 className="versionSwitchGroupTitle">{heading}</h3>
            {list}
          </section>
        );
      })}
    </div>
  );
}

function VersionTransition({ label, from, to }: { label: string; from?: string; to?: string }) {
  const changed = from !== to;
  return (
    <div className={`versionSwitchTransition${changed ? " versionSwitchTransition--changed" : ""}`}>
      <span className="versionSwitchTransitionLabel">{label}</span>
      <span className="versionSwitchTransitionValues">
        <span>{from || "Unknown"}</span>
        {changed && <><ArrowRight aria-label="to" /><strong>{to || "Latest"}</strong></>}
      </span>
    </div>
  );
}

export function VersionSwitchModal({
  server,
  onClose,
  onSwitched,
  simulation
}: {
  server: ManagedServer;
  onClose: () => void;
  onSwitched: (result: VersionSwitchResult & { server?: ManagedServer }) => void | Promise<void>;
  simulation?: VersionSwitchSimulation;
}) {
  const titleId = useId();
  const minecraftId = useId();
  const runtimeId = useId();
  const backupId = useId();
  const profile = server.runtimeProfile;
  const runtime = serverRuntimeDefinition(profile.runtimeType);
  const plural = runtime.contentKind;
  const singular = plural === "plugins" ? "plugin" : "mod";
  const Plural = plural === "plugins" ? "Plugins" : "Mods";
  const [step, setStep] = useState<Step>("choose");
  const [pickedVersion, setPickedVersion] = useState("");
  const [runtimeVersion, setRuntimeVersion] = useState("");
  const [plan, setPlan] = useState<VersionSwitchPlan | null>(null);
  const [result, setResult] = useState<VersionSwitchResult | null>(null);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState("");
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const { versions: minecraftVersions, loading: minecraftLoading } = useMinecraftVersions(profile.runtimeType, profile.minecraftVersion, server.id);

  const choices = useMemo(() => {
    const stable = minecraftVersions.filter((version) => version.stable || version.version === profile.minecraftVersion);
    return stable.length ? stable : minecraftVersions;
  }, [minecraftVersions, profile.minecraftVersion]);
  // Until one is picked, the newest release other than the current one: the common case.
  const minecraftVersion = pickedVersion
    || choices.find((version) => version.version !== profile.minecraftVersion)?.version
    || (choices.length ? profile.minecraftVersion : "");
  const { versions: runtimeVersions, loading: runtimeLoading } = useRuntimeVersions(profile.runtimeType, minecraftVersion || profile.minecraftVersion, profile.runtimeType === "fabric");

  const request: VersionSwitchRequestBody = { minecraftVersion, runtimeVersion: runtimeVersion || undefined };
  const unchanged = minecraftVersion === profile.minecraftVersion && (!runtimeVersion || runtimeVersion === profile.runtimeVersion);
  const downgrade = plan?.direction === "downgrade";
  const busy = planning || step === "applying";

  async function review() {
    setPlanning(true);
    setError("");
    try {
      const next = simulation
        ? await simulation.plan(request)
        : await api<VersionSwitchPlan>(`/api/servers/${encodeURIComponent(server.id)}/version-switch/plan`, {
          method: "POST",
          body: JSON.stringify(request),
          timeoutMs: 300_000
        });
      setPlan(next);
      setBackupConfirmed(false);
      setStep("review");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not check this version");
    } finally {
      setPlanning(false);
    }
  }

  async function apply() {
    if (!plan) return;
    setStep("applying");
    setError("");
    // The reviewed target, with the runtime version it resolved to, not the form's "latest".
    const reviewed: VersionSwitchRequestBody = { minecraftVersion: plan.target.minecraftVersion, runtimeVersion: plan.target.runtimeVersion };
    try {
      const applied = simulation
        ? await simulation.apply(reviewed)
        : await api<VersionSwitchResult & { server: ManagedServer }>(`/api/servers/${encodeURIComponent(server.id)}/version-switch`, {
          method: "POST",
          body: JSON.stringify(reviewed),
          timeoutMs: 900_000
        });
      setResult(applied);
      setStep("done");
      await onSwitched(applied);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The version switch failed");
      setStep("review");
    }
  }

  const planGroups = plan ? versionSwitchPlanGroups(plan) : [];
  const outcomeGroups = result ? versionSwitchOutcomeGroups(result.plan, result.outcomes) : [];
  const attention = result ? result.counts.disabled + result.counts.failed : 0;
  const targetLabel = plan?.target.minecraftVersion ?? minecraftVersion;

  return (
    <DialogSurface
      backdrop="versionSwitchBackdrop"
      mobileFullscreen
      className="modalPanel versionSwitchModal"
      labelledBy={titleId}
      onClose={onClose}
      dismissible={!busy}
    >
      <header className="modalHeader">
        <div className="versionSwitchHeading">
          <h2 id={titleId}>{step === "done" ? `Switched to Minecraft ${result?.plan.target.minecraftVersion ?? targetLabel}` : "Switch Minecraft version"}</h2>
          <p>{server.displayName} · {runtime.displayName}</p>
        </div>
        <Button variant="secondary" iconOnly className="iconButton modalCloseButton" onClick={onClose} disabled={busy} aria-label="Close version switch dialog" title="Close dialog">
          <AppIcon name="x" />
        </Button>
      </header>

      <div className="modalBody versionSwitchBody" aria-busy={busy || undefined}>
        {step === "choose" && (
          <>
            <p className="versionSwitchIntro">
              Pick the version to move to. Every installed {singular} is checked against it before anything changes;
              {" "}{plural} without a matching version are disabled, never deleted.
            </p>
            <div className="versionSwitchFields">
              <FormField htmlFor={minecraftId} label="Minecraft version" descriptionPlacement="after" description={`Currently ${profile.minecraftVersion}`}>
                <select
                  id={minecraftId}
                  value={minecraftVersion}
                  disabled={minecraftLoading && !choices.length}
                  onChange={(event) => { setPickedVersion(event.target.value); setRuntimeVersion(""); }}
                >
                  {!choices.length && <option value="">{minecraftLoading ? "Loading versions…" : "No versions available"}</option>}
                  {choices.map((version) => {
                    const relation = compareMinecraftVersions(version.version, profile.minecraftVersion);
                    const suffix = version.version === profile.minecraftVersion ? " (current)" : relation < 0 ? " (older)" : "";
                    return <option key={version.version} value={version.version}>{version.version}{suffix}</option>;
                  })}
                </select>
              </FormField>
              <FormField htmlFor={runtimeId} label={runtime.versionLabel} descriptionPlacement="after" description={`Currently ${profile.runtimeVersion || "unknown"}`}>
                <select id={runtimeId} value={runtimeVersion} disabled={!minecraftVersion} onChange={(event) => setRuntimeVersion(event.target.value)}>
                  <option value="">{runtimeLoading ? "Latest stable (loading…)" : "Latest stable"}</option>
                  {runtimeVersions.map((version) => (
                    <option key={version.id} value={version.runtimeVersion}>
                      {version.runtimeVersion}{version.stable === false ? " (Development)" : ""}{version.runtimeVersion === profile.runtimeVersion && minecraftVersion === profile.minecraftVersion ? " (current)" : ""}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>
            {error && <Banner tone="error" title="Could not prepare the switch" message={error} />}
          </>
        )}

        {(step === "review" || step === "applying") && plan && (
          <>
            <div className="versionSwitchSummary">
              <VersionTransition label="Minecraft" from={plan.current.minecraftVersion} to={plan.target.minecraftVersion} />
              <VersionTransition label={runtime.versionLabel} from={plan.current.runtimeVersion} to={plan.target.runtimeVersion} />
              <VersionTransition label="Java image" from={plan.current.dockerImage} to={plan.target.dockerImage} />
            </div>
            {plan.warnings.map((warning) => (
              <Banner key={warning} tone="warning" compact title={warning} />
            ))}
            {!plan.contentSkippedReason && (
              <p className="versionSwitchCounts"><strong>{Plural}:</strong> {versionSwitchPlanSummary(plan)}</p>
            )}
            <VersionSwitchGroups groups={planGroups} label={`Planned ${plural} changes`} />
            {downgrade && (
              <label className="versionSwitchBackup" htmlFor={backupId}>
                <input id={backupId} type="checkbox" checked={backupConfirmed} disabled={busy} onChange={(event) => setBackupConfirmed(event.target.checked)} />
                <span>I have a backup of this server's world.</span>
              </label>
            )}
            {step === "applying" && (
              <p className="versionSwitchProgress" role="status"><Spinner size="sm" /> Downloading {runtime.displayName} for {plan.target.minecraftVersion} and moving {plural}…</p>
            )}
            {error && <Banner tone="error" title="The switch did not finish" message={error} />}
          </>
        )}

        {step === "done" && result && (
          <>
            {attention > 0 ? (
              <Banner
                tone="warning"
                title={`${attention} ${attention === 1 ? `${singular} needs` : `${plural} need`} attention`}
                message={`They were disabled so the server can start on ${result.plan.target.minecraftVersion}. Re-enable them from ${Plural} once a compatible version is published.`}
              />
            ) : (
              <Banner tone="success" title="Everything moved over" message={result.outcomes.length ? `All enabled ${plural} have a version for ${result.plan.target.minecraftVersion}.` : "Start the server to load the new version."} />
            )}
            <VersionSwitchGroups groups={outcomeGroups} label={`${plural} changes`} />
          </>
        )}
      </div>

      <footer className="modalFooter">
        {step === "choose" && (
          <>
            <Button variant="secondary" onClick={onClose} disabled={planning}>Cancel</Button>
            <Button variant="primary" onClick={() => void review()} disabled={planning || !minecraftVersion || unchanged} title={unchanged ? "Choose a different version" : undefined}>
              {planning ? <><Spinner size="xs" tone="current" /> Checking {plural}…</> : "Review changes"}
            </Button>
          </>
        )}
        {(step === "review" || step === "applying") && (
          <>
            <Button variant="secondary" onClick={() => { setStep("choose"); setError(""); }} disabled={busy}>Back</Button>
            <Button
              variant={downgrade ? "critical" : "primary"}
              onClick={() => void apply()}
              disabled={busy || (downgrade && !backupConfirmed)}
              title={downgrade && !backupConfirmed ? "Confirm you have a backup first" : undefined}
            >
              {step === "applying" ? <><Spinner size="xs" tone="current" /> Switching…</> : `Switch to ${targetLabel}`}
            </Button>
          </>
        )}
        {step === "done" && <Button variant="primary" onClick={onClose}>Done</Button>}
      </footer>
    </DialogSurface>
  );
}
