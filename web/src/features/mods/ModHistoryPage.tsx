import { SortHeaderButton, TablePagination, headerAriaSort } from "../../components/TableControls";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flexRender, useTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { sortableTableFeatures, type SortableTableFeatures } from "../../utils/tableFeatures";
import { SearchField } from "../../components/SearchField";
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

const pageSize = 25;
const historyDetails = (entry: ModHistoryEntry) => entry.action === "enabled" || entry.action === "disabled"
  ? `${entry.before?.enabled ? "Enabled" : "Disabled"} → ${entry.after?.enabled ? "Enabled" : "Disabled"}`
  : `${entry.before ? entry.before.version || "Unknown version" : "Not installed"} → ${entry.after ? entry.after.version || "Unknown version" : "Not installed"}`;

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
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [sorting, setSorting] = useState<SortingState>([{ id: "date", desc: true }]);
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
    const currentSource = sourceRef.current;
    // History is capped at 500 entries. Load every API page so search and sorting apply
    // to the whole retained history before the shared client-side pagination.
    const request = (async () => {
      const entries: ModHistoryEntry[] = [];
      let offset = 0;
      let total = 0;
      do {
        const result = currentSource ? await currentSource.list(offset) : await api<ModHistoryResponse>(`/api/servers/${encodeURIComponent(serverId)}/mods/history?offset=${offset}&limit=100`, { signal: controller.signal });
        if (controller.signal.aborted) return null;
        total = Math.min(result.total, 500);
        entries.push(...result.entries);
        if (!result.entries.length) break;
        offset += result.entries.length;
      } while (offset < total);
      return { entries: [...new Map(entries.map((entry) => [entry.id, entry])).values()], total, offset: 0, limit: pageSize };
    })();
    void request.then((result) => { if (!controller.signal.aborted) setData(result); }).catch((failure) => {
      if (!controller.signal.aborted && !staleSessionRef.current(failure)) setLoadError(errorMessage(failure, "Could not load history."));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [serverId, revision]);
  useEffect(() => { setPage(0); setQuery(""); setSorting([{ id: "date", desc: true }]); }, [serverId]);

  const columns = useMemo<ColumnDef<SortableTableFeatures, ModHistoryEntry>[]>(() => [
    { id: "mod", accessorKey: "modName", header: terminology.singularTitle },
    { id: "action", accessorKey: "action", header: "Action" },
    { id: "details", accessorFn: historyDetails, header: "Details" },
    { id: "date", accessorKey: "occurredAt", header: "Date" },
    { id: "user", accessorFn: (entry) => entry.user.username, header: "User" }
  ], [terminology.singularTitle]);
  const tableData = useMemo(() => (data?.entries ?? []).filter((entry) =>
    [entry.modName, entry.before?.filename, entry.after?.filename, entry.action, historyDetails(entry), entry.user.username, entry.revertsEntryId ? "revert" : ""]
      .join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  ), [data, query]);
  const table = useTable({
    features: sortableTableFeatures, data: tableData, columns, getRowId: (entry) => entry.id,
    state: { sorting }, onSortingChange: (updater) => { setSorting(updater); setPage(0); }
  });
  const rows = table.getRowModel().rows;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
  const tableScroll = useRef<HTMLDivElement>(null);
  useEffect(() => { tableScroll.current?.scrollTo({ top: 0, behavior: "instant" }); }, [currentPage, query, sorting]);

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
        setPage(0);
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
        <SearchField label="Search history" value={query} onChange={(value) => { setQuery(value); setPage(0); }} />
        <div ref={tableScroll} className="modHistoryTableScroll" role="region" aria-label={`${terminology.singularTitle} history table`} tabIndex={0}>
          <table className="modHistoryTable uiDataTable" aria-label={`${terminology.singularTitle} update history`}><thead className="uiTableHeader"><tr>{table.getHeaderGroups()[0]?.headers.map((header) => <th key={header.id} scope="col" aria-sort={headerAriaSort(header)}><SortHeaderButton header={header}>{flexRender(header.column.columnDef.header, header.getContext())}</SortHeaderButton></th>)}<th scope="col">Revert</th></tr></thead>
            <tbody>{rows.length === 0 && <tr><td colSpan={6}><InlineState tone="empty" title="No matching changes" message="Try another search or clear the search field." /></td></tr>}{rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(({ original: entry }) => {
              const ActionIcon = { installed: Download, updated: RefreshCw, removed: Trash2, enabled: ToggleRight, disabled: ToggleLeft }[entry.action];
              const installed = installedMods.find((mod) => [entry.before?.filename, entry.after?.filename].includes(mod.filename));
              const stateOnly = entry.action === "enabled" || entry.action === "disabled";
              return <tr key={entry.id} className="uiTableRow">
              <td><div className="modHistoryIdentity"><ModIconImage src={modIconSource(entry.iconUrl || installed?.iconUrl)} fallback="JAR" /><div><strong>{entry.modName}</strong><small>{entry.after?.filename || entry.before?.filename}</small></div></div></td>
              <td data-label="Action"><div><span className="modHistoryAction"><ActionIcon className="buttonIcon" aria-hidden="true" />{entry.action}</span>{entry.revertsEntryId && <small className="modHistoryRevert"><Undo2 className="buttonIcon" aria-hidden="true" />Revert</small>}</div></td>
              <td data-label="Details"><div>{stateOnly ? <span>{entry.before?.enabled ? "Enabled" : "Disabled"}<span className="modHistoryArrow" aria-label="to"> → </span>{entry.after?.enabled ? "Enabled" : "Disabled"}</span> : <><span>{entry.before ? entry.before.version || "Unknown version" : "Not installed"}</span><span className="modHistoryArrow" aria-label="to"> → </span><span>{entry.after ? entry.after.version || "Unknown version" : "Not installed"}</span>{(entry.before?.enabled === false || entry.after?.enabled === false) && <small>{entry.before ? entry.before.enabled ? "Enabled" : "Disabled" : "Absent"} → {entry.after ? entry.after.enabled ? "Enabled" : "Disabled" : "Absent"}</small>}</>}</div></td>
              <td data-label="Date"><time dateTime={entry.occurredAt}>{formatDate(entry.occurredAt)}</time></td>
              <td data-label="User"><span>{entry.user.username}</span></td>
              <td><Button variant="secondary" compact disabled={locked || busy || !entry.canRevert} title={entry.revertBlockedReason || (locked ? "Mod changes are currently locked." : "Restore the state before this action")} onClick={() => void revert(entry)}>{entry.revertedAt ? "Reverted" : "Revert"}</Button>{!entry.canRevert && !entry.revertedAt && <small>{entry.revertBlockedReason}</small>}</td>
            </tr>; })}</tbody>
          </table>
        </div>
        <TablePagination className="modHistoryPagination" pageIndex={currentPage} pageSize={pageSize} totalItems={rows.length} itemLabel="changes" disabled={busy} onPageChange={setPage} />
      </>}
    </Surface>
  </section>;
}
