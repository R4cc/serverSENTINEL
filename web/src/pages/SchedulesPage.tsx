import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState
} from '@tanstack/react-table';
import {
  cronFromSchedulePlan,
  schedulePlanFromCron,
  type CronSchedulePlan,
  type CronScheduleMode
} from '@serversentinel/contracts';
import type { ScheduleNavigationTarget, ScheduleStep, ScheduledActiveRun, ScheduledExecution, ScheduledRun, ScheduledRunStepDetails } from '../types';
import { AppIcon } from '../components/FileTypeIcon';
import { InlineState } from '../components/InlineState';
import { SortHeaderButton, headerAriaSort } from '../components/TableControls';
import { Button, EmptyState, PanelHeader, Toolbar } from '../components/UiPrimitives';
import { DialogSurface } from '../components/DialogSurface';
import { ActionMenu } from '../components/ActionMenu';
import { clientId } from '../utils/files';
import { validateCommandList, validateCronExpression } from '../utils/validation';
import { formatScheduleOffset, scheduleDelayParts, scheduleDelayToSeconds, scheduleOffsetBadge, scheduleStepOffsets } from '../features/schedules/scheduleDelays';
import { describeCronExpression } from '../features/schedules/cronDescription';
import { buildCronPreview } from '../features/schedules/cronPreview';
import { scheduleTemplateById, scheduleTemplates } from '../features/schedules/scheduleTemplates';

type ScheduleFormMode =
  | { type: "create" }
  | { type: "edit"; schedule: ScheduledExecution };

type SchedulePatch = Pick<ScheduledExecution, "name" | "cron" | "steps" | "onlyWhenNoPlayers" | "waitForPlayersToLeave" | "enabled">;
type StepDraft = {
  id: string;
  type: "command" | "action";
  command: string;
  procedure: "restart";
  delayValue: number;
  delayUnit: "seconds" | "minutes" | "hours";
};
type ScheduledRunPanelItem =
  | (ScheduledActiveRun & { kind: "active"; sortAt: string })
  | (ScheduledRun & { kind: "completed"; sortAt: string });

const defaultDailyCron = "0 4 * * *";

const weekdayChoices = [
  { value: 1, short: "Mon", label: "Monday" },
  { value: 2, short: "Tue", label: "Tuesday" },
  { value: 3, short: "Wed", label: "Wednesday" },
  { value: 4, short: "Thu", label: "Thursday" },
  { value: 5, short: "Fri", label: "Friday" },
  { value: 6, short: "Sat", label: "Saturday" },
  { value: 0, short: "Sun", label: "Sunday" }
];

function clampInterval(value: number, mode: "minutes" | "hours") {
  const max = mode === "minutes" ? 59 : 23;
  if (!Number.isFinite(value)) return 1;
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

function padClock(value: number) {
  return String(value).padStart(2, "0");
}

/**
 * Carries the time of day across a mode change wherever the new shape has somewhere to put it, so
 * switching between Every day and On chosen weekdays does not silently reset a time already chosen.
 */
export function defaultSchedulePlan(mode: CronScheduleMode, current: CronSchedulePlan): CronSchedulePlan {
  const hour = current.mode === "daily" || current.mode === "weekly" ? current.hour : 4;
  const minute = current.mode === "daily" || current.mode === "weekly" ? current.minute : 0;
  if (mode === "minutes") return { mode, every: current.mode === "hours" ? 1 : 15 };
  if (mode === "hours") return { mode, every: current.mode === "minutes" ? 1 : 6 };
  if (mode === "daily") return { mode, hour, minute };
  if (mode === "weekly") {
    return { mode, hour, minute, weekdays: current.mode === "weekly" && current.weekdays.length ? current.weekdays : [1, 2, 3, 4, 5] };
  }
  return { mode: "advanced", cron: cronFromSchedulePlan(current) };
}

function emptyStepDraft(): StepDraft {
  return { id: clientId(), type: "command", command: "", procedure: "restart", delayValue: 0, delayUnit: "seconds" };
}

function stepDraftFromStep(step: ScheduleStep): StepDraft {
  const delay = scheduleDelayParts(step.delaySeconds);
  return {
    id: clientId(),
    type: step.type,
    command: step.type === "command" ? step.command : "",
    procedure: "restart",
    delayValue: delay.value,
    delayUnit: delay.unit
  };
}

export function SchedulePlayerPolicyOptions({ schedule }: { schedule?: Pick<ScheduledExecution, "onlyWhenNoPlayers" | "waitForPlayersToLeave"> }) {
  return (
    <div className="schedulePlayerPolicy" role="radiogroup" aria-labelledby="schedule-player-policy-label">
      <strong id="schedule-player-policy-label">Players online at start</strong>
      <div className="schedulePlayerPolicyChoices">
        <label className="scheduleOptionToggle">
          <input name="playerOnlinePolicy" value="run" type="radio" defaultChecked={!schedule?.onlyWhenNoPlayers} />
          <span className="scheduleOptionCopy"><strong>Run anyway</strong><small>Start on time, even while players are connected.</small></span>
        </label>
        <label className="scheduleOptionToggle">
          <input name="playerOnlinePolicy" value="skip" type="radio" defaultChecked={Boolean(schedule?.onlyWhenNoPlayers && !schedule.waitForPlayersToLeave)} />
          <span className="scheduleOptionCopy"><strong>Skip this run</strong><small>Skip this occurrence and try again at the next scheduled time.</small></span>
        </label>
        <label className="scheduleOptionToggle">
          <input name="playerOnlinePolicy" value="wait" type="radio" defaultChecked={schedule?.waitForPlayersToLeave ?? false} />
          <span className="scheduleOptionCopy"><strong>Wait until empty</strong><small>Keep one cancellable run waiting, then start once everyone leaves.</small></span>
        </label>
      </div>
      <small className="schedulePlayerPolicyNote">Waiting has no timeout. Later matches are ignored so runs never stack up; cancel the active run at any time.</small>
    </div>
  );
}

/**
 * A schedule may hold one Restart, and it has to be last. Both rules were enforced only when the
 * form was submitted, so the Type control happily offered Action on step 1 of 3 and then rejected
 * the save. Reporting the state per step lets the control say so while the schedule is built.
 */
export function scheduleStepTypeAvailability(steps: readonly { id: string; type: StepDraft["type"] }[], stepId: string) {
  const restartIndex = steps.findIndex((step) => step.type === "action");
  const index = steps.findIndex((step) => step.id === stepId);
  const isRestart = restartIndex === index && restartIndex >= 0;
  const isLast = index === steps.length - 1;
  return {
    // Only the final step may become the Restart, and only when no other step already is.
    canBecomeRestart: isRestart || (isLast && restartIndex < 0),
    reason: isRestart || isLast ? "" : "Restart has to be the last step."
  };
}

/**
 * Restart must stay last, so a move that would put another step after it is refused rather than
 * silently reordered into a schedule the server will reject.
 */
export function scheduleStepMoveBlocked(steps: readonly { type: StepDraft["type"] }[], from: number, to: number) {
  const restartIndex = steps.findIndex((step) => step.type === "action");
  if (restartIndex < 0) return false;
  if (from === restartIndex) return to !== steps.length - 1;
  return to >= restartIndex;
}

export function reorderScheduleSteps<T extends { id: string }>(steps: readonly T[], movedId: string, targetId: string): T[] {
  const movedIndex = steps.findIndex((step) => step.id === movedId);
  const targetIndex = steps.findIndex((step) => step.id === targetId);
  if (movedIndex < 0 || targetIndex < 0 || movedIndex === targetIndex) return [...steps];
  const reordered = [...steps];
  const [moved] = reordered.splice(movedIndex, 1);
  reordered.splice(targetIndex, 0, moved);
  return reordered;
}

export function SchedulePage({
  schedules,
  onCreate,
  onToggle,
  onUpdate,
  onDelete,
  onRunNow,
  onCancelRun,
  onLoadRunLogs,
  disabled,
  disabledReason,
  formatDate,
  relativeTimestamps = true,
  scheduleTimeZone,
  displayTimeZone = "",
  navigationTarget,
  onNavigationTargetHandled
}: {
  schedules: ScheduledExecution[];
  formatDate: (value: string | number | Date) => string;
  relativeTimestamps?: boolean;
  scheduleTimeZone: string;
  displayTimeZone?: string;
  navigationTarget?: ScheduleNavigationTarget | null;
  onNavigationTargetHandled?: () => void;
  onCreate: (patch: SchedulePatch) => boolean | void | Promise<boolean | void>;
  onToggle: (schedule: ScheduledExecution) => void;
  onUpdate: (schedule: ScheduledExecution, patch: Partial<ScheduledExecution>) => boolean | Promise<boolean>;
  onDelete: (schedule: ScheduledExecution) => void;
  onRunNow: (schedule: ScheduledExecution) => boolean | Promise<boolean>;
  onCancelRun: (run: ScheduledActiveRun) => boolean | Promise<boolean>;
  onLoadRunLogs?: (run: ScheduledRun) => Promise<ScheduledRun>;
  disabled: boolean;
  disabledReason?: string;
}) {
  const [formMode, setFormMode] = useState<ScheduleFormMode | null>(null);
  const [stepDrafts, setStepDrafts] = useState<StepDraft[]>(() => [emptyStepDraft()]);
  const [formError, setFormError] = useState("");
  const [cronValue, setCronValue] = useState("");
  const [cronMode, setCronMode] = useState<CronScheduleMode>("daily");
  const [nameValue, setNameValue] = useState("");
  // Applying a template has to move the player policy too, and those radios are uncontrolled; this
  // seeds them and remounts the group so the choice a template makes is the one shown.
  const [policySeed, setPolicySeed] = useState<Pick<ScheduledExecution, "onlyWhenNoPlayers" | "waitForPlayersToLeave"> | null>(null);
  const [appliedTemplateId, setAppliedTemplateId] = useState("");
  const [draggingStepId, setDraggingStepId] = useState<string | null>(null);
  const [stepReorderMessage, setStepReorderMessage] = useState("");
  const [selectedRun, setSelectedRun] = useState<ScheduledRun | null>(null);
  const [historySchedule, setHistorySchedule] = useState<ScheduledExecution | null>(null);
  const [scheduleSorting, setScheduleSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  const [relativeNow, setRelativeNow] = useState(() => Date.now());
  const saveRunning = disabled && disabledReason?.toLowerCase().includes("saving");
  const runsFeedRef = useRef<HTMLDivElement>(null);
  const scheduleRowRefs = useRef(new Map<string, HTMLElement>());
  const runItemRefs = useRef(new Map<string, HTMLElement>());
  const scheduleEditBodyRef = useRef<HTMLDivElement>(null);
  const stepDraftsRef = useRef(stepDrafts);
  const draggingStepIdRef = useRef<string | null>(null);
  const dragPointerIdRef = useRef<number | null>(null);
  const dragPointerPositionRef = useRef<{ x: number; y: number } | null>(null);
  const dragScrollFrameRef = useRef<number | null>(null);
  const dragScrollSpeedRef = useRef(0);
  stepDraftsRef.current = stepDrafts;

  useEffect(() => {
    if (!formMode) {
      setStepDrafts([emptyStepDraft()]);
      setFormError("");
      setCronValue("");
      setCronMode("daily");
      setNameValue("");
      setPolicySeed(null);
      setAppliedTemplateId("");
      setDraggingStepId(null);
      setStepReorderMessage("");
      draggingStepIdRef.current = null;
      dragPointerIdRef.current = null;
      stopStepAutoScroll();
      return;
    }
    const steps = formMode.type === "edit" ? formMode.schedule.steps : [];
    setStepDrafts(steps.length ? steps.map(stepDraftFromStep) : [emptyStepDraft()]);
    setFormError("");
    // A new schedule opens on the shape most of them have; an existing one opens on whichever shape
    // its expression already is, so editing starts from what the author wrote rather than raw cron.
    const initialCron = formMode.type === "edit" ? formMode.schedule.cron : defaultDailyCron;
    setCronValue(initialCron);
    setCronMode(schedulePlanFromCron(initialCron).mode);
    setNameValue(formMode.type === "edit" ? formMode.schedule.name : "");
    setPolicySeed(null);
    setAppliedTemplateId("");
    setDraggingStepId(null);
    setStepReorderMessage("");
    draggingStepIdRef.current = null;
    dragPointerIdRef.current = null;
    stopStepAutoScroll();
  }, [formMode]);

  const runItems = useMemo(() => scheduleRunItems(schedules), [schedules]);
  const activeRunCount = runItems.filter((run) => run.kind === "active").length;
  const recentRunsKey = scheduleRunFeedKey(runItems);
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

  // Keyed on the run contents alone. The page refetches app state every 15 seconds, so depending on
  // the `schedules` array identity scrolled the feed back to the top on every poll, whether or not
  // a run had changed, and pulled whatever the reader was looking at out from under them.
  useEffect(() => {
    runsFeedRef.current?.scrollTo({ top: 0 });
  }, [recentRunsKey]);

  // Checked against every retained run rather than the eight the feed shows, because the history
  // dialog can open a run far older than the feed reaches and this would close it again at once.
  useEffect(() => {
    if (selectedRun && !schedules.some((schedule) => schedule.recentRuns?.some((run) => run.id === selectedRun.id))) {
      if (!runItems.some((run) => run.kind === "completed" && run.id === selectedRun.id)) setSelectedRun(null);
    }
  }, [runItems, schedules, selectedRun]);

  useEffect(() => {
    if (!navigationTarget) return;
    const resolved = resolveScheduleNavigationTarget(schedules, navigationTarget);
    if (!resolved) return;
    if (resolved.kind === "completed-run") {
      setSelectedRun(resolved.run);
      onNavigationTargetHandled?.();
      return;
    }
    const target = resolved.kind === "schedule"
      ? scheduleRowRefs.current.get(resolved.schedule.id)
      : runItemRefs.current.get(resolved.run.id);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.focus({ preventScroll: true });
    onNavigationTargetHandled?.();
  }, [navigationTarget, onNavigationTargetHandled, schedules]);

  useEffect(() => {
    setRelativeNow(Date.now());
    const interval = window.setInterval(() => setRelativeNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => () => {
    if (dragScrollFrameRef.current !== null) window.cancelAnimationFrame(dragScrollFrameRef.current);
  }, []);

  function schedulePatchFromForm(form: FormData): SchedulePatch {
    const playerOnlinePolicy = String(form.get("playerOnlinePolicy") ?? "run");
    const steps: ScheduleStep[] = stepDrafts.map((draft) => draft.type === "command"
      ? { type: "command", command: draft.command.trim(), delaySeconds: scheduleDelayToSeconds(draft.delayValue, draft.delayUnit) }
      : { type: "action", procedure: "restart", delaySeconds: scheduleDelayToSeconds(draft.delayValue, draft.delayUnit) });
    return {
      name: String(form.get("name") ?? "").trim(),
      // Read from state rather than the form: outside Advanced the expression is assembled by the
      // builder and never exists as a field.
      cron: cronValue.trim(),
      steps,
      onlyWhenNoPlayers: playerOnlinePolicy !== "run",
      waitForPlayersToLeave: playerOnlinePolicy === "wait",
      enabled: form.get("enabled") === "on"
    };
  }

  function validatePatch(patch: SchedulePatch) {
    const commands = patch.steps.filter((step) => step.type === "command").map((step) => step.command);
    const restartIndexes = patch.steps.flatMap((step, index) => step.type === "action" ? [index] : []);
    return !patch.name
      ? "Schedule name is required."
      : validateCronExpression(patch.cron)
        || (!patch.steps.length ? "At least one schedule step is required." : "")
        || (commands.length ? validateCommandList(commands) : "")
        || (restartIndexes.length > 1 ? "A schedule can contain at most one Restart action." : "")
        || (restartIndexes.length === 1 && restartIndexes[0] !== patch.steps.length - 1 ? "Restart must be the final schedule step." : "")
        || (patch.steps.some((step) => !Number.isInteger(step.delaySeconds) || step.delaySeconds < 0 || step.delaySeconds > 604_800)
          ? "Step delays must be whole values no longer than 7 days."
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
      const created = await onCreate(patch);
      if (created !== false) setFormMode(null);
      return;
    }
    const saved = await onUpdate(formMode.schedule, patch);
    if (saved) setFormMode(null);
  }

  function moveStep(movedId: string, targetId: string) {
    const movedIndex = stepDrafts.findIndex((step) => step.id === movedId);
    const targetIndex = stepDrafts.findIndex((step) => step.id === targetId);
    if (targetIndex < 0 || movedId === targetId) return;
    if (scheduleStepMoveBlocked(stepDrafts, movedIndex, targetIndex)) {
      setStepReorderMessage("Restart has to be the last step, so this move was not made.");
      return;
    }
    setStepDrafts((steps) => {
      const reordered = reorderScheduleSteps(steps, movedId, targetId);
      stepDraftsRef.current = reordered;
      return reordered;
    });
    setStepReorderMessage(`Step moved to position ${targetIndex + 1}.`);
  }

  /** Explicit controls, because a drag handle is unusable on touch and needs a keyboard otherwise. */
  function nudgeStep(stepId: string, direction: -1 | 1) {
    const index = stepDrafts.findIndex((step) => step.id === stepId);
    const target = stepDrafts[index + direction];
    if (target) moveStep(stepId, target.id);
  }

  function moveDraggedStepAtPoint(clientX: number, clientY: number) {
    const movedId = draggingStepIdRef.current;
    const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-schedule-step-id]");
    const targetId = target?.dataset.scheduleStepId;
    if (!movedId || !targetId || movedId === targetId) return;
    setStepDrafts((steps) => {
      const movedIndex = steps.findIndex((step) => step.id === movedId);
      const targetIndex = steps.findIndex((step) => step.id === targetId);
      if (scheduleStepMoveBlocked(steps, movedIndex, targetIndex)) return steps;
      const reordered = reorderScheduleSteps(steps, movedId, targetId);
      stepDraftsRef.current = reordered;
      return reordered;
    });
  }

  function stopStepAutoScroll() {
    dragScrollSpeedRef.current = 0;
    if (dragScrollFrameRef.current !== null) window.cancelAnimationFrame(dragScrollFrameRef.current);
    dragScrollFrameRef.current = null;
  }

  function updateStepAutoScroll(clientY: number) {
    const scrollArea = scheduleEditBodyRef.current;
    if (!scrollArea) return;
    const bounds = scrollArea.getBoundingClientRect();
    const edgeSize = Math.min(64, bounds.height / 4);
    const topDistance = bounds.top + edgeSize - clientY;
    const bottomDistance = clientY - (bounds.bottom - edgeSize);
    const speed = topDistance > 0
      ? -Math.min(18, Math.max(4, Math.ceil(topDistance / 3)))
      : bottomDistance > 0
        ? Math.min(18, Math.max(4, Math.ceil(bottomDistance / 3)))
        : 0;
    dragScrollSpeedRef.current = speed;
    if (!speed) {
      stopStepAutoScroll();
      return;
    }
    if (dragScrollFrameRef.current !== null) return;
    const scroll = () => {
      const body = scheduleEditBodyRef.current;
      const point = dragPointerPositionRef.current;
      if (!body || !point || !draggingStepIdRef.current || !dragScrollSpeedRef.current) {
        dragScrollFrameRef.current = null;
        return;
      }
      body.scrollTop += dragScrollSpeedRef.current;
      moveDraggedStepAtPoint(point.x, point.y);
      dragScrollFrameRef.current = window.requestAnimationFrame(scroll);
    };
    dragScrollFrameRef.current = window.requestAnimationFrame(scroll);
  }

  function startStepDrag(event: PointerEvent<HTMLButtonElement>, stepId: string) {
    if (event.button !== 0) return;
    dragPointerIdRef.current = event.pointerId;
    draggingStepIdRef.current = stepId;
    dragPointerPositionRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingStepId(stepId);
    setStepReorderMessage("Dragging step. Move it over another step to change its position.");
  }

  function dragStep(event: PointerEvent<HTMLButtonElement>) {
    if (dragPointerIdRef.current !== event.pointerId || !draggingStepIdRef.current) return;
    event.preventDefault();
    dragPointerPositionRef.current = { x: event.clientX, y: event.clientY };
    moveDraggedStepAtPoint(event.clientX, event.clientY);
    updateStepAutoScroll(event.clientY);
  }

  function finishStepDrag(event: PointerEvent<HTMLButtonElement>) {
    if (dragPointerIdRef.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const movedId = draggingStepIdRef.current;
    const finalIndex = stepDraftsRef.current.findIndex((step) => step.id === movedId);
    draggingStepIdRef.current = null;
    dragPointerIdRef.current = null;
    dragPointerPositionRef.current = null;
    stopStepAutoScroll();
    setDraggingStepId(null);
    if (finalIndex >= 0) setStepReorderMessage(`Step placed at position ${finalIndex + 1}.`);
  }

  function handleStepReorderKey(event: KeyboardEvent<HTMLButtonElement>, stepId: string) {
    const currentIndex = stepDrafts.findIndex((step) => step.id === stepId);
    if (currentIndex < 0) return;
    const targetIndex = event.key === "ArrowUp"
      ? currentIndex - 1
      : event.key === "ArrowDown"
        ? currentIndex + 1
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? stepDrafts.length - 1
            : currentIndex;
    if (targetIndex === currentIndex || targetIndex < 0 || targetIndex >= stepDrafts.length) return;
    event.preventDefault();
    moveStep(stepId, stepDrafts[targetIndex].id);
  }

  const modalSchedule = formMode?.type === "edit" ? formMode.schedule : null;
  const modalTitle = formMode?.type === "edit" ? "Edit schedule" : "Add schedule";
  const modalBusyTitle = saveRunning ? disabledReason || "Schedule save is still running." : "Close schedule editor";
  // The expression stays the single source of truth: the builder reads the plan back out of it on
  // every render and writes a new expression on every change, so the two can never disagree and an
  // expression the builder cannot express survives editing untouched in Advanced.
  const schedulePlan = useMemo<CronSchedulePlan>(
    () => cronMode === "advanced" ? { mode: "advanced", cron: cronValue } : schedulePlanFromCron(cronValue),
    [cronMode, cronValue]
  );

  const stepOffsets = scheduleStepOffsets(stepDrafts.map((draft) => scheduleDelayToSeconds(draft.delayValue, draft.delayUnit)));
  const totalStepSeconds = stepOffsets.at(-1) ?? 0;
  const stepTypeAvailability = stepDrafts.map((draft) => scheduleStepTypeAvailability(stepDrafts, draft.id));
  // Followed through the polled list rather than held as a snapshot, so a run finishing while the
  // dialog is open appears in it. Falls back to the captured schedule if it has been deleted.
  const liveHistorySchedule = historySchedule ? schedules.find((candidate) => candidate.id === historySchedule.id) : undefined;

  function applyScheduleTemplate(templateId: string) {
    const template = scheduleTemplateById(templateId);
    if (!template) return;
    setNameValue(template.name);
    setCronValue(template.cron);
    setCronMode(schedulePlanFromCron(template.cron).mode);
    setStepDrafts(template.steps.map(stepDraftFromStep));
    setPolicySeed({ onlyWhenNoPlayers: template.onlyWhenNoPlayers, waitForPlayersToLeave: template.waitForPlayersToLeave });
    setAppliedTemplateId(templateId);
    setFormError("");
  }

  function applySchedulePlan(plan: CronSchedulePlan) {
    setCronValue(cronFromSchedulePlan(plan));
  }

  function changeScheduleMode(mode: CronScheduleMode) {
    setCronMode(mode);
    if (mode === "advanced") return;
    applySchedulePlan(defaultSchedulePlan(mode, schedulePlan));
  }

  const cronError = cronValue.trim() ? validateCronExpression(cronValue) : null;
  const cronDescription = cronValue.trim() && !cronError ? describeCronExpression(cronValue) : null;
  // Recomputed on every keystroke rather than memoised: the search stops at the third match, and
  // the dialog is the only place it runs.
  const cronPreview = cronDescription
    ? buildCronPreview(cronValue, scheduleTimeZone, displayTimeZone, (value) => formatDate(value))
    : null;

  return (
    <section className="tabPage schedulePage scheduleWorkspacePage layoutWide">
      <Toolbar
        className="scheduleWorkspaceToolbar"
        primary={<Button
          className="scheduleAddButton"
          onClick={() => setFormMode({ type: "create" })}
          disabled={disabled}
          title={disabled ? disabledReason || "Schedule creation is unavailable right now." : "Add schedule"}
        >
          <AppIcon name="plus" />
          <span>Add schedule</span>
        </Button>}
        meta={<div className="scheduleWorkspaceContext">
          <span>Cron timezone</span>
          <strong>{scheduleTimeZone}</strong>
        </div>}
      />

      {disabled && disabledReason && !saveRunning && (
        <InlineState tone="warning" title="Schedules are unavailable" message={disabledReason} />
      )}

      <div className="scheduleWorkspaceGrid">
        <section className="panel scheduleTableCard">
          <PanelHeader
            className="scheduleCardHeader"
            title="Configured schedules"
            description={`${schedules.length} schedule${schedules.length === 1 ? "" : "s"} for this server.`}
          />

          <div className="scheduleTableFrame" role="table" aria-label="Schedules">
            <div className="scheduleTableHeader" role="row">
              {scheduleTable.getHeaderGroups()[0]?.headers.map((header) => (
                <span key={header.id} role="columnheader" aria-sort={headerAriaSort(header)}>
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
            <div className="scheduleTableBody" role="rowgroup">
              {scheduleRows.length ? scheduleRows.map((row) => {
                const schedule = row.original;
                const scheduleIsActive = Boolean(schedule.activeRuns?.length);
                return (
                <article
                  key={schedule.id}
                  ref={(element) => {
                    if (element) scheduleRowRefs.current.set(schedule.id, element);
                    else scheduleRowRefs.current.delete(schedule.id);
                  }}
                  className={`scheduleTableRow ${schedule.enabled ? "enabled" : "disabled"}`}
                  role="row"
                  tabIndex={-1}
                >
                  <div className="scheduleNameCell" data-label="Name" role="cell">
                    <div className="scheduleCellValue scheduleNameValue">
                      <strong title={schedule.name}>{schedule.name}</strong>
                      <small title={scheduleDescription(schedule)}>{scheduleDescription(schedule)}</small>
                    </div>
                  </div>
                  <div className="scheduleCell" data-label="Schedule" role="cell">
                    <div className="scheduleCellValue">
                      <code title={schedule.cron}>{schedule.cron}</code>
                      <small title={cronSummary(schedule.cron)}>{cronSummary(schedule.cron)}</small>
                    </div>
                  </div>
                  <div className="scheduleCell" data-label="Last run" role="cell">
                    <div className="scheduleCellValue scheduleRunValue">
                      {schedule.lastRunAt ? (
                        <div className="scheduleStatusLine">
                          <time
                            className="scheduleRelativeTime"
                            dateTime={schedule.lastRunAt}
                            title={relativeTimestamps ? formatScheduleTime(schedule.lastRunAt, formatDate) : undefined}
                          >
                            {relativeTimestamps ? lastRunRelativeTime(schedule.lastRunAt, relativeNow) : formatScheduleTime(schedule.lastRunAt, formatDate)}
                          </time>
                          <span
                            className={`scheduleStatusIcon ${statusTone(schedule.lastStatus)}`}
                            role="img"
                            aria-label={statusLabel(schedule.lastStatus)}
                            title={statusLabel(schedule.lastStatus)}
                          >
                            <AppIcon name={statusIcon(schedule.lastStatus)} />
                          </span>
                        </div>
                      ) : (
                        <><span>Never run</span><small>No execution yet</small></>
                      )}
                    </div>
                  </div>
                  <div className="scheduleCell" data-label="Next run" role="cell">
                    <div className="scheduleCellValue">
                      {schedule.enabled && schedule.nextRunAt ? (
                        <time
                          className="scheduleRelativeTime"
                          dateTime={schedule.nextRunAt}
                          title={relativeTimestamps ? formatScheduleTime(schedule.nextRunAt, formatDate) : undefined}
                        >
                          {relativeTimestamps ? nextRunRelativeTime(schedule.nextRunAt, relativeNow) : formatScheduleTime(schedule.nextRunAt, formatDate)}
                        </time>
                      ) : (
                        <><span>{schedule.enabled ? "Not available" : "Disabled"}</span><small>{schedule.enabled ? "Waiting for a valid cron match" : "Enable to resume"}</small></>
                      )}
                    </div>
                  </div>
                  <div className="scheduleEnabledCell" data-label="Enabled" role="cell">
                    <div className="scheduleCellValue">
                      <label className="switch scheduleTableSwitch">
                        <input
                          type="checkbox"
                          checked={schedule.enabled}
                          onChange={() => onToggle(schedule)}
                          disabled={disabled}
                          aria-label={`${schedule.enabled ? "Disable" : "Enable"} ${schedule.name}`}
                        />
                        <span className="slider"></span>
                      </label>
                    </div>
                  </div>
                  <div className="scheduleRowActions" data-label="Actions" role="cell">
                    <div className="scheduleCellValue">
                      <ActionMenu
                        label={`Actions for ${schedule.name}`}
                        className="scheduleActionMenu"
                        triggerClassName="scheduleActionMenuTrigger"
                        disabled={disabled}
                        items={[
                          {
                            id: "run-now",
                            label: "Run now",
                            icon: <AppIcon name="refresh" />,
                            onSelect: () => { void onRunNow(schedule); },
                            disabled: disabled || scheduleIsActive,
                            title: scheduleIsActive
                              ? "This schedule already has an active run. Cancel it or wait for it to finish."
                              : disabled ? disabledReason || "Schedule runs are unavailable right now." : `Run ${schedule.name} now`
                          },
                          {
                            id: "view-runs",
                            label: "View runs",
                            icon: <AppIcon name="hourglass" />,
                            onSelect: () => setHistorySchedule(schedule),
                            disabled: !schedule.recentRuns?.length,
                            title: schedule.recentRuns?.length
                              ? `View the run history for ${schedule.name}`
                              : `${schedule.name} has not run yet`
                          },
                          {
                            id: "edit",
                            label: "Edit",
                            icon: <AppIcon name="edit" />,
                            onSelect: () => setFormMode({ type: "edit", schedule }),
                            disabled
                          },
                          {
                            id: "delete",
                            label: "Delete",
                            icon: <AppIcon name="trash" />,
                            onSelect: () => onDelete(schedule),
                            disabled,
                            critical: true,
                            separatorBefore: true
                          }
                        ]}
                        trigger={<AppIcon name="moreVertical" />}
                      />
                    </div>
                  </div>
                </article>
                );
              }) : (
                <EmptyState compact className="scheduleNoRows" title="No schedules added" message="Use Add schedule to create automated commands or actions." />
              )}
            </div>
          </div>
        </section>

        <aside className="panel scheduledRunsCard">
          <PanelHeader className="scheduleCardHeader compact" title="Scheduled Runs" description={activeRunCount ? `${activeRunCount} active execution${activeRunCount === 1 ? "" : "s"} plus recent history.` : "Most recent scheduled executions."} />
          {runItems.length ? (
            <div ref={runsFeedRef} className="scheduledRunsFeed">
              {runItems.map((run) => (
                <article
                  key={`${run.kind}:${run.id}`}
                  ref={(element) => {
                    if (element) runItemRefs.current.set(run.id, element);
                    else runItemRefs.current.delete(run.id);
                  }}
                  className={`scheduledRunItem ${statusTone(run.status)} ${run.kind === "active" ? "active" : ""}`}
                  tabIndex={-1}
                >
                  <span className="scheduledRunMarker" aria-hidden="true"></span>
                  <div className="scheduledRunDetails">
                    <strong title={run.scheduleName}>{run.scheduleName}</strong>
                    <small>{run.kind === "active" ? activeRunStatus(run) : statusLabel(run.status)}</small>
                    {run.kind === "active" && run.currentStep && (
                      <small className="scheduledRunAction" title={run.currentStep}>Step {(run.currentStepIndex ?? 0) + 1} of {run.stepCount}: {run.currentStep}</small>
                    )}
                  </div>
                  <div className="scheduledRunTime">
                    <span>
                      {run.kind === "active"
                        ? relativeTimestamps ? relativeTime(run.startedAt, relativeNow) : `Started ${formatScheduleTime(run.startedAt, formatDate)}`
                        : relativeTimestamps ? relativeTime(run.ranAt, relativeNow) : formatScheduleTime(run.ranAt, formatDate)}
                    </span>
                    {relativeTimestamps && <small>{run.kind === "active" ? `Started ${formatScheduleTime(run.startedAt, formatDate)}` : formatScheduleTime(run.ranAt, formatDate)}</small>}
                  </div>
                  {run.kind === "active" && (
                    <div className="scheduledRunActions">
                      <Button variant="critical" iconOnly compact className="scheduledRunCancelButton" onClick={() => void onCancelRun(run)} disabled={disabled || !run.cancellable} aria-label={`Cancel ${run.scheduleName}`} title={!run.cancellable ? "Restart is in progress and must finish." : disabled ? disabledReason || "Schedule cancellation is unavailable right now." : `Cancel ${run.scheduleName}`}>
                        <AppIcon name="x" />
                      </Button>
                    </div>
                  )}
                  {run.kind === "completed" && (
                    <div className="scheduledRunActions">
                      <Button variant="secondary" compact className="scheduledRunDetailsButton" onClick={() => setSelectedRun(run)} aria-label={`View details for ${run.scheduleName}`} title={`View details for ${run.scheduleName}`}>
                        Details
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
      </div>

      {formMode && (
        <DialogSurface backdrop="scheduleModalBackdrop" dismissible={!saveRunning} className="modalPanel userModalPanel scheduleModalPanel" labelledBy="schedule-modal-title" onClose={() => setFormMode(null)}>
          <form className="userModalForm scheduleModalForm" onSubmit={submitSchedule}>
            <div className="userModalHeader">
              <h2 id="schedule-modal-title">{modalTitle}</h2>
              <Button variant="secondary" iconOnly className="iconButton modalCloseButton" onClick={() => setFormMode(null)} disabled={saveRunning} aria-label="Close schedule editor" title={modalBusyTitle}>
                <AppIcon name="x" />
              </Button>
            </div>
            <div className="userModalBody scheduleEditBody" ref={scheduleEditBodyRef}>
              <fieldset disabled={disabled} className="scheduleEditFieldset">
              {formError && <InlineState tone="error" title="Check schedule details" message={formError} />}

              {/* Only offered for a new schedule, and only as a first draft: a template fills the
                  fields below and saves nothing, so everything it chose stays visible and editable. */}
              {formMode.type === "create" && (
                <section className="scheduleEditorSection scheduleTemplateSection" aria-labelledby="schedule-templates-heading">
                  <div className="scheduleEditorSectionHeader">
                    <div><h3 id="schedule-templates-heading">Start from a template</h3><p>Optional. Fills the form below with a common setup you can then change.</p></div>
                  </div>
                  <div className="scheduleTemplateChoices">
                    {scheduleTemplates.map((template) => (
                      <button
                        type="button"
                        key={template.id}
                        className={`scheduleTemplateCard ${appliedTemplateId === template.id ? "applied" : ""}`.trim()}
                        onClick={() => applyScheduleTemplate(template.id)}
                        aria-pressed={appliedTemplateId === template.id}
                      >
                        <strong>{template.name}</strong>
                        <small>{template.summary}</small>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              <section className="scheduleEditorSection" aria-labelledby="schedule-details-heading">
                <div className="scheduleEditorSectionHeader">
                  <div><h3 id="schedule-details-heading">Details</h3><p>Name the automation and choose when it runs.</p></div>
                  <span className="scheduleEditorMeta">Timezone: {scheduleTimeZone}</span>
                </div>
                <div className="userModalFields scheduleEditFields">
                  <label>
                    Name
                    <input name="name" value={nameValue} onChange={(event) => setNameValue(event.target.value)} placeholder="Nightly maintenance" required maxLength={80} />
                  </label>
                  <label className="scheduleRepeatField">
                    Repeat
                    <select
                      value={schedulePlan.mode}
                      onChange={(event) => changeScheduleMode(event.target.value as CronScheduleMode)}
                      aria-label="How often this schedule repeats"
                    >
                      <option value="minutes">Every few minutes</option>
                      <option value="hours">Every few hours</option>
                      <option value="daily">Every day</option>
                      <option value="weekly">On chosen weekdays</option>
                      <option value="advanced">Advanced (cron)</option>
                    </select>
                  </label>
                </div>

                <div className="scheduleRepeatControls">
                  {schedulePlan.mode === "minutes" || schedulePlan.mode === "hours" ? (
                    <label className="scheduleRepeatInterval">
                      <span>{schedulePlan.mode === "minutes" ? "Minutes between runs" : "Hours between runs"}</span>
                      <input
                        type="number"
                        min="1"
                        max={schedulePlan.mode === "minutes" ? 59 : 23}
                        step="1"
                        value={schedulePlan.every}
                        onChange={(event) => applySchedulePlan({ ...schedulePlan, every: clampInterval(Number(event.target.value), schedulePlan.mode) })}
                      />
                    </label>
                  ) : null}

                  {schedulePlan.mode === "daily" || schedulePlan.mode === "weekly" ? (
                    <label className="scheduleRepeatTime">
                      <span>Time of day</span>
                      <input
                        type="time"
                        value={`${padClock(schedulePlan.hour)}:${padClock(schedulePlan.minute)}`}
                        onChange={(event) => {
                          const [hour, minute] = event.target.value.split(":").map(Number);
                          if (!Number.isInteger(hour) || !Number.isInteger(minute)) return;
                          applySchedulePlan({ ...schedulePlan, hour, minute });
                        }}
                      />
                    </label>
                  ) : null}

                  {schedulePlan.mode === "weekly" && (
                    <fieldset className="scheduleWeekdayPicker">
                      <legend>Days</legend>
                      <div className="scheduleWeekdayChoices">
                        {weekdayChoices.map((choice) => {
                          const selected = schedulePlan.weekdays.includes(choice.value);
                          return (
                            <label key={choice.value} className={`scheduleWeekdayChoice ${selected ? "selected" : ""}`.trim()}>
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={() => applySchedulePlan({
                                  ...schedulePlan,
                                  weekdays: selected
                                    ? schedulePlan.weekdays.filter((day) => day !== choice.value)
                                    : [...schedulePlan.weekdays, choice.value]
                                })}
                                aria-label={choice.label}
                              />
                              <span aria-hidden="true">{choice.short}</span>
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>
                  )}

                  {schedulePlan.mode === "advanced" && (
                    <label className="scheduleCronField">
                      <span>Cron expression</span>
                      <input
                        value={cronValue}
                        onChange={(event) => setCronValue(event.target.value)}
                        placeholder="0 4 * * *"
                        required
                        aria-invalid={Boolean(cronError)}
                        aria-describedby={cronError ? "schedule-cron-error" : "schedule-cron-description"}
                        title={`Use five cron fields in ${scheduleTimeZone}: minute hour day month weekday.`}
                      />
                    </label>
                  )}
                </div>

                {/* One feedback line in every state: the format hint holds the slot until the
                    expression parses, so the section never changes height as it is edited. */}
                {cronError
                  ? <span id="schedule-cron-error" className="fieldErrorBubble scheduleCronFeedback" role="tooltip">{cronError}</span>
                  : <span id="schedule-cron-description" className="scheduleCronFeedback valid">{cronDescription || "Five fields: minute hour day month weekday."}</span>}
                {/* Day-of-month against day-of-week is the classic way to write a cron that parses
                    and still fires on the wrong days, and a description alone cannot show that.
                    Three real datestamps can. */}
                {cronPreview && (
                  <div className="scheduleCronPreview">
                    <span className="scheduleCronPreviewLabel">Next runs</span>
                    <ol className="scheduleCronPreviewList">
                      {cronPreview.occurrences.map((occurrence) => (
                        <li key={occurrence}>{occurrence}</li>
                      ))}
                      <li className="scheduleCronPreviewZone">{scheduleTimeZone}</li>
                    </ol>
                    {cronPreview.viewerNote && (
                      <small className="scheduleCronPreviewNote">{cronPreview.viewerNote}</small>
                    )}
                  </div>
                )}
              </section>

              <section className="scheduleEditorSection" aria-labelledby="schedule-steps-heading">
                <div className="scheduleEditorSectionHeader">
                  <div><h3 id="schedule-steps-heading">Steps</h3><p>Steps run from top to bottom. Reorder them with the arrow buttons, or by dragging a handle.</p></div>
                </div>
                <div className="commandStack scheduleCommandStack">
                  <span className="visuallyHidden" role="status" aria-live="polite">{stepReorderMessage}</span>
                  <div className="scheduleCommandList">
                    {stepDrafts.map((draft, index) => (
                      <div key={draft.id} className={`scheduleStepCard ${draggingStepId === draft.id ? "isDragging" : ""}`.trim()} data-schedule-step-id={draft.id}>
                        <div className="scheduleStepHeader">
                          <div className="scheduleStepIdentity">
                            <Button
                              variant="ghost"
                              iconOnly
                              compact
                              className="scheduleStepDragHandle"
                              onPointerDown={(event) => startStepDrag(event, draft.id)}
                              onPointerMove={dragStep}
                              onPointerUp={finishStepDrag}
                              onPointerCancel={finishStepDrag}
                              onKeyDown={(event) => handleStepReorderKey(event, draft.id)}
                              aria-label={`Reorder step ${index + 1}. Drag or use the arrow keys.`}
                              title="Drag to reorder. You can also use the arrow, Home, and End keys."
                            >
                              <AppIcon name="drag" />
                            </Button>
                            <strong>Step {index + 1}</strong>
                            <span className="scheduleStepOffset" title={`Runs ${formatScheduleOffset(stepOffsets[index])}.`}>
                              {scheduleOffsetBadge(stepOffsets[index])}
                            </span>
                          </div>
                          <div className="scheduleStepControls">
                            {/* The drag handle cannot be used on a touch screen and needs a keyboard
                                otherwise, so reordering also has controls that are just buttons. */}
                            <Button
                              variant="ghost"
                              iconOnly
                              compact
                              className="scheduleStepMove"
                              onClick={() => nudgeStep(draft.id, -1)}
                              disabled={index === 0 || scheduleStepMoveBlocked(stepDrafts, index, index - 1)}
                              aria-label={`Move step ${index + 1} up`}
                              title={`Move step ${index + 1} up`}
                            >
                              <AppIcon name="chevronUp" />
                            </Button>
                            <Button
                              variant="ghost"
                              iconOnly
                              compact
                              className="scheduleStepMove"
                              onClick={() => nudgeStep(draft.id, 1)}
                              disabled={index === stepDrafts.length - 1 || scheduleStepMoveBlocked(stepDrafts, index, index + 1)}
                              aria-label={`Move step ${index + 1} down`}
                              title={`Move step ${index + 1} down`}
                            >
                              <AppIcon name="chevronDown" />
                            </Button>
                            {stepDrafts.length > 1 && (
                              <Button variant="ghost" iconOnly compact className="iconDangerButton scheduleStepRemove" onClick={() => setStepDrafts((steps) => steps.filter((candidate) => candidate.id !== draft.id))} aria-label={`Remove step ${index + 1}`} title={`Remove step ${index + 1}`}>
                                <AppIcon name="x" />
                              </Button>
                            )}
                          </div>
                        </div>
                        <div className="scheduleStepFields">
                          <label className="scheduleStepType">
                            <span>Type</span>
                            <select
                              value={draft.type}
                              onChange={(event) => setStepDrafts((steps) => steps.map((step) => step.id === draft.id ? { ...step, type: event.target.value as StepDraft["type"] } : step))}
                              aria-label={`Type for step ${index + 1}`}
                              title={stepTypeAvailability[index].reason || undefined}
                            >
                              <option value="command">Command</option>
                              {/* Offered only where a Restart could legally go, so the rule is
                                  visible while the schedule is built rather than at save time. */}
                              <option value="action" disabled={!stepTypeAvailability[index].canBecomeRestart}>
                                Restart{stepTypeAvailability[index].canBecomeRestart ? "" : " (last step only)"}
                              </option>
                            </select>
                          </label>
                          {draft.type === "command" ? (
                            <label className="scheduleStepValue">
                              <span>Command</span>
                              <input value={draft.command} onChange={(event) => setStepDrafts((steps) => steps.map((step) => step.id === draft.id ? { ...step, command: event.target.value } : step))} placeholder={index === 0 ? "say Restarting in 5 minutes" : "save-all"} required title="Use one console command per step." />
                            </label>
                          ) : (
                            // Restart is the only procedure, and the Type control already names it,
                            // so this states what happens instead of offering a choice of one.
                            <p className="scheduleStepValue scheduleStepProcedure">Gracefully restarts the Minecraft server. This has to be the final step.</p>
                          )}
                          <label className="scheduleCommandDelay">
                            <span>Delay before step</span>
                            <span className="scheduleDelayControls">
                              <input type="number" min="0" max="604800" step="1" value={draft.delayValue} onChange={(event) => setStepDrafts((steps) => steps.map((step) => step.id === draft.id ? { ...step, delayValue: Number(event.target.value) } : step))} required aria-label={`Delay before step ${index + 1}`} />
                              <select value={draft.delayUnit} onChange={(event) => setStepDrafts((steps) => steps.map((step) => step.id === draft.id ? { ...step, delayUnit: event.target.value as StepDraft["delayUnit"] } : step))} aria-label={`Delay unit before step ${index + 1}`}>
                                <option value="seconds">Seconds</option>
                                <option value="minutes">Minutes</option>
                                <option value="hours">Hours</option>
                              </select>
                            </span>
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                  <Button variant="secondary" compact className="scheduleCommandAdd" onClick={() => setStepDrafts((steps) => [...steps, emptyStepDraft()])}>
                    <AppIcon name="plus" />
                    <span>Additional step</span>
                  </Button>
                  {totalStepSeconds > 0 && (
                    <small className="scheduleStepTotal">
                      The last step runs {formatScheduleOffset(totalStepSeconds)} after the scheduled time.
                    </small>
                  )}
                </div>
              </section>

              <section className="scheduleEditorSection" aria-labelledby="schedule-options-heading">
                <div className="scheduleEditorSectionHeader">
                  <div><h3 id="schedule-options-heading">Options</h3><p>Choose what happens at the scheduled start time.</p></div>
                </div>
                <div className="scheduleEditOptions">
                  <SchedulePlayerPolicyOptions key={appliedTemplateId} schedule={policySeed ?? modalSchedule ?? undefined} />
                  <label className="scheduleOptionToggle scheduleEnabledOption">
                    <input name="enabled" type="checkbox" defaultChecked={modalSchedule?.enabled ?? true} />
                    <span className="scheduleOptionCopy"><strong>Enabled</strong><small>Allow cron matches to start this schedule.</small></span>
                  </label>
                </div>
              </section>
              </fieldset>
            </div>
            <div className="userModalFooter">
              <Button variant="secondary" onClick={() => setFormMode(null)} disabled={saveRunning} title={saveRunning ? disabledReason || "Schedule save is still running." : "Cancel"}>Cancel</Button>
              <Button type="submit" disabled={disabled} title={disabled ? disabledReason || "Schedule save is still running." : modalTitle} reserveLabel={formMode.type === "edit" ? "Save changes" : "Create schedule"}>{saveRunning ? "Saving..." : formMode.type === "edit" ? "Save changes" : "Create schedule"}</Button>
            </div>
          </form>
        </DialogSurface>
      )}

      {historySchedule && !selectedRun && (
        <ScheduleRunHistoryDialog
          schedule={liveHistorySchedule ?? historySchedule}
          formatDate={formatDate}
          relativeTimestamps={relativeTimestamps}
          relativeNow={relativeNow}
          onSelectRun={setSelectedRun}
          onClose={() => setHistorySchedule(null)}
        />
      )}

      {selectedRun && (
        <ScheduleRunDetailsDialog
          run={selectedRun}
          formatDate={formatDate}
          onLoadRunLogs={onLoadRunLogs}
          onClose={() => setSelectedRun(null)}
        />
      )}
    </section>
  );
}

/**
 * Whether this run still needs its captured console output fetched. Run lists carry every field
 * except `logs`, so a command step that reported captured output but arrived without it is the
 * signal — which also means a run whose steps captured nothing never triggers a request.
 */
export function scheduleRunLogsPending(run: ScheduledRun) {
  return (run.details?.steps ?? []).some((step) => (
    step.type === "command" && step.logCaptureStatus === "captured" && step.logs === undefined
  ));
}

/**
 * Every run the panel still holds for one schedule. The feed beside the table mixes all schedules
 * and stops at eight, so most of the retained history had nowhere to be read; the runs are already
 * in the payload the page polls, so this only has to render them.
 */
export function ScheduleRunHistoryDialog({
  schedule,
  formatDate,
  relativeTimestamps = true,
  relativeNow,
  onSelectRun,
  onClose
}: {
  schedule: ScheduledExecution;
  formatDate: (value: string | number | Date) => string;
  relativeTimestamps?: boolean;
  relativeNow: number;
  onSelectRun: (run: ScheduledRun) => void;
  onClose: () => void;
}) {
  const runs = [...(schedule.recentRuns ?? [])].sort((a, b) => new Date(b.ranAt).getTime() - new Date(a.ranAt).getTime());
  return (
    <DialogSurface backdrop="scheduleModalBackdrop" className="modalPanel scheduleRunModalPanel scheduleHistoryPanel" labelledBy="schedule-history-title" describedBy="schedule-history-description" onClose={onClose}>
      <div className="userModalHeader scheduleRunModalHeader">
        <div>
          <h2 id="schedule-history-title">{schedule.name}</h2>
          <p id="schedule-history-description">{runs.length} recorded {runs.length === 1 ? "run" : "runs"}</p>
        </div>
        <Button variant="secondary" iconOnly className="iconButton modalCloseButton" onClick={onClose} aria-label="Close run history" title="Close run history">
          <AppIcon name="x" />
        </Button>
      </div>
      <div className="scheduleRunModalBody">
        {runs.length ? (
          <div className="scheduleHistoryList">
            {runs.map((run) => (
              <article key={run.id} className={`scheduleHistoryRow ${statusTone(run.status)}`}>
                <span className="scheduledRunMarker" aria-hidden="true"></span>
                <div className="scheduleHistoryDetails">
                  <strong>{statusLabel(run.status)}</strong>
                  {run.message && <small title={run.message}>{run.message}</small>}
                </div>
                <div className="scheduleHistoryTime">
                  <span>{relativeTimestamps ? lastRunRelativeTime(run.ranAt, relativeNow) : formatScheduleTime(run.ranAt, formatDate)}</span>
                  {relativeTimestamps && <small>{formatScheduleTime(run.ranAt, formatDate)}</small>}
                </div>
                <Button variant="secondary" compact onClick={() => onSelectRun(run)} aria-label={`View details for the run at ${formatScheduleTime(run.ranAt, formatDate)}`}>
                  Details
                </Button>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState compact title="No runs recorded" message="Runs appear here once this schedule has executed." />
        )}
      </div>
      <div className="userModalFooter scheduleRunModalFooter">
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </div>
    </DialogSurface>
  );
}

export function ScheduleRunDetailsDialog({
  run,
  formatDate,
  onLoadRunLogs,
  onClose
}: {
  run: ScheduledRun;
  formatDate: (value: string | number | Date) => string;
  onLoadRunLogs?: (run: ScheduledRun) => Promise<ScheduledRun>;
  onClose: () => void;
}) {
  const [resolved, setResolved] = useState(run);
  // Seeded rather than defaulted to false so the first paint already reads as loading; otherwise
  // the dialog would flash "unavailable" for the frame before the effect starts the request.
  const [logsLoading, setLogsLoading] = useState(() => Boolean(onLoadRunLogs) && scheduleRunLogsPending(run));
  const [logsError, setLogsError] = useState("");
  // Held in a ref because the workspace rebuilds its action callbacks on every app render, and
  // the status and schedule polls force one every few seconds. Depending on the callback identity
  // would refetch the logs on each of those and blank the dialog back to its loading state; the
  // selected run object, by contrast, is stable for as long as the dialog stays open.
  const loadRunLogsRef = useRef(onLoadRunLogs);
  loadRunLogsRef.current = onLoadRunLogs;

  useEffect(() => {
    const loadRunLogs = loadRunLogsRef.current;
    setResolved(run);
    setLogsError("");
    if (!loadRunLogs || !scheduleRunLogsPending(run)) {
      setLogsLoading(false);
      return;
    }
    let cancelled = false;
    setLogsLoading(true);
    void loadRunLogs(run)
      .then((detailed) => { if (!cancelled) setResolved(detailed); })
      .catch(() => { if (!cancelled) setLogsError("Console output for this run could not be loaded."); })
      .finally(() => { if (!cancelled) setLogsLoading(false); });
    return () => { cancelled = true; };
  }, [run]);

  const steps = resolved.details?.steps;
  return (
    <DialogSurface backdrop="scheduleModalBackdrop" className="modalPanel scheduleRunModalPanel" labelledBy="schedule-run-modal-title" describedBy="schedule-run-modal-description" onClose={onClose}>
      <div className="userModalHeader scheduleRunModalHeader">
        <div>
          <h2 id="schedule-run-modal-title">{run.scheduleName}</h2>
          <p id="schedule-run-modal-description">Run details for {formatDate(run.ranAt)}</p>
        </div>
        <Button variant="secondary" iconOnly className="iconButton modalCloseButton" onClick={onClose} aria-label="Close run details" title="Close run details">
          <AppIcon name="x" />
        </Button>
      </div>
      <div className="scheduleRunModalBody">
        <div className="scheduleRunSummary">
          <div><span>Status</span><strong className={statusTone(run.status)}>{statusLabel(run.status)}</strong></div>
          <div><span>Started</span><strong>{formatDate(run.ranAt)}</strong></div>
          <div><span>Steps completed</span><strong>{run.details ? `${run.details.completedStepCount} of ${run.details.stepCount}` : "Not recorded"}</strong></div>
        </div>
        {run.message && <p className="scheduleRunMessage">{run.message}</p>}

        <section className="scheduleRunSteps" aria-labelledby="schedule-run-steps-heading">
          <div className="scheduleRunSectionHeader">
            <h3 id="schedule-run-steps-heading">Executed steps</h3>
            {steps && <span>{steps.length} recorded</span>}
          </div>
          {steps === undefined ? (
            <EmptyState compact className="scheduleRunStepsEmpty" title="Step details unavailable" message="This run was recorded before detailed command history was enabled." />
          ) : steps.length === 0 ? (
            <EmptyState compact className="scheduleRunStepsEmpty" title="No steps executed" message={run.status === "skipped" ? run.message : "The run ended before its first step started."} />
          ) : (
            <div className="scheduleRunStepList">
              {steps.map((step) => (
                <ScheduleRunStep
                  key={`${step.stepIndex}:${step.startedAt}`}
                  step={step}
                  logsLoading={logsLoading}
                  logsError={logsError}
                />
              ))}
            </div>
          )}
        </section>
      </div>
      <div className="userModalFooter scheduleRunModalFooter">
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </div>
    </DialogSurface>
  );
}

function ScheduleRunStep({ step, logsLoading, logsError }: { step: ScheduledRunStepDetails; logsLoading?: boolean; logsError?: string }) {
  const isCommand = step.type === "command";
  const logs = step.logs ?? [];
  // `logs` arriving undefined for a captured step means the payload is the trimmed list shape and
  // the fetch is still in flight, which is a different state from a step that captured nothing.
  const pending = step.logCaptureStatus === "captured" && step.logs === undefined;
  const logMessage = pending
    ? logsError || (logsLoading ? "Loading console output…" : "Console output is unavailable.")
    : step.logCaptureStatus === "empty"
      ? "No follow-up log entries were captured."
      : "Console logs were unavailable when this command ran.";
  return (
    <article className={`scheduleRunStep ${step.status}`}>
      <header>
        <div>
          <span className="scheduleRunStepNumber">Step {step.stepIndex + 1}</span>
          <strong>{isCommand ? "Command" : "Restart action"}</strong>
        </div>
        <span className={`scheduleRunStepStatus ${step.status}`}>{step.status === "success" ? "Completed" : "Failed"}</span>
      </header>
      {isCommand ? <code>{step.command || "Command not recorded"}</code> : <p>Gracefully restart the Minecraft server.</p>}
      {step.delaySeconds > 0 && <small>Waited {formatRunDelay(step.delaySeconds)} before this step.</small>}
      {isCommand && (
        <details className="scheduleRunLogs">
          <summary>
            <span>Logs</span>
            <small>{logs.length ? `${logs.length} ${logs.length === 1 ? "entry" : "entries"}` : pending ? "Loading…" : "No entries"}</small>
            <AppIcon name="chevronDown" />
          </summary>
          {logs.length ? <pre>{logs.join("\n")}</pre> : <p>{logMessage}</p>}
        </details>
      )}
    </article>
  );
}

function formatRunDelay(seconds: number) {
  if (seconds % 3600 === 0) return `${seconds / 3600} ${seconds === 3600 ? "hour" : "hours"}`;
  if (seconds % 60 === 0) return `${seconds / 60} ${seconds === 60 ? "minute" : "minutes"}`;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
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

export function scheduleRunItems(schedules: ScheduledExecution[]): ScheduledRunPanelItem[] {
  const active = schedules.flatMap((schedule) => schedule.activeRuns ?? [])
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .map((run) => ({ ...run, kind: "active" as const, sortAt: run.startedAt }));
  const activeIds = new Set(active.map((run) => run.id));
  const completed = scheduleRuns(schedules)
    .filter((run) => !activeIds.has(run.id))
    .map((run) => ({ ...run, kind: "completed" as const, sortAt: run.ranAt }));
  return [...active, ...completed.slice(0, Math.max(8 - active.length, 0))];
}

/**
 * Identifies the runs feed by its contents rather than by the array holding them. The page refetches
 * app state on a timer and gets a fresh `schedules` array every time, so anything keyed on identity
 * fires on every poll; this key only changes when a run is added, removed, or advances.
 */
export function scheduleRunFeedKey(runItems: ScheduledRunPanelItem[]) {
  return runItems
    .map((run) => `${run.kind}:${run.id}:${run.kind === "active" ? run.waitingUntil ?? run.message ?? "" : run.ranAt}`)
    .join("|");
}

export function resolveScheduleNavigationTarget(schedules: ScheduledExecution[], target: ScheduleNavigationTarget) {
  if (target.kind === "schedule") {
    const schedule = schedules.find((candidate) => candidate.id === target.scheduleId);
    return schedule ? { kind: "schedule" as const, schedule } : undefined;
  }
  const run = scheduleRunItems(schedules).find((candidate) => candidate.id === target.runId && candidate.scheduleId === target.scheduleId);
  if (!run) return undefined;
  if (target.kind === "active-run" && run.kind === "active") return { kind: "active-run" as const, run };
  if (target.kind === "completed-run" && run.kind === "completed") return { kind: "completed-run" as const, run };
  return undefined;
}

export function scheduleDescription(schedule: ScheduledExecution) {
  const commands = schedule.steps.filter((step) => step.type === "command");
  const actions = schedule.steps.filter((step) => step.type === "action");
  const delayed = schedule.steps.filter((step) => step.delaySeconds > 0).length;
  const playerPolicy = schedule.waitForPlayersToLeave
    ? "waits until no players are online"
    : schedule.onlyWhenNoPlayers ? "skips while players are online" : "";
  if (schedule.steps.length > 1 || actions.length) {
    const parts = [commands.length ? `${commands.length} command${commands.length === 1 ? "" : "s"}` : "", actions.length ? `${actions.length} Restart action` : ""].filter(Boolean);
    const steps = `${parts.join(", ")}${delayed ? `, ${delayed} delayed` : ""}`;
    return playerPolicy ? `${steps} · ${playerPolicy}` : steps;
  }
  if (commands[0]?.type === "command") return playerPolicy ? `${commands[0].command} · ${playerPolicy}` : commands[0].command;
  return playerPolicy || "Console command automation";
}

/**
 * The row and the editor have to read the same expression the same way. A private summariser here
 * drifted from the editor's describer and printed raw cron fields back at the user, so the table
 * now shares the describer and only supplies the wording for an expression it cannot parse.
 */
function cronSummary(cron: string) {
  return describeCronExpression(cron) ?? "Invalid cron expression";
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

/**
 * Skipping is the expected outcome of two of the three player policies, so a skipped run must not
 * borrow the failure mark. Cancelled keeps the cross because the run really was stopped, and the
 * tone class separates it from a failure.
 */
function statusIcon(status?: string): "check" | "x" | "minus" {
  const tone = statusTone(status);
  if (tone === "success") return "check";
  if (tone === "failed" || tone === "cancelled") return "x";
  return "minus";
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

export function activeRunStatus(run: ScheduledActiveRun) {
  if (run.message === "Cancellation requested") return run.message;
  if (run.waitingUntil) return `Waiting ${remainingDelayLabel(run.waitingUntil)}`;
  if (!run.cancellable && run.message) return run.message;
  if (run.currentStepIndex !== undefined) return `Step ${run.currentStepIndex + 1} of ${run.stepCount}`;
  return run.message || "In progress";
}

function formatScheduleTime(value: string, formatDate: (value: string | number | Date) => string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return formatDate(date);
}

function pluralizedTime(value: number, unit: "minute" | "hour" | "day") {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

export function lastRunRelativeTime(value: string, now = Date.now()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const elapsedMs = Math.max(0, now - date.getTime());
  const minutes = Math.round(elapsedMs / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${pluralizedTime(minutes, "minute")} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${pluralizedTime(hours, "hour")} ago`;
  return `${pluralizedTime(Math.round(hours / 24), "day")} ago`;
}

export function nextRunRelativeTime(value: string, now = Date.now()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const remainingMs = date.getTime() - now;
  if (remainingMs <= 0) return "Due now";
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [
    days > 0 ? `${days}d` : "",
    hours > 0 ? `${hours}h` : "",
    minutes > 0 || (days === 0 && hours === 0) ? `${minutes}m` : ""
  ].filter(Boolean);
  return `in ${parts.join(" ")}`;
}

function relativeTime(value: string, now = Date.now()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const diffMs = date.getTime() - now;
  const absMs = Math.abs(diffMs);
  const minutes = Math.max(1, Math.round(absMs / 60_000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const label = days > 0
    ? `${days}d`
    : hours > 0
    ? `${Math.round(minutes / 60)}h`
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
