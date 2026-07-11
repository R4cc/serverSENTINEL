import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState
} from '@tanstack/react-table';
import type { ScheduledActiveRun, ScheduledExecution, ScheduledRun } from '../types';
import { AppIcon } from '../components/FileTypeIcon';
import { InlineState } from '../components/InlineState';
import { SortHeaderButton } from '../components/TableControls';
import { Button, EmptyState, PanelHeader } from '../components/UiPrimitives';
import { clientId } from '../utils/files';
import { validateCommandList, validateCronExpression } from '../utils/validation';
import { scheduleDelayParts, scheduleDelayToSeconds } from '../features/schedules/scheduleDelays';

type ScheduleFormMode =
  | { type: "create" }
  | { type: "edit"; schedule: ScheduledExecution };

type SchedulePatch = Pick<ScheduledExecution, "name" | "cron" | "commands" | "commandDelaysSeconds" | "onlyWhenNoPlayers" | "enabled">;
type ScheduledRunPanelItem =
  | (ScheduledActiveRun & { kind: "active"; sortAt: string })
  | (ScheduledRun & { kind: "completed"; sortAt: string });

export function SchedulePage({
  schedules,
  onCreate,
  onToggle,
  onUpdate,
  onDelete,
  onCancelRun,
  disabled,
  disabledReason,
  formatDate
}: {
  schedules: ScheduledExecution[];
  formatDate: (value: string | number | Date) => string;
  onCreate: (event: FormEvent<HTMLFormElement>) => boolean | void | Promise<boolean | void>;
  onToggle: (schedule: ScheduledExecution) => void;
  onUpdate: (schedule: ScheduledExecution, patch: Partial<ScheduledExecution>) => boolean | Promise<boolean>;
  onDelete: (schedule: ScheduledExecution) => void;
  onCancelRun: (run: ScheduledActiveRun) => boolean | Promise<boolean>;
  disabled: boolean;
  disabledReason?: string;
}) {
  const [formMode, setFormMode] = useState<ScheduleFormMode | null>(null);
  const [commandIds, setCommandIds] = useState<string[]>(() => [clientId()]);
  const [formError, setFormError] = useState("");
  const [scheduleSorting, setScheduleSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  const saveRunning = disabled && disabledReason?.toLowerCase().includes("saving");
  const runsFeedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!formMode) {
      setCommandIds([clientId()]);
      setFormError("");
      return;
    }
    const commands = formMode.type === "edit" ? formMode.schedule.commands : [];
    setCommandIds(commands.length ? commands.map(() => clientId()) : [clientId()]);
    setFormError("");
  }, [formMode]);

  const runItems = useMemo(() => scheduleRunItems(schedules), [schedules]);
  const activeRunCount = runItems.filter((run) => run.kind === "active").length;
  const recentRunsKey = runItems.map((run) => `${run.kind}:${run.id}:${run.kind === "active" ? run.waitingUntil ?? run.message ?? "" : run.ranAt}`).join("|");
  const scheduleColumns = useMemo<ColumnDef<ScheduledExecution>[]>(() => [
    {
      id: "name",
      accessorKey: "name"
    },
    {
      id: "cron",
      accessorKey: "cron"
    },
    {
      id: "lastRunAt",
      accessorFn: (schedule) => schedule.lastRunAt ? new Date(schedule.lastRunAt).getTime() : 0
    },
    {
      id: "nextRunAt",
      accessorFn: (schedule) => schedule.nextRunAt ? new Date(schedule.nextRunAt).getTime() : 0
    },
    {
      id: "enabled",
      accessorFn: (schedule) => schedule.enabled ? 1 : 0
    },
    {
      id: "actions",
      enableSorting: false
    }
  ], []);
  const scheduleTable = useReactTable({
    data: schedules,
    columns: scheduleColumns,
    getRowId: (schedule) => schedule.id,
    state: {
      sorting: scheduleSorting
    },
    onSortingChange: setScheduleSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });
  const scheduleRows = scheduleTable.getRowModel().rows;

  useEffect(() => {
    runsFeedRef.current?.scrollTo({ top: 0 });
  }, [schedules, recentRunsKey]);

  function schedulePatchFromForm(form: FormData): SchedulePatch {
    const delayValues = form.getAll("commandDelayValues").map(Number);
    const delayUnits = form.getAll("commandDelayUnits").map(String);
    const commandRows = form.getAll("commands").map(String).map((command, index) => ({
      command: command.trim(),
      delaySeconds: scheduleDelayToSeconds(delayValues[index] ?? 0, delayUnits[index] ?? "seconds")
    })).filter((row) => Boolean(row.command));
    return {
      name: String(form.get("name") ?? "").trim(),
      cron: String(form.get("cron") ?? "").trim(),
      commands: commandRows.map((row) => row.command),
      commandDelaysSeconds: commandRows.map((row) => row.delaySeconds),
      onlyWhenNoPlayers: form.get("onlyWhenNoPlayers") === "on",
      enabled: form.get("enabled") === "on"
    };
  }

  function validatePatch(patch: SchedulePatch) {
    return !patch.name
      ? "Schedule name is required."
      : validateCronExpression(patch.cron)
        || validateCommandList(patch.commands)
        || (patch.commandDelaysSeconds.some((delay) => !Number.isInteger(delay) || delay < 0 || delay > 604_800)
          ? "Command delays must be whole values no longer than 7 days."
          : "");
  }

  async function submitSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!formMode || disabled) return;
    const patch = schedulePatchFromForm(new FormData(event.currentTarget));
    const message = validatePatch(patch);
    if (message) {
      setFormError(message);
      return;
    }
    setFormError("");
    if (formMode.type === "create") {
      const created = await onCreate(event);
      if (created !== false) setFormMode(null);
      return;
    }
    const saved = await onUpdate(formMode.schedule, patch);
    if (saved) setFormMode(null);
  }

  const modalSchedule = formMode?.type === "edit" ? formMode.schedule : null;
  const modalTitle = formMode?.type === "edit" ? "Edit schedule" : "Add schedule";
  const modalBusyTitle = saveRunning ? disabledReason || "Schedule save is still running." : "Close schedule editor";

  return (
    <section className="tabPage schedulePage scheduleManagementPage">
      <section className="panel scheduleTableCard">
        <PanelHeader
          className="scheduleCardHeader"
          title="Schedules"
          description="Manage automated console commands for this server."
          actions={<Button
            className="scheduleAddButton"
            onClick={() => setFormMode({ type: "create" })}
            disabled={disabled}
            title={disabled ? disabledReason || "Schedule creation is unavailable right now." : "Add schedule"}
          >
            <AppIcon name="plus" />
            <span>Add schedule</span>
          </Button>}
        />

        {disabled && disabledReason && !saveRunning && (
          <InlineState tone="warning" title="Schedules are unavailable" message={disabledReason} />
        )}

        <div className="scheduleTableFrame">
          <div className="scheduleTableHeader" role="row">
            {scheduleTable.getHeaderGroups()[0]?.headers.map((header) => (
              <span key={header.id}>
                {header.id === "actions" ? (
                  "Actions"
                ) : (
                  <SortHeaderButton header={header}>
                    {header.id === "name"
                      ? "Name"
                      : header.id === "cron"
                        ? "Schedule"
                        : header.id === "lastRunAt"
                          ? "Last run"
                          : header.id === "nextRunAt"
                            ? "Next run"
                            : "Enabled"}
                  </SortHeaderButton>
                )}
              </span>
            ))}
          </div>
          <div className="scheduleTableBody">
            {scheduleRows.length ? scheduleRows.map((row) => {
              const schedule = row.original;
              return (
              <article key={schedule.id} className={`scheduleTableRow ${schedule.enabled ? "enabled" : "disabled"}`}>
                <div className="scheduleNameCell" data-label="Name">
                  <div>
                    <strong>{schedule.name}</strong>
                    <small>{scheduleDescription(schedule)}</small>
                  </div>
                </div>
                <div className="scheduleCell" data-label="Schedule">
                  <code>{schedule.cron}</code>
                  <small>{cronSummary(schedule.cron)}</small>
                </div>
                <div className="scheduleCell" data-label="Last run">
                  {schedule.lastRunAt ? (
                    <>
                      <span>{formatScheduleTime(schedule.lastRunAt, formatDate)}</span>
                      <span
                        className={`scheduleStatusIcon ${statusTone(schedule.lastStatus) === "success" ? "success" : "failed"}`}
                        role="img"
                        aria-label={statusLabel(schedule.lastStatus)}
                        title={statusLabel(schedule.lastStatus)}
                      >
                        <AppIcon name={statusTone(schedule.lastStatus) === "success" ? "check" : "x"} />
                      </span>
                    </>
                  ) : (
                    <>
                      <span>Never run</span>
                      <small>No execution yet</small>
                    </>
                  )}
                </div>
                <div className="scheduleCell" data-label="Next run">
                  {schedule.enabled && schedule.nextRunAt ? (
                    <>
                      <span>{formatScheduleTime(schedule.nextRunAt, formatDate)}</span>
                      <small>{relativeTime(schedule.nextRunAt)}</small>
                    </>
                  ) : (
                    <>
                      <span>{schedule.enabled ? "Not available" : "Disabled"}</span>
                      <small>{schedule.enabled ? "Waiting for a valid cron match" : "Enable to resume"}</small>
                    </>
                  )}
                </div>
                <div className="scheduleEnabledCell" data-label="Enabled">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={schedule.enabled}
                      onChange={() => onToggle(schedule)}
                      disabled={disabled}
                    />
                    <span className="slider"></span>
                    <span className={`switchStateLabel ${schedule.enabled ? "enabled" : ""}`}>
                      {schedule.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </label>
                </div>
                <div className="scheduleRowActions" data-label="Actions">
                  <Button variant="secondary" compact onClick={() => setFormMode({ type: "edit", schedule })} disabled={disabled}>Edit</Button>
                  <Button variant="critical" compact onClick={() => onDelete(schedule)} disabled={disabled}>Delete</Button>
                </div>
              </article>
              );
            }) : (
              <EmptyState compact className="scheduleNoRows" title="No schedules added" message="Use Add schedule to create an automated console command." />
            )}
          </div>
        </div>

        <div className="scheduleTableFooter">
          <span>Showing {schedules.length} of {schedules.length} schedules</span>
        </div>
      </section>

      <aside className="panel scheduledRunsCard">
        <PanelHeader className="scheduleCardHeader compact" title="Scheduled Runs" description={activeRunCount ? `${activeRunCount} active execution${activeRunCount === 1 ? "" : "s"} plus recent history.` : "Most recent scheduled executions."} />
        {runItems.length ? (
          <div ref={runsFeedRef} className="scheduledRunsFeed">
            {runItems.map((run) => (
              <article key={`${run.kind}:${run.id}`} className={`scheduledRunItem ${statusTone(run.status)} ${run.kind === "active" ? "active" : ""}`}>
                <span className="scheduledRunMarker" aria-hidden="true"></span>
                <div className="scheduledRunDetails">
                  <strong>{run.scheduleName}</strong>
                  <small>{run.kind === "active" ? activeRunStatus(run) : statusLabel(run.status)}</small>
                  {run.kind === "active" && run.currentAction && (
                    <small className="scheduledRunAction">Action {(run.currentActionIndex ?? 0) + 1} of {run.actionCount}: {run.currentAction}</small>
                  )}
                </div>
                <div className="scheduledRunTime">
                  <span>{run.kind === "active" ? relativeTime(run.startedAt) : relativeTime(run.ranAt)}</span>
                  <small>{run.kind === "active" ? `Started ${formatScheduleTime(run.startedAt, formatDate)}` : formatScheduleTime(run.ranAt, formatDate)}</small>
                </div>
                {run.kind === "active" && (
                  <div className="scheduledRunActions">
                    <Button variant="critical" iconOnly compact className="scheduledRunCancelButton" onClick={() => void onCancelRun(run)} disabled={disabled} aria-label={`Cancel ${run.scheduleName}`} title={disabled ? disabledReason || "Schedule cancellation is unavailable right now." : `Cancel ${run.scheduleName}`}>
                      <AppIcon name="x" />
                    </Button>
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <EmptyState compact className="scheduledRunsEmpty" title="No runs yet" message="Recent scheduled executions will appear here after schedules run." />
        )}
      </aside>

      {formMode && (
        <div className="modalBackdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !saveRunning) setFormMode(null);
        }}>
          <section className="modalPanel userModalPanel scheduleModalPanel" role="dialog" aria-modal="true" aria-labelledby="schedule-modal-title">
            <form className="userModalForm scheduleModalForm" onSubmit={submitSchedule}>
              <div className="userModalHeader">
                <h2 id="schedule-modal-title">{modalTitle}</h2>
                <Button variant="secondary" iconOnly className="iconButton modalCloseButton" onClick={() => setFormMode(null)} disabled={saveRunning} aria-label="Close schedule editor" title={modalBusyTitle}>
                  <AppIcon name="x" />
                </Button>
              </div>
              <fieldset disabled={disabled} className="userModalBody scheduleEditBody">
                {formError && <InlineState tone="error" title="Check schedule details" message={formError} />}
                <div className="userModalFields scheduleEditFields">
                  <label>
                    Name
                    <input name="name" defaultValue={modalSchedule?.name ?? ""} placeholder="Nightly maintenance" required maxLength={80} />
                  </label>
                  <label>
                    Cron schedule
                    <input name="cron" defaultValue={modalSchedule?.cron ?? ""} placeholder="0 4 * * *" required pattern="^\S+\s+\S+\s+\S+\s+\S+\s+\S+$" title="Use five cron fields: minute hour day month weekday." />
                  </label>
                </div>
                <div className="commandStack scheduleCommandStack">
                  <span className="fieldLabel">Commands</span>
                  <div className="scheduleCommandList">
                    {commandIds.map((id, index) => (
                      <div key={id} className="commandInputRow">
                        <input name="commands" defaultValue={modalSchedule?.commands[index] ?? ""} placeholder={index === 0 ? "say Restarting in 5 minutes" : "save-all"} required={index === 0} title="Use one console command per line." />
                        {index === 0 ? (
                          <>
                            <input name="commandDelayValues" type="hidden" value="0" />
                            <input name="commandDelayUnits" type="hidden" value="seconds" />
                          </>
                        ) : (
                          <label className="scheduleCommandDelay">
                            <span>Delay</span>
                            <input
                              name="commandDelayValues"
                              type="number"
                              min="0"
                              max="604800"
                              step="1"
                              defaultValue={scheduleDelayParts(modalSchedule?.commandDelaysSeconds[index] ?? 0).value}
                              required
                              aria-label={`Delay before command ${index + 1}`}
                            />
                            <select
                              name="commandDelayUnits"
                              defaultValue={scheduleDelayParts(modalSchedule?.commandDelaysSeconds[index] ?? 0).unit}
                              aria-label={`Delay unit before command ${index + 1}`}
                            >
                              <option value="seconds">Seconds</option>
                              <option value="minutes">Minutes</option>
                              <option value="hours">Hours</option>
                            </select>
                          </label>
                        )}
                        {index > 0 && (
                          <Button variant="ghost" iconOnly className="iconDangerButton" onClick={() => setCommandIds((ids) => ids.filter((candidate) => candidate !== id))} aria-label="Remove command">
                            <AppIcon name="x" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                  <Button variant="secondary" compact className="scheduleCommandAdd" onClick={() => setCommandIds((ids) => [...ids, clientId()])}>
                    <AppIcon name="plus" />
                    <span>Additional command</span>
                  </Button>
                </div>
                <div className="scheduleEditOptions">
                  <label className="scheduleOptionToggle">
                    <input name="onlyWhenNoPlayers" type="checkbox" defaultChecked={modalSchedule?.onlyWhenNoPlayers ?? false} />
                    <span>Only run when no players are online</span>
                  </label>
                  <label className="scheduleOptionToggle">
                    <input name="enabled" type="checkbox" defaultChecked={modalSchedule?.enabled ?? true} />
                    <span>Enabled</span>
                  </label>
                </div>
              </fieldset>
              <div className="userModalFooter">
                <Button variant="secondary" onClick={() => setFormMode(null)} disabled={saveRunning} title={saveRunning ? disabledReason || "Schedule save is still running." : "Cancel"}>Cancel</Button>
                <Button type="submit" disabled={disabled} title={disabled ? disabledReason || "Schedule save is still running." : modalTitle} reserveLabel={formMode.type === "edit" ? "Save changes" : "Create schedule"}>{saveRunning ? "Saving..." : formMode.type === "edit" ? "Save changes" : "Create schedule"}</Button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}

function scheduleRuns(schedules: ScheduledExecution[]) {
  return schedules
    .flatMap((schedule) => {
      if (schedule.recentRuns?.length) return schedule.recentRuns;
      if (!schedule.lastRunAt) return [];
      return [{
        id: `${schedule.id}:${schedule.lastRunAt}`,
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        status: schedule.lastStatus ?? "unknown",
        message: schedule.lastMessage,
        ranAt: schedule.lastRunAt
      } satisfies ScheduledRun];
    })
    .sort((a, b) => new Date(b.ranAt).getTime() - new Date(a.ranAt).getTime())
    .slice(0, 8);
}

function scheduleRunItems(schedules: ScheduledExecution[]): ScheduledRunPanelItem[] {
  const active = schedules.flatMap((schedule) => schedule.activeRuns ?? [])
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .map((run) => ({ ...run, kind: "active" as const, sortAt: run.startedAt }));
  const activeIds = new Set(active.map((run) => run.id));
  const completed = scheduleRuns(schedules)
    .filter((run) => !activeIds.has(run.id))
    .map((run) => ({ ...run, kind: "completed" as const, sortAt: run.ranAt }));
  return [...active, ...completed.slice(0, Math.max(8 - active.length, 0))];
}

function scheduleDescription(schedule: ScheduledExecution) {
  if (schedule.commands.length > 1) {
    const delayedCommands = schedule.commandDelaysSeconds.filter((delay) => delay > 0).length;
    return `${schedule.commands.length} console commands${delayedCommands ? `, ${delayedCommands} delayed` : ""}`;
  }
  if (schedule.commands[0]) return schedule.commands[0];
  return schedule.onlyWhenNoPlayers ? "Runs only with no players online" : "Console command automation";
}

function cronSummary(cron: string) {
  const [minute, hour, day, month, weekday] = cron.trim().split(/\s+/);
  if (minute?.startsWith("*/") && hour === "*" && day === "*" && month === "*" && weekday === "*") return `Every ${minute.slice(2)} minutes`;
  if (minute === "0" && hour?.startsWith("*/") && day === "*" && month === "*" && weekday === "*") return `Every ${hour.slice(2)} hours`;
  if (day === "*" && month === "*" && weekday === "*") return `Daily at ${padTime(hour)}:${padTime(minute)}`;
  if (day === "*" && month === "*" && weekday !== "*") return `Weekly on ${weekday} at ${padTime(hour)}:${padTime(minute)}`;
  return "Custom schedule";
}

function padTime(value?: string) {
  return /^\d+$/.test(value ?? "") ? String(value).padStart(2, "0") : value ?? "*";
}

function statusLabel(status?: string) {
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "success" || normalized === "succeeded") return "Succeeded";
  if (normalized === "failed") return "Failed";
  if (normalized === "skipped") return "Skipped";
  if (normalized === "cancelled") return "Cancelled";
  if (normalized === "running") return "In progress";
  return "Not run";
}

function statusTone(status?: string) {
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "success" || normalized === "succeeded") return "success";
  if (normalized === "failed") return "failed";
  if (normalized === "skipped") return "skipped";
  if (normalized === "cancelled") return "cancelled";
  if (normalized === "running") return "running";
  return "unknown";
}

function activeRunStatus(run: ScheduledActiveRun) {
  if (run.message === "Cancellation requested") return run.message;
  if (run.waitingUntil) return `Waiting ${remainingDelayLabel(run.waitingUntil)}`;
  if (run.currentActionIndex !== undefined) return `Action ${run.currentActionIndex + 1} of ${run.actionCount}`;
  return run.message || "In progress";
}

function formatScheduleTime(value: string, formatDate: (value: string | number | Date) => string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return formatDate(date);
}

function relativeTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const minutes = Math.max(1, Math.round(absMs / 60_000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const label = days > 0
    ? `${days}d`
    : hours > 0
    ? `${hours}h ${minutes % 60}m`
    : `${minutes}m`;
  return diffMs >= 0 ? `in ${label}` : `${label} ago`;
}

function remainingDelayLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "on delay";
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return "less than 1s";
  if (diffMs < 60_000) return `${Math.max(1, Math.ceil(diffMs / 1000))}s`;
  const minutes = Math.max(1, Math.ceil(diffMs / 60_000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}
