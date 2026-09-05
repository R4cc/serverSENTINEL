import { useCallback, useEffect, useRef, useState } from "react";
import type { ModHistoryEntry, ModHistoryResponse } from "@serversentinel/contracts";
import { api } from "../../api";
import { Button, HelpTooltip, PanelHeader, Surface, Toolbar } from "../../components/UiPrimitives";
import { InlineState } from "../../components/InlineState";
import type { RequestConfirmation } from "../../components/ConfirmationModal";
import type { ManagedContentTerminology } from "./contentTerminology";
import { Download, RefreshCw, Trash2, ToggleLeft, ToggleRight, Undo2 } from "lucide-react";
import { ModIconImage } from "./ModIconImage";
import type { InstalledMod } from "../../types";
import { errorMessage, modIconSource } from "../../utils/appHelpers";

export type ModHistorySource = {
  list(offset: number): Promise<ModHistoryResponse>;
  revert(id: string): Promise<unknown>;
};

export function ModHistoryPage({ serverId, terminology, installedMods = [], locked, requestConfirmation, onBack, onChanged, formatDate, handleStaleSession, source }: {
  serverId: string;
  installedMods?: InstalledMod[];
  terminology: ManagedContentTerminology;
  locked: boolean;
  requestConfirmation: RequestConfirmation;
  onBack(): void;
  onChanged(): Promise<unknown>;
  formatDate(value: string | number | Date): string;
  handleStaleSession(error: unknown): boolean;
  source?: ModHistorySource;
}) {
  const [data, setData] = useState<ModHistoryResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const staleSessionRef = useRef(handleStaleSession);
  staleSessionRef.current = handleStaleSession;
  useEffect(() => { alive.current = true; heading.current?.focus(); return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    const request = sourceRef.current ? sourceRef.current.list(offset) : api<ModHistoryResponse>(`/api/servers/${encodeURIComponent(serverId)}/mods/history?offset=${offset}`, { signal: controller.signal });
    void request.then((result) => { if (!controller.signal.aborted) setData(result); }).catch((failure) => {
      if (!controller.signal.aborted && !staleSessionRef.current(failure)) setLoadError(errorMessage(failure, "Could not load history."));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [serverId, offset, revision]);

  const revert = useCallback(async (entry: ModHistoryEntry) => {
    if (inFlight.current || locked || !entry.canRevert) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const destination = entry.before ? `${entry.before.version || entry.before.filename}${entry.before.enabled ? "" : " (disabled)"}` : "not installed";
      const confirmed = await requestConfirmation({
        title: `Revert ${entry.modName}?`,
        description: `Undo the action by ${entry.user.username} on ${formatDate(entry.occurredAt)}. ${entry.modName} will be ${entry.before ? `restored to ${destination}` : "removed"}.`,
        warning: "Only this entry is reverted. Other mods and configuration files stay as they are. Check dependencies afterwards; a running server may need a restart.",
        confirmLabel: "Revert action", variant: entry.before ? "primary" : "critical"
      });
      if (!confirmed || !alive.current) return;
      setError("");
      setNotice("");
      if (sourceRef.current) await sourceRef.current.revert(entry.id);
      else await api(`/api/servers/${encodeURIComponent(serverId)}/mods/history/${encodeURIComponent(entry.id)}/revert`, { method: "POST" });
      if (alive.current) {
        setNotice(`${entry.modName}: action reverted.`);
        setOffset(0);
        setRevision((value) => value + 1);
      }
      await onChanged();
    } catch (failure) {
      if (alive.current && !handleStaleSession(failure)) {
        setError(errorMessage(failure, "Could not revert this action."));
        setRevision((value) => value + 1);
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }, [serverId, locked, requestConfirmation, formatDate, onChanged, handleStaleSession]);

  return <section className="tabPage modHistoryPage layoutWide">
    <Toolbar primary={<Button variant="secondary" onClick={onBack} disabled={busy}>Back to {terminology.plural}</Button>}
      secondary={<Button variant="secondary" disabled={loading || busy} onClick={() => { setError(""); setRevision((value) => value + 1); }}>Refresh history</Button>} />
    <div className="modHistoryHeading"><h2 ref={heading} tabIndex={-1}>{terminology.singularTitle} update history</h2></div>
    {(error || loadError) && <InlineState tone="error" title="History action failed" message={error || loadError} actionLabel="Retry" onAction={() => { setError(""); setRevision((value) => value + 1); }} busy={loading || busy} />}
    {notice && <InlineState title={notice} />}
    <Surface className="modHistorySurface">
      <PanelHeader title="Recent changes" help={<HelpTooltip label="recent changes">Installs, updates, removals and state changes. The latest 500 changes are retained with their saved jars. Revert restores the saved file, version and enabled state. Changes made before history was introduced are not included.</HelpTooltip>} />
      {loading ? <InlineState tone="loading" title="Loading history…" /> : !data?.entries.length ? <InlineState tone="empty" title="No changes recorded" message={`New ${terminology.singular} changes will appear here.`} /> : <>
        <div className="modHistoryTableScroll" role="region" aria-label={`${terminology.singularTitle} history table`} tabIndex={0}>
          <table className="modHistoryTable"><thead><tr><th scope="col">{terminology.singularTitle}</th><th scope="col">Action</th><th scope="col">Details</th><th scope="col">Date</th><th scope="col">User</th><th scope="col">Revert</th></tr></thead>
            <tbody>{data.entries.map((entry) => {
              const ActionIcon = { installed: Download, updated: RefreshCw, removed: Trash2, enabled: ToggleRight, disabled: ToggleLeft }[entry.action];
              const installed = installedMods.find((mod) => [entry.before?.filename, entry.after?.filename].includes(mod.filename));
              const stateOnly = entry.action === "enabled" || entry.action === "disabled";
              return <tr key={entry.id}>
              <td><div className="modHistoryIdentity"><ModIconImage src={modIconSource(entry.iconUrl || installed?.iconUrl)} fallback="JAR" /><div><strong>{entry.modName}</strong><small>{entry.after?.filename || entry.before?.filename}</small></div></div></td>
              <td data-label="Action"><div><span className="modHistoryAction"><ActionIcon className="buttonIcon" aria-hidden="true" />{entry.action}</span>{entry.revertsEntryId && <small className="modHistoryRevert"><Undo2 className="buttonIcon" aria-hidden="true" />Revert</small>}</div></td>
              <td data-label="Details"><div>{stateOnly ? <span>{entry.before?.enabled ? "Enabled" : "Disabled"}<span className="modHistoryArrow" aria-label="to"> → </span>{entry.after?.enabled ? "Enabled" : "Disabled"}</span> : <><span>{entry.before ? entry.before.version || "Unknown version" : "Not installed"}</span><span className="modHistoryArrow" aria-label="to"> → </span><span>{entry.after ? entry.after.version || "Unknown version" : "Not installed"}</span>{(entry.before?.enabled === false || entry.after?.enabled === false) && <small>{entry.before ? entry.before.enabled ? "Enabled" : "Disabled" : "Absent"} → {entry.after ? entry.after.enabled ? "Enabled" : "Disabled" : "Absent"}</small>}</>}</div></td>
              <td data-label="Date"><time dateTime={entry.occurredAt}>{formatDate(entry.occurredAt)}</time></td>
              <td data-label="User"><span>{entry.user.username}</span></td>
              <td><Button variant="secondary" compact disabled={locked || busy || !entry.canRevert} title={entry.revertBlockedReason || (locked ? "Mod changes are currently locked." : "Restore the state before this action")} onClick={() => void revert(entry)}>{entry.revertedAt ? "Reverted" : "Revert"}</Button>{!entry.canRevert && !entry.revertedAt && <small>{entry.revertBlockedReason}</small>}</td>
            </tr>; })}</tbody>
          </table>
        </div>
        <div className="modHistoryPagination"><span>{data.offset + 1}–{data.offset + data.entries.length} of {data.total} changes</span><div><Button variant="secondary" compact disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - data.limit))}>Previous</Button><Button variant="secondary" compact disabled={busy || offset + data.limit >= data.total} onClick={() => setOffset(offset + data.limit)}>Next</Button></div></div>
      </>}
    </Surface>
  </section>;
}
