import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState
} from '@tanstack/react-table';
import type { ScheduleNavigationTarget, ScheduleStep, ScheduledActiveRun, ScheduledExecution, ScheduledRun, ScheduledRunStepDetails } from '../types';
import { AppIcon } from '../components/FileTypeIcon';
import { InlineState } from '../components/InlineState';
import { SortHeaderButton } from '../components/TableControls';
import { Button, EmptyState, PanelHeader, Toolbar } from '../components/UiPrimitives';
import { DialogSurface } from '../components/DialogSurface';
import { ActionMenu } from '../components/ActionMenu';
import { clientId } from '../utils/files';
import { validateCommandList, validateCronExpression } from '../utils/validation';
import { scheduleDelayParts, scheduleDelayToSeconds } from '../features/schedules/scheduleDelays';
import { describeCronExpression } from '../features/schedules/cronDescription';

type ScheduleFormMode =
  | { type: "create" }
  | { type: "edit"; schedule: ScheduledExecution };

type SchedulePatch = Pick<ScheduledExecution, "name" | "cron" | "steps" | "onlyWhenNoPlayers" | "enabled">;
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
  disabled,
  disabledReason,
  formatDate,
  relativeTimestamps = true,
  scheduleTimeZone,
  navigationTarget,
  onNavigationTargetHandled
}: {
  schedules: ScheduledExecution[];
  formatDate: (value: string | number | Date) => string;
  relativeTimestamps?: boolean;
  scheduleTimeZone: string;
  navigationTarget?: ScheduleNavigationTarget | null;
  onNavigationTargetHandled?: () => void;
  onCreate: (patch: SchedulePatch) => boolean | void | Promise<boolean | void>;
  onToggle: (schedule: ScheduledExecution) => void;
  onUpdate: (schedule: ScheduledExecution, patch: Partial<ScheduledExecution>) => boolean | Promise<boolean>;
  onDelete: (schedule: ScheduledExecution) => void;
  onRunNow: (schedule: ScheduledExecution) => boolean | Promise<boolean>;
  onCancelRun: (run: ScheduledActiveRun) => boolean | Promise<boolean>;
  disabled: boolean;
  disabledReason?: string;
}) {
  const [formMode, setFormMode] = useState<ScheduleFormMode | null>(null);
  const [stepDrafts, setStepDrafts] = useState<StepDraft[]>(() => [emptyStepDraft()]);
  const [formError, setFormError] = useState("");
  const [cronValue, setCronValue] = useState("");
  const [draggingStepId, setDraggingStepId] = useState<string | null>(null);
  const [stepReorderMessage, setStepReorderMessage] = useState("");
  const [selectedRun, setSelectedRun] = useState<ScheduledRun | null>(null);
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
    setCronValue(formMode.type === "edit" ? formMode.schedule.cron : "");
    setDraggingStepId(null);
    setStepReorderMessage("");
    draggingStepIdRef.current = null;
    dragPointerIdRef.current = null;
    stopStepAutoScroll();
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

  useEffect(() => {
    if (selectedRun && !runItems.some((run) => run.kind === "completed" && run.id === selectedRun.id)) {
      setSelectedRun(null);
    }
  }, [runItems, selectedRun]);

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
    const steps: ScheduleStep[] = stepDrafts.map((draft) => draft.type === "command"
      ? { type: "command", command: draft.command.trim(), delaySeconds: scheduleDelayToSeconds(draft.delayValue, draft.delayUnit) }
      : { type: "action", procedure: "restart", delaySeconds: scheduleDelayToSeconds(draft.delayValue, draft.delayUnit) });
    return {
      name: String(form.get("name") ?? "").trim(),
      cron: String(form.get("cron") ?? "").trim(),
      steps,
      onlyWhenNoPlayers: form.get("onlyWhenNoPlayers") === "on",
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
    const targetIndex = stepDrafts.findIndex((step) => step.id === targetId);
    if (targetIndex < 0 || movedId === targetId) return;
    setStepDrafts((steps) => {
      const reordered = reorderScheduleSteps(steps, movedId, targetId);
      stepDraftsRef.current = reordered;
      return reordered;
    });
    setStepReorderMessage(`Step moved to position ${targetIndex + 1}.`);
  }

  function moveDraggedStepAtPoint(clientX: number, clientY: number) {
    const movedId = draggingStepIdRef.current;
    const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-schedule-step-id]");
    const targetId = target?.dataset.scheduleStepId;
    if (!movedId || !targetId || movedId === targetId) return;
    setStepDrafts((steps) => {
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
  const cronError = cronValue.trim() ? validateCronExpression(cronValue) : null;
  const cronDescription = cronValue.trim() && !cronError ? describeCronExpression(cronValue) : null;

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
            <div className="scheduleTableBody" role="rowgroup">
              {scheduleRows.length ? scheduleRows.map((row) => {
                const schedule = row.original;
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
                      <strong>{schedule.name}</strong>
                      <small>{scheduleDescription(schedule)}</small>
                    </div>
                  </div>
                  <div className="scheduleCell" data-label="Schedule" role="cell">
                    <div className="scheduleCellValue">
                      <code>{schedule.cron}</code>
                      <small>{cronSummary(schedule.cron)}</small>
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
                            className={`scheduleStatusIcon ${statusTone(schedule.lastStatus) === "success" ? "success" : "failed"}`}
                            role="img"
                            aria-label={statusLabel(schedule.lastStatus)}
                            title={statusLabel(schedule.lastStatus)}
                          >
                            <AppIcon name={statusTone(schedule.lastStatus) === "success" ? "check" : "x"} />
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
                            id: "test-now",
                            label: "Test now",
                            icon: <AppIcon name="refresh" />,
                            onSelect: () => { void onRunNow(schedule); },
                            disabled,
                            title: disabled ? disabledReason || "Schedule testing is unavailable right now." : `Test ${schedule.name} now`
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
                        trigger={
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <circle cx="12" cy="5" r="1.7" />
                            <circle cx="12" cy="12" r="1.7" />
                            <circle cx="12" cy="19" r="1.7" />
                          </svg>
                        }
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
                    <strong>{run.scheduleName}</strong>
                    <small>{run.kind === "active" ? activeRunStatus(run) : statusLabel(run.status)}</small>
                    {run.kind === "active" && run.currentStep && (
                      <small className="scheduledRunAction">Step {(run.currentStepIndex ?? 0) + 1} of {run.stepCount}: {run.currentStep}</small>
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
                      <Button variant="secondary" compact className="scheduledRunDetailsButton" onClick={() => setSelectedRun(run)} aria-label={`View details for ${run.scheduleName}`}>
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
        <div className="modalBackdrop scheduleModalBackdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !saveRunning) setFormMode(null);
        }}>
          <DialogSurface className="modalPanel userModalPanel scheduleModalPanel" labelledBy="schedule-modal-title" onClose={() => { if (!saveRunning) setFormMode(null); }}>
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

                <section className="scheduleEditorSection" aria-labelledby="schedule-details-heading">
                  <div className="scheduleEditorSectionHeader">
                    <div><h3 id="schedule-details-heading">Details</h3><p>Name the automation and choose when it runs.</p></div>
                    <span className="scheduleEditorMeta">Timezone: {scheduleTimeZone}</span>
                  </div>
                  <div className="userModalFields scheduleEditFields">
                    <label>
                      Name
                      <input name="name" defaultValue={modalSchedule?.name ?? ""} placeholder="Nightly maintenance" required maxLength={80} />
                    </label>
                    <label className="scheduleCronField">
                      Cron schedule
                      <input
                        name="cron"
                        value={cronValue}
                        onChange={(event) => setCronValue(event.target.value)}
                        placeholder="0 4 * * *"
                        required
                        aria-invalid={Boolean(cronError)}
                        aria-describedby={cronError ? "schedule-cron-error" : cronDescription ? "schedule-cron-description" : undefined}
                        title={`Use five cron fields in ${scheduleTimeZone}: minute hour day month weekday.`}
                      />
                      {cronError
                        ? <span id="schedule-cron-error" className="fieldErrorBubble scheduleCronFeedback" role="tooltip">{cronError}</span>
                        : cronDescription && <span id="schedule-cron-description" className="scheduleCronFeedback valid">{cronDescription}</span>}
                    </label>
                  </div>
                </section>

                <section className="scheduleEditorSection" aria-labelledby="schedule-steps-heading">
                  <div className="scheduleEditorSectionHeader">
                    <div><h3 id="schedule-steps-heading">Steps</h3><p>Commands and lifecycle actions run from top to bottom. Drag the handles to reorder them.</p></div>
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
                            </div>
                            {stepDrafts.length > 1 && (
                              <Button variant="ghost" iconOnly compact className="iconDangerButton scheduleStepRemove" onClick={() => setStepDrafts((steps) => steps.filter((candidate) => candidate.id !== draft.id))} aria-label={`Remove step ${index + 1}`} title={`Remove step ${index + 1}`}>
                                <AppIcon name="x" />
                              </Button>
                            )}
                          </div>
                          <div className="scheduleStepFields">
                            <label className="scheduleStepType">
                              <span>Type</span>
                              <select value={draft.type} onChange={(event) => setStepDrafts((steps) => steps.map((step) => step.id === draft.id ? { ...step, type: event.target.value as StepDraft["type"] } : step))} aria-label={`Type for step ${index + 1}`}>
                                <option value="command">Command</option>
                                <option value="action">Action</option>
                              </select>
                            </label>
                            {draft.type === "command" ? (
                              <label className="scheduleStepValue">
                                <span>Command</span>
                                <input value={draft.command} onChange={(event) => setStepDrafts((steps) => steps.map((step) => step.id === draft.id ? { ...step, command: event.target.value } : step))} placeholder={index === 0 ? "say Restarting in 5 minutes" : "save-all"} required title="Use one console command per step." />
                              </label>
                            ) : (
                              <label className="scheduleStepValue">
                                <span>Procedure</span>
                                <select value={draft.procedure} onChange={() => undefined} aria-label={`Procedure for step ${index + 1}`}>
                                  <option value="restart">Restart</option>
                                </select>
                              </label>
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
                  </div>
                </section>

                <section className="scheduleEditorSection" aria-labelledby="schedule-options-heading">
                  <div className="scheduleEditorSectionHeader">
                    <div><h3 id="schedule-options-heading">Options</h3><p>Control when this automation is allowed to start.</p></div>
                  </div>
                  <div className="scheduleEditOptions">
                    <label className="scheduleOptionToggle">
                      <input name="onlyWhenNoPlayers" type="checkbox" defaultChecked={modalSchedule?.onlyWhenNoPlayers ?? false} />
                      <span className="scheduleOptionCopy"><strong>Only run when no players are online</strong><small>Skip this schedule while players are connected.</small></span>
                    </label>
                    <label className="scheduleOptionToggle">
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
        </div>
      )}

      {selectedRun && (
        <ScheduleRunDetailsDialog run={selectedRun} formatDate={formatDate} onClose={() => setSelectedRun(null)} />
      )}
    </section>
  );
}

export function ScheduleRunDetailsDialog({
  run,
  formatDate,
  onClose
}: {
  run: ScheduledRun;
  formatDate: (value: string | number | Date) => string;
  onClose: () => void;
}) {
  const steps = run.details?.steps;
  return (
    <div className="modalBackdrop scheduleModalBackdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <DialogSurface className="modalPanel scheduleRunModalPanel" labelledBy="schedule-run-modal-title" describedBy="schedule-run-modal-description" onClose={onClose}>
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
                {steps.map((step) => <ScheduleRunStep key={`${step.stepIndex}:${step.startedAt}`} step={step} />)}
              </div>
            )}
          </section>
        </div>
        <div className="userModalFooter scheduleRunModalFooter">
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </DialogSurface>
    </div>
  );
}

function ScheduleRunStep({ step }: { step: ScheduledRunStepDetails }) {
  const isCommand = step.type === "command";
  const logs = step.logs ?? [];
  const logMessage = step.logCaptureStatus === "empty"
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
            <small>{logs.length ? `${logs.length} ${logs.length === 1 ? "entry" : "entries"}` : "No entries"}</small>
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
  if (schedule.steps.length > 1 || actions.length) {
    const parts = [commands.length ? `${commands.length} command${commands.length === 1 ? "" : "s"}` : "", actions.length ? `${actions.length} Restart action` : ""].filter(Boolean);
    return `${parts.join(", ")}${delayed ? `, ${delayed} delayed` : ""}`;
  }
  if (commands[0]?.type === "command") return commands[0].command;
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
