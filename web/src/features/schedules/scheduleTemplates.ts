import type { ScheduleStep } from "../../types";

type ScheduleTemplate = {
  id: string;
  name: string;
  summary: string;
  /** The schedule this template creates, in the same shape the editor holds. */
  cron: string;
  steps: ScheduleStep[];
  onlyWhenNoPlayers: boolean;
  waitForPlayersToLeave: boolean;
};

/**
 * Starting points for the schedules almost every server ends up wanting. They fill the editor
 * rather than saving anything, so a template is a faster first draft and not a hidden contract --
 * every field it sets is visible and editable before the schedule is created.
 */
export const scheduleTemplates: ScheduleTemplate[] = [
  {
    id: "nightly-restart",
    name: "Nightly restart",
    summary: "Warns at 5 and 1 minutes, saves, then restarts at 04:00.",
    cron: "0 4 * * *",
    steps: [
      { type: "command", command: "say Server restart in 5 minutes", delaySeconds: 0 },
      { type: "command", command: "say Server restart in 1 minute", delaySeconds: 240 },
      { type: "command", command: "save-all", delaySeconds: 55 },
      { type: "action", procedure: "restart", delaySeconds: 5 }
    ],
    onlyWhenNoPlayers: false,
    waitForPlayersToLeave: false
  },
  {
    id: "hourly-save",
    name: "Hourly save",
    summary: "Flushes the world to disk at the top of every hour.",
    cron: "0 * * * *",
    steps: [{ type: "command", command: "save-all", delaySeconds: 0 }],
    onlyWhenNoPlayers: false,
    waitForPlayersToLeave: false
  },
  {
    id: "weekly-quiet-restart",
    name: "Weekly restart when empty",
    summary: "Waits for the last player to leave, then restarts on Monday morning.",
    cron: "0 5 * * 1",
    steps: [{ type: "action", procedure: "restart", delaySeconds: 0 }],
    onlyWhenNoPlayers: true,
    waitForPlayersToLeave: true
  }
];

export function scheduleTemplateById(id: string) {
  return scheduleTemplates.find((template) => template.id === id);
}
