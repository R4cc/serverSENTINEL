import { FormEvent, useState } from 'react';
import type { ScheduledExecution } from '../types';
import { AppIcon } from '../components/FileTypeIcon';
import { clientId } from '../utils/files';

export function SchedulePage({
  schedules,
  onCreate,
  onToggle,
  onDelete,
  disabled,
  commandInputMessage
}: {
  schedules: ScheduledExecution[];
  onCreate: (event: FormEvent<HTMLFormElement>) => void;
  onToggle: (schedule: ScheduledExecution) => void;
  onDelete: (schedule: ScheduledExecution) => void;
  disabled: boolean;
  commandInputMessage: string;
}) {
  const [commandIds, setCommandIds] = useState(() => [clientId()]);

  return (
    <section className="tabPage schedulePage">
      <section className="panel scheduleCreatePanel">
        <div className="panelHeader">
          <h2>New Scheduled Execution</h2>
          <a href="https://crontab.guru/" target="_blank" rel="noreferrer">Cron Guru</a>
        </div>
        {commandInputMessage && (
          <section className="systemBanner warning compactBanner">
            <strong>Scheduling is limited.</strong>
            <span>{commandInputMessage}</span>
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
              <input name="cron" placeholder="0 4 * * *" required pattern="^\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+\\S+$" title="Use five cron fields: minute hour day month weekday." />
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
                <span>Additional Command</span>
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
            <button>Create scheduled execution</button>
          </fieldset>
        </form>
      </section>

      <section className="panel scheduleListPanel">
        <div className="panelHeader">
          <h2>Scheduled Executions</h2>
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
                <span>{schedule.lastRunAt ? `Last ${schedule.lastStatus}: ${schedule.lastMessage || "No message"}` : "Never run"}</span>
              </div>
              <div className="buttonRow">
                <button type="button" onClick={() => onToggle(schedule)} disabled={disabled}>
                  {schedule.enabled ? "Disable" : "Enable"}
                </button>
                <button type="button" className="dangerButton" onClick={() => onDelete(schedule)} disabled={disabled}>
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
    </section>
  );
}
