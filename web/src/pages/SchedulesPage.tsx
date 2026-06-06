import { FormEvent, useEffect, useState } from 'react';
import type { ScheduledExecution } from '../types';
import { AppIcon } from '../components/FileTypeIcon';
import { InlineState } from '../components/InlineState';
import { clientId } from '../utils/files';
import { validateCommandList, validateCronExpression } from '../utils/validation';

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
  onCreate: (event: FormEvent<HTMLFormElement>) => void;
  onToggle: (schedule: ScheduledExecution) => void;
  onUpdate: (schedule: ScheduledExecution, patch: Partial<ScheduledExecution>) => boolean | Promise<boolean>;
  onDelete: (schedule: ScheduledExecution) => void;
  disabled: boolean;
  disabledReason?: string;
  commandInputMessage: string;
}) {
  const [commandIds, setCommandIds] = useState(() => [clientId()]);
  const [editingSchedule, setEditingSchedule] = useState<ScheduledExecution | null>(null);
  const [editCommandIds, setEditCommandIds] = useState<string[]>([]);
  const [editError, setEditError] = useState("");
  const editSaveRunning = disabled && disabledReason?.toLowerCase().includes("saving");

  useEffect(() => {
    if (!editingSchedule) {
      setEditCommandIds([]);
      setEditError("");
      return;
    }
    setEditCommandIds(editingSchedule.commands.length ? editingSchedule.commands.map(() => clientId()) : [clientId()]);
    setEditError("");
  }, [editingSchedule]);

  function schedulePatchFromForm(form: FormData) {
    return {
      name: String(form.get("name") ?? "").trim(),
      cron: String(form.get("cron") ?? "").trim(),
      commands: form.getAll("commands").map(String).map((command) => command.trim()).filter(Boolean),
      onlyWhenNoPlayers: form.get("onlyWhenNoPlayers") === "on",
      enabled: form.get("enabled") === "on"
    };
  }

  async function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingSchedule || disabled) return;
    const patch = schedulePatchFromForm(new FormData(event.currentTarget));
    const message = !patch.name
      ? "Schedule name is required."
      : validateCronExpression(patch.cron) || validateCommandList(patch.commands) || "";
    if (message) {
      setEditError(message);
      return;
    }
    setEditError("");
    const saved = await onUpdate(editingSchedule, patch);
    if (saved) setEditingSchedule(null);
  }

  return (
    <section className="tabPage schedulePage">
      <section className="panel scheduleCreatePanel">
        <div className="panelHeader">
          <h2>New scheduled execution</h2>
          <a href="https://crontab.guru/" target="_blank" rel="noreferrer">Cron Guru</a>
        </div>
        {commandInputMessage && (
          <section className="systemBanner warning compactBanner">
            <strong>Scheduling is limited.</strong>
            <span>{commandInputMessage}</span>
          </section>
        )}
        {disabled && disabledReason && (
          <section className="systemBanner warning compactBanner">
            <strong>Schedules are unavailable.</strong>
            <span>{disabledReason}</span>
          </section>
        )}
        <form onSubmit={onCreate} className="appForm scheduleForm">
          <fieldset disabled={disabled}>
            <label>
              Name
              <input name="name" placeholder="Nightly maintenance" required maxLength={80} />
            </label>
            <label>
              Cron schedule
              <input name="cron" placeholder="0 4 * * *" required pattern="^\S+\s+\S+\s+\S+\s+\S+\s+\S+$" title="Use five cron fields: minute hour day month weekday." />
            </label>
            <div className="commandStack">
              <span className="fieldLabel">Commands</span>
              {commandIds.map((id, index) => (
                <div key={id} className="commandInputRow">
                  <input name="commands" placeholder={index === 0 ? "say Restarting in 5 minutes" : "save-all"} required={index === 0} title="Use one console command per line." />
                  {index > 0 && (
                    <button
                      type="button"
                      className="iconDangerButton"
                      onClick={() => setCommandIds((ids) => ids.filter((candidate) => candidate !== id))}
                      aria-label="Remove command"
                    >
                      <AppIcon name="x" />
                    </button>
                  )}
                </div>
              ))}
              <button type="button" className="secondaryButton" onClick={() => setCommandIds((ids) => [...ids, clientId()])}>
                <AppIcon name="plus" />
                <span>Additional command</span>
              </button>
            </div>
            <label className="checkLine">
              <input name="onlyWhenNoPlayers" type="checkbox" />
              Only run when no players are online
            </label>
            <label className="checkLine">
              <input name="enabled" type="checkbox" defaultChecked />
              Enabled
            </label>
            <button title={disabled ? disabledReason || "Scheduled commands are unavailable right now." : "Create scheduled execution"}>
              {disabled && disabledReason?.includes("saving") ? "Saving..." : "Create scheduled execution"}
            </button>
          </fieldset>
        </form>
      </section>

      <section className="panel scheduleListPanel">
        <div className="panelHeader">
          <h2>Scheduled executions</h2>
          <span className="muted">{schedules.length} configured</span>
        </div>
        <div className="scheduleList">
          {schedules.length ? schedules.map((schedule) => (
            <article key={schedule.id} className={`scheduleRow ${schedule.enabled ? "enabled" : "disabled"}`}>
              <div className="scheduleMain">
                <div>
                  <strong>{schedule.name}</strong>
                  <code>{schedule.cron}</code>
                </div>
                <span className={`runtimeBadge ${schedule.enabled ? "running" : "neutral"}`}>
                  {schedule.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              <ul>
                {schedule.commands.map((command, index) => <li key={`${command}-${index}`}>{command}</li>)}
              </ul>
              <div className="scheduleMeta">
                <span>{schedule.onlyWhenNoPlayers ? "Runs only with no players online" : "Runs regardless of player count"}</span>
                <span className={schedule.lastStatus === "failed" ? "scheduleLastRunFailed" : ""}>
                  {schedule.lastRunAt
                    ? schedule.lastStatus === "failed"
                      ? `Last run failed: ${schedule.lastMessage || "No message from the scheduler"}`
                      : `Last ${schedule.lastStatus || "run"}: ${schedule.lastMessage || "No message"}`
                    : "Never run"}
                </span>
              </div>
              <div className="buttonRow">
                <button type="button" onClick={() => onToggle(schedule)} disabled={disabled} title={disabled ? disabledReason || "Schedule changes are unavailable right now." : schedule.enabled ? "Disable schedule" : "Enable schedule"}>
                  {schedule.enabled ? "Disable" : "Enable"}
                </button>
                <button type="button" className="secondaryButton" onClick={() => setEditingSchedule(schedule)} disabled={disabled} title={disabled ? disabledReason || "Schedule editing is unavailable right now." : "Edit schedule"}>
                  Edit
                </button>
                <button type="button" className="dangerButton" onClick={() => onDelete(schedule)} disabled={disabled} title={disabled ? disabledReason || "Schedule deletion is unavailable right now." : "Delete schedule"}>
                  Delete
                </button>
              </div>
            </article>
          )) : (
            <div className="emptyState compactEmpty">
              <h2>No Schedules</h2>
              <p>No scheduled commands are configured yet. Create one to run console commands automatically at a chosen time.</p>
            </div>
          )}
        </div>
      </section>

      {editingSchedule && (
        <div className="modalBackdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !editSaveRunning) setEditingSchedule(null);
        }}>
          <section className="modalPanel userModalPanel scheduleModalPanel" role="dialog" aria-modal="true" aria-labelledby="edit-schedule-title">
            <form className="userModalForm scheduleModalForm" onSubmit={submitEdit}>
              <div className="userModalHeader">
                <h2 id="edit-schedule-title">Edit Scheduled Execution</h2>
                <button type="button" className="iconButton modalCloseButton" onClick={() => setEditingSchedule(null)} disabled={editSaveRunning} aria-label="Close schedule editor" title={editSaveRunning ? disabledReason || "Schedule save is still running." : "Close schedule editor"}>
                  <AppIcon name="x" />
                </button>
              </div>
              <fieldset disabled={disabled} className="userModalBody scheduleEditBody">
                {editError && <InlineState tone="error" title="Check schedule details" message={editError} />}
                <div className="userModalFields scheduleEditFields">
                  <label>
                    Name
                    <input name="name" defaultValue={editingSchedule.name} required maxLength={80} />
                  </label>
                  <label>
                    Cron schedule
                    <input name="cron" defaultValue={editingSchedule.cron} required pattern="^\S+\s+\S+\s+\S+\s+\S+\s+\S+$" title="Use five cron fields: minute hour day month weekday." />
                  </label>
                </div>
                <div className="commandStack">
                  <span className="fieldLabel">Commands</span>
                  {editCommandIds.map((id, index) => (
                    <div key={id} className="commandInputRow">
                      <input name="commands" defaultValue={editingSchedule.commands[index] ?? ""} required={index === 0} title="Use one console command per line." />
                      {index > 0 && (
                        <button type="button" className="iconDangerButton" onClick={() => setEditCommandIds((ids) => ids.filter((candidate) => candidate !== id))} aria-label="Remove command">
                          <AppIcon name="x" />
                        </button>
                      )}
                    </div>
                  ))}
                  <button type="button" className="secondaryButton" onClick={() => setEditCommandIds((ids) => [...ids, clientId()])}>
                    <AppIcon name="plus" />
                    <span>Additional command</span>
                  </button>
                </div>
                <div className="scheduleEditOptions">
                  <label className="checkLine">
                    <input name="onlyWhenNoPlayers" type="checkbox" defaultChecked={editingSchedule.onlyWhenNoPlayers} />
                    <span>Only run when no players are online</span>
                  </label>
                  <label className="checkLine">
                    <input name="enabled" type="checkbox" defaultChecked={editingSchedule.enabled} />
                    <span>Enabled</span>
                  </label>
                </div>
              </fieldset>
              <div className="userModalFooter">
                <button type="button" className="secondaryButton" onClick={() => setEditingSchedule(null)} disabled={editSaveRunning} title={editSaveRunning ? disabledReason || "Schedule save is still running." : "Cancel"}>Cancel</button>
                <button disabled={disabled} title={disabled ? disabledReason || "Schedule save is still running." : "Save schedule changes"}>{editSaveRunning ? "Saving..." : "Save changes"}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
