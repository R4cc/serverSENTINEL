import type { ScheduledExecution, ScheduledRun } from "../../types";

export type ScheduleHealth = {
  tone: "failed" | "skipped";
  /** Short enough to sit in a table row. */
  label: string;
  detail: string;
};

/** Below this a run or two going wrong is noise; at it, the schedule is not doing its job. */
const consecutiveRunsBeforeConcern = 3;

function leadingRuns(runs: readonly ScheduledRun[], matches: (run: ScheduledRun) => boolean) {
  let count = 0;
  for (const run of runs) {
    if (!matches(run)) break;
    count += 1;
  }
  return count;
}

/**
 * Whether a schedule has quietly stopped doing anything useful. Failures are the obvious case, but a
 * schedule that skips every night because the server is always stopped, or always populated, reads
 * exactly like a healthy one -- its last run "succeeded" at skipping, and nothing else says so.
 */
export function scheduleHealth(schedule: Pick<ScheduledExecution, "recentRuns">): ScheduleHealth | null {
  const runs = [...(schedule.recentRuns ?? [])].sort((a, b) => new Date(b.ranAt).getTime() - new Date(a.ranAt).getTime());
  if (runs.length < consecutiveRunsBeforeConcern) return null;

  const failed = leadingRuns(runs, (run) => run.status === "failed");
  if (failed >= consecutiveRunsBeforeConcern) {
    return {
      tone: "failed",
      label: `Failed ${failed} runs in a row`,
      detail: runs[0]?.message || "The last runs of this schedule all failed."
    };
  }

  const skipped = leadingRuns(runs, (run) => run.status === "skipped");
  if (skipped >= consecutiveRunsBeforeConcern) {
    return {
      tone: "skipped",
      label: `Skipped ${skipped} runs in a row`,
      detail: runs[0]?.message || "This schedule has not actually run for its last few occurrences."
    };
  }
  return null;
}

/** The schedules worth drawing attention to away from the Schedules page. */
export function schedulesNeedingAttention(schedules: readonly ScheduledExecution[]) {
  return schedules
    .filter((schedule) => schedule.enabled)
    .map((schedule) => ({ schedule, health: scheduleHealth(schedule) }))
    .filter((entry): entry is { schedule: ScheduledExecution; health: ScheduleHealth } => entry.health !== null);
}
