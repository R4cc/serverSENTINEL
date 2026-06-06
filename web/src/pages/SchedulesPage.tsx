import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { ScheduledExecution, ScheduledRun } from '../types';
import { AppIcon } from '../components/FileTypeIcon';
import { InlineState } from '../components/InlineState';
import { clientId } from '../utils/files';
import { validateCommandList, validateCronExpression } from '../utils/validation';

type ScheduleFormMode =
  | { type: "create" }
  | { type: "edit"; schedule: ScheduledExecution };

type SchedulePatch = Pick<ScheduledExecution, "name" | "cron" | "commands" | "onlyWhenNoPlayers" | "enabled">;

export function SchedulePage({
  schedules,
  onCreate,
  onToggle,
  onUpdate,
  onDelete,
  disabled,
  disabledReason,
  commandInputMessage
}: {
  schedules: ScheduledExecution[];
  onCreate: (event: FormEvent<HTMLFormElement>) => boolean | void | Promise<boolean | void>;
  onToggle: (schedule: ScheduledExecution) => void;
  onUpdate: (schedule: ScheduledExecution, patch: Partial<ScheduledExecution>) => boolean | Promise<boolean>;
  onDelete: (schedule: ScheduledExecution) => void;
  disabled: boolean;
  disabledReason?: string;
  commandInputMessage: string;
}) {
  const [formMode, setFormMode] = useState<ScheduleFormMode | null>(null);
  const [commandIds, setCommandIds] = useState<string[]>(() => [clientId()]);
  const [formError, setFormError] = useState("");
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

  const recentRuns = useMemo(() => scheduleRuns(schedules), [schedules]);
  const recentRunsKey = recentRuns.map((run) => run.id).join("|");

  useEffect(() => {
    runsFeedRef.current?.scrollTo({ top: 0 });
  }, [schedules, recentRunsKey]);

  function schedulePatchFromForm(form: FormData): SchedulePatch {
    return {
      name: String(form.get("name") ?? "").trim(),
      cron: String(form.get("cron") ?? "").trim(),
      commands: form.getAll("commands").map(String).map((command) => command.trim()).filter(Boolean),
      onlyWhenNoPlayers: form.get("onlyWhenNoPlayers") === "on",
      enabled: form.get("enabled") === "on"
    };
  }

  function validatePatch(patch: SchedulePatch) {
    return !patch.name
      ? "Schedule name is required."
      : validateCronExpression(patch.cron) || validateCommandList(patch.commands) || "";
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
        <div className="scheduleCardHeader">
          <div>
            <h2>Schedules</h2>
            <p>Manage automated console commands for this server.</p>
          </div>
          <button
            type="button"
            className="scheduleAddButton"
            onClick={() => setFormMode({ type: "create" })}
            disabled={disabled}
            title={disabled ? disabledReason || "Schedule creation is unavailable right now." : "Add schedule"}
          >
            <AppIcon name="plus" />
            <span>Add schedule</span>
          </button>
        </div>

        {commandInputMessage && (
          <InlineState tone="warning" title="Scheduling is limited" message={commandInputMessage} />
        )}
        {disabled && disabledReason && (
          <InlineState tone="warning" title="Schedules are unavailable" message={disabledReason} />
        )}

        <div className="scheduleTableFrame">
          <div className="scheduleTableHeader" role="row">
            <span>Name</span>
            <span>Schedule</span>
            <span>Last run</span>
            <span>Next run</span>
            <span>Enabled</span>
            <span>Actions</span>
          </div>
          <div className="scheduleTableBody">
            {schedules.length ? schedules.map((schedule) => (
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
                      <span>{formatScheduleTime(schedule.lastRunAt)}</span>
                      <small className={`scheduleStatusText ${statusTone(schedule.lastStatus)}`}>{statusLabel(schedule.lastStatus)}</small>
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
                      <span>{formatScheduleTime(schedule.nextRunAt)}</span>
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
                  <button type="button" className="secondaryButton" onClick={() => setFormMode({ type: "edit", schedule })} disabled={disabled}>Edit</button>
                  <button type="button" className="dangerButton" onClick={() => onDelete(schedule)} disabled={disabled}>Delete</button>
                </div>
              </article>
            )) : (
              <div className="scheduleNoRows">
                <strong>No schedules added</strong>
                <span>Use Add schedule to create an automated console command.</span>
              </div>
            )}
          </div>
        </div>

        <div className="scheduleTableFooter">
          <span>Showing {schedules.length} of {schedules.length} schedules</span>
        </div>
      </section>

      <aside className="panel scheduledRunsCard">
        <div className="scheduleCardHeader compact">
          <div>
            <h2>Scheduled Runs</h2>
            <p>Most recent scheduled executions.</p>
          </div>
        </div>
        {recentRuns.length ? (
          <div ref={runsFeedRef} className="scheduledRunsFeed">
            {recentRuns.map((run) => (
              <article key={run.id} className={`scheduledRunItem ${statusTone(run.status)}`}>
                <span className="scheduledRunMarker" aria-hidden="true"></span>
                <div>
                  <strong>{run.scheduleName}</strong>
                  <small>{statusLabel(run.status)}</small>
                </div>
                <div className="scheduledRunTime">
                  <span>{relativeTime(run.ranAt)}</span>
                  <small>{formatScheduleTime(run.ranAt)}</small>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="emptyState compactEmpty scheduledRunsEmpty">
            <h2>No runs yet</h2>
            <p>Recent scheduled executions will appear here after schedules run.</p>
          </div>
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
                <button type="button" className="iconButton modalCloseButton" onClick={() => setFormMode(null)} disabled={saveRunning} aria-label="Close schedule editor" title={modalBusyTitle}>
                  <AppIcon name="x" />
                </button>
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
                        {index > 0 && (
                          <button type="button" className="iconDangerButton" onClick={() => setCommandIds((ids) => ids.filter((candidate) => candidate !== id))} aria-label="Remove command">
                            <AppIcon name="x" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <button type="button" className="secondaryButton scheduleCommandAdd" onClick={() => setCommandIds((ids) => [...ids, clientId()])}>
                    <AppIcon name="plus" />
                    <span>Additional command</span>
                  </button>
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
                <button type="button" className="secondaryButton" onClick={() => setFormMode(null)} disabled={saveRunning} title={saveRunning ? disabledReason || "Schedule save is still running." : "Cancel"}>Cancel</button>
                <button disabled={disabled} title={disabled ? disabledReason || "Schedule save is still running." : modalTitle}>{saveRunning ? "Saving..." : formMode.type === "edit" ? "Save changes" : "Create schedule"}</button>
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

function scheduleDescription(schedule: ScheduledExecution) {
  if (schedule.commands.length > 1) return `${schedule.commands.length} console commands`;
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
  return "Not run";
}

function statusTone(status?: string) {
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "success" || normalized === "succeeded") return "success";
  if (normalized === "failed") return "failed";
  if (normalized === "skipped") return "skipped";
  return "unknown";
}

function formatScheduleTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return `Today, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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
