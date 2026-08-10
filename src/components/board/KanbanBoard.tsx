"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { PlusIcon } from "@phosphor-icons/react";
import { KanbanCard, type TaskRow } from "./KanbanCard";
import { fetchTodoLinks, type TodoLink } from "@/lib/planner/todo-links";
import { KanbanColumn } from "./KanbanColumn";
import { deriveBoardStatuses, boardStatusFor, type BoardStatus } from "@/lib/planner/board-status";
import { DEFAULT_WIP_LIMIT } from "@/lib/planner/board-constants";
import {
  moveTaskToColumn,
  holdUntilNextWeek,
  setTaskImportant,
  setCommitmentImportant,
  setTaskArchived,
  type DroppableColumn,
} from "@/lib/planner/board-actions";
import { CommitmentCard } from "./CommitmentCard";
import { CommitmentPanelHost, NEW_COMMITMENT } from "./CommitmentPanel";
import { TaskPanel } from "./TaskPanel";
import { paceFromData, type CommitmentPace, type PaceStatus } from "@/lib/scheduling/pace";
import { whyNotCommitment, whyNotTask } from "@/lib/scheduling/why-not";
import { nowAbsMinute, startOfWeekMonday } from "@/lib/scheduling/time";
import { computeStreaks, type CommitmentStreak } from "@/lib/scheduling/streaks";
import { projectTotalMin } from "@/lib/scheduling/calibration";
import type { UseScheduleDataResult } from "@/hooks/useScheduleData";
import type { Category } from "@/lib/scheduling/types";

/** Columns read from reality rather than from a status anyone maintains: can this
 * be judged at all, has anything been logged, and does the work left fit the
 * time left at the current weekly rate.
 *
 * "Needs setup" is first deliberately. A commitment with no effort estimate or
 * no date cannot be judged, and its card names which input is missing and opens
 * the panel that sets it — putting it in the leftmost column makes the gap the
 * first thing seen rather than something inferred from an oddly empty board. */
const PACE_COLUMNS: { status: PaceStatus; title: string; subtitle?: string }[] = [
  { status: "unmeasurable", title: "Needs setup", subtitle: "no estimate or no date" },
  { status: "not_started", title: "Not started", subtitle: "nothing logged yet" },
  { status: "on_pace", title: "On pace", subtitle: "fits the time left" },
  { status: "slipping", title: "Slipping", subtitle: "more work left than time" },
  // Last, and its own column: things you are carrying but not doing belong out
  // of the four that describe live work, while still being in front of you.
  { status: "on_hold", title: "On hold", subtitle: "recorded, nothing scheduled" },
];

const TASK_COLUMNS: { status: BoardStatus; title: string; subtitle?: string }[] = [
  { status: "backlog", title: "Backlog" },
  { status: "this_week", title: "This Week" },
  { status: "in_progress", title: "In Progress" },
  { status: "done", title: "Done", subtitle: "from the calendar · clears each week" },
];

const DROPPABLE: ReadonlySet<string> = new Set(["backlog", "this_week", "in_progress"]);

interface KanbanBoardProps {
  scheduleData: UseScheduleDataResult;
  /** Fires after any board mutation (drop, star, archive) has been written. */
  onMutated?: () => void;
  /** Arriving from a calendar block: open this thing's panel once the board's
   * data has loaded. See lib/planner/board-links.ts. */
  focusTask?: string | null;
  focusCommitment?: string | null;
}

export function KanbanBoard({ scheduleData, onMutated, focusTask, focusCommitment }: KanbanBoardProps) {
  // Which of these tasks came from a to-do, so each card can link home.
  const [todoLinks, setTodoLinks] = useState<Map<string, TodoLink>>(new Map());
  useEffect(() => {
    void fetchTodoLinks().then(setTodoLinks);
  }, []);

  const { data, schedule, refresh } = scheduleData;
  const [notice, setNotice] = useState<string | null>(null);
  const [openCommitment, setOpenCommitment] = useState<string | null>(null);
  /** A task id being edited, "new" for a fresh one, null for closed. */
  const [openTask, setOpenTask] = useState<string | null>(null);
  /** The task just dropped into Backlog, if it is still being asked whether that
   * meant "later" or merely "less important". Cleared by either answer, and by
   * the next drop — a stale prompt on a card you've moved on from is noise. */
  const [justBacklogged, setJustBacklogged] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Open the linked panel once, when the data it needs has arrived.
  //
  // Guarded by a ref rather than by state because `data` is a NEW OBJECT after
  // every refresh: without it, saving the panel would close it and this would
  // immediately reopen it, which is a drawer you cannot get out of.
  //
  // The existence check is load-bearing, not defensive. TaskPanel treats a null
  // task as "new task", so a link to a deleted or archived row would silently
  // open a blank creation form; CommitmentPanelHost renders nothing for an
  // unresolved id, so that half would fail silently instead. Saying so is
  // better than either.
  const focusHandled = useRef(false);
  useEffect(() => {
    if (!data || focusHandled.current) return;
    if (!focusTask && !focusCommitment) return;
    focusHandled.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (focusCommitment && data.projects.some((p) => p.id === focusCommitment)) setOpenCommitment(focusCommitment);
    else if (focusTask && data.rawTasks.some((t) => t.id === focusTask)) setOpenTask(focusTask);
    else setNotice("That isn't on the board any more — it may have been archived or deleted. Try the Archive tab.");
  }, [data, focusTask, focusCommitment]);

  // Stable per mount, as Timeline does it — `new Date()` inside a data memo is
  // impure, never recomputes, and stops the React Compiler optimising the file.
  const now = useMemo(() => new Date(), []);

  // Commitments carry their own pace; "ahead" shares the On pace column with a
  // badge rather than getting one of its own, which would usually sit empty.
  const pace = useMemo<CommitmentPace[]>(() => (data ? paceFromData(data, now) : []), [data, now]);

  // Consistency and the phase-based projection, alongside pace. Both read from
  // the full work history rather than the visible fortnight.
  const extras = useMemo(() => {
    if (!data) return { streaks: new Map<string, CommitmentStreak>(), projected: new Map<string, number>() };
    const streaks = new Map(
      computeStreaks({
        logged: data.progressFacts.logged,
        commitments: data.projects.map((p) => ({
          id: p.id,
          // The remembered rate, or a paused commitment's whole history reads as
          // "nothing to measure against" — see streaks.ts heldSince.
          weeklyMinMin: p.weeklyMinMin ?? p.weeklyMinMinOnHold,
          createdAt: null,
          heldSince: p.onHoldAt ?? null,
        })),
        now,
      }).map((s) => [s.projectId, s]),
    );
    const projected = new Map<string, number>();
    for (const p of data.projects) {
      const mine = data.targets.filter((t) => t.projectId === p.id);
      const done = mine.filter((t) => t.completedAt).length;
      const proj = projectTotalMin(data.progressFacts.byProject[p.id] ?? 0, mine.length, done);
      if (proj != null) projected.set(p.id, proj);
    }
    return { streaks, projected };
  }, [data, now]);

  const paceColumn = (p: CommitmentPace): PaceStatus => (p.status === "ahead" ? "on_pace" : p.status);

  // Why something isn't scheduled, computed once for the whole board: each
  // answer reads the same inputs, and half-day room is a scan over every block.
  const whyNot = useMemo(() => {
    const byProject = new Map<string, ReturnType<typeof whyNotCommitment>>();
    const byTask = new Map<string, ReturnType<typeof whyNotTask>>();
    if (!data || !schedule) return { byProject, byTask };
    const ctx = {
      inputs: data.inputs,
      schedule,
      categories: data.categories,
      weekStart: startOfWeekMonday(now),
      nowAbs: nowAbsMinute(data.inputs.timezone, now),
    };
    for (const p of data.projects) byProject.set(p.id, whyNotCommitment(p, ctx));
    for (const t of data.inputs.tasks) byTask.set(t.id, whyNotTask(t, ctx));
    return { byProject, byTask };
  }, [data, schedule, now]);


  const grouped = useMemo(() => {
    const groups: Record<BoardStatus, TaskRow[]> = { backlog: [], this_week: [], in_progress: [], done: [] };
    if (!data || !schedule) return groups;
    const index = deriveBoardStatuses(schedule);
    // Tasks linked to a commitment appear under it above, so showing them here
    // too would double-count the board.
    for (const t of data.rawTasks) {
      if (t.project_id) continue;
      groups[boardStatusFor(index, t.id)].push(t);
    }
    return groups;
  }, [data, schedule]);

  const categoriesById = useMemo(() => {
    const map: Record<string, Category> = {};
    for (const c of data?.categories ?? []) map[c.id] = c;
    return map;
  }, [data]);

  /** A commitment wears its label's colour on the left edge, as its tasks do.
   * Declared after categoriesById on purpose: closing over a const declared
   * further down defeats the React Compiler and it skips the whole file. */
  const commitmentColor = (projectId: string): string | null => {
    const labelId = data?.projects.find((p) => p.id === projectId)?.categoryId;
    return labelId ? (categoriesById[labelId]?.color ?? null) : null;
  };

  if (!data || !schedule) {
    return <div className="px-5 py-4 text-[12px] text-muted">Loading…</div>;
  }

  const wipCount = grouped.in_progress.length;

  async function handleDragEnd(event: DragEndEvent) {
    const targetCol = event.over?.id != null ? String(event.over.id) : null;
    const task = data?.rawTasks.find((t) => t.id === event.active.id);
    if (!targetCol || !task) return;
    if (targetCol === "done") {
      setNotice("Done can't be dragged into — check blocks off from the calendar, so your logged hours stay real.");
      return;
    }
    if (!DROPPABLE.has(targetCol)) return;
    setNotice(null);
    setJustBacklogged(targetCol === "backlog" ? String(task.id) : null);
    if (targetCol === "in_progress" && wipCount >= DEFAULT_WIP_LIMIT) {
      setNotice(`Heads up: ${wipCount + 1} tasks in progress exceeds your WIP limit of ${DEFAULT_WIP_LIMIT} — consider parking something first.`);
    }
    const moveError = await moveTaskToColumn(task, targetCol as DroppableColumn, data?.rawTasks ?? []);
    if (moveError) {
      // The card has already snapped back by now; without this it did so in
      // silence, which reads as the board simply refusing the drag.
      setNotice(`That didn't move: ${moveError}`);
      return;
    }
    await refresh();
    onMutated?.();
  }

  async function handleToggleImportant(task: TaskRow) {
    const message = await setTaskImportant(task.id, !task.important);
    if (message) return setNotice(`Couldn't change that: ${message}`);
    await refresh();
    onMutated?.();
  }

  async function handleToggleCommitmentImportant(projectId: string, next: boolean) {
    const message = await setCommitmentImportant(projectId, next);
    if (message) return setNotice(`Couldn't change that: ${message}`);
    await refresh();
    onMutated?.();
  }

  async function handleHoldUntilNextWeek(taskId: string) {
    setJustBacklogged(null);
    const error = await holdUntilNextWeek(taskId);
    if (error) {
      setNotice(`Couldn't hold that back: ${error}`);
      return;
    }
    await refresh();
    onMutated?.();
  }

  async function handleArchive(task: TaskRow) {
    const message = await setTaskArchived(task.id, true);
    if (message) return setNotice(`Couldn't archive that: ${message}`);
    await refresh();
    onMutated?.();
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {notice && (
        <div className="flex-none px-4 py-2 text-[11px] border-b border-border" style={{ color: "#e0a94e" }}>
          {notice}
          <button onClick={() => setNotice(null)} className="ml-2 text-muted-2 hover:text-text">
            dismiss
          </button>
        </div>
      )}
      {/* Commitments first: the thing being kept up with. Tasks are pieces of one,
         and sit under it — or in the task columns below when they belong to none. */}
      <div className="flex-none flex items-baseline justify-between px-3 py-1.5 border-b border-border">
        <span className="text-[10px] tracking-wide uppercase text-muted-2 font-medium">Commitments</span>
        <button
          onClick={() => setOpenCommitment(NEW_COMMITMENT)}
          className="flex items-center gap-1 text-[10.5px] text-muted-2 hover:text-text"
        >
          <PlusIcon size={11} /> new commitment
        </button>
      </div>
      <div className="flex-none flex min-h-0 max-h-[46%] overflow-y-auto divide-x divide-border border-b border-border">
        {PACE_COLUMNS.map(({ status, title, subtitle }) => {
          const here = pace.filter((p) => paceColumn(p) === status);
          return (
            <KanbanColumn
              key={status}
              id={`pace-${status}`}
              title={title}
              subtitle={subtitle}
              count={here.length}
              warn={status === "slipping" && here.length > 0}
            >
              {here.map((p) => (
                <CommitmentCard
                  key={p.projectId}
                  pace={p}
                  streak={extras.streaks.get(p.projectId) ?? null}
                  projectedTotalMin={extras.projected.get(p.projectId) ?? null}
                  color={commitmentColor(p.projectId)}
                  targetCount={data.targets.filter((t) => t.projectId === p.projectId).length}
                  whyNot={whyNot.byProject.get(p.projectId) ?? null}
                  onToggleImportant={() => void handleToggleCommitmentImportant(p.projectId, !p.important)}
                  onOpen={() => setOpenCommitment(p.projectId)}
                >
                  {data.rawTasks
                    .filter((t) => t.project_id === p.projectId)
                    .map((t) => (
                      <KanbanCard
                        key={t.id}
                        task={t}
                        category={t.category_id ? (categoriesById[t.category_id] ?? null) : null}
                        todoLink={todoLinks.get(t.id) ?? null}
                        onToggleImportant={handleToggleImportant}
                        onArchive={handleArchive}
                        onOpen={(task) => setOpenTask(task.id)}
                        whyNot={whyNot.byTask.get(t.id) ?? null}
                      />
                    ))}
                </CommitmentCard>
              ))}
              {here.length === 0 && <div className="px-1 text-[10.5px] text-muted-2">empty</div>}
            </KanbanColumn>
          );
        })}
      </div>

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex-1 flex min-h-0 divide-x divide-border">
          {TASK_COLUMNS.map(({ status, title, subtitle }) => (
            <KanbanColumn
              key={status}
              id={status}
              title={title}
              subtitle={subtitle}
              count={grouped[status].length}
              warn={status === "in_progress" && wipCount > DEFAULT_WIP_LIMIT}
              badge={status === "in_progress" ? `${wipCount}/${DEFAULT_WIP_LIMIT}` : undefined}
            >
              {status === "backlog" && (
                <button
                  onClick={() => setOpenTask("new")}
                  className="self-start flex items-center gap-1 px-1 pb-0.5 text-[10.5px] text-muted-2 hover:text-text"
                >
                  <PlusIcon size={11} /> new task
                </button>
              )}
              {grouped[status].map((t) => (
                <div key={t.id} className="flex flex-col">
                  <KanbanCard
                    task={t}
                    category={t.category_id ? (categoriesById[t.category_id] ?? null) : null}
                    todoLink={todoLinks.get(t.id) ?? null}
                    draggable
                    onToggleImportant={handleToggleImportant}
                    onArchive={handleArchive}
                    onOpen={(task) => setOpenTask(task.id)}
                    whyNot={whyNot.byTask.get(t.id) ?? null}
                  />
                  {/* Backlog means two different things and the drop can't tell
                     them apart: "below the rest" leaves the engine free to place
                     this if the week has room, which is usually right and is
                     sometimes exactly what you were trying to prevent. */}
                  {justBacklogged === t.id && (
                    <div className="mt-1 rounded-md border border-accent bg-panel px-2 py-1.5 flex flex-col gap-1">
                      <div className="text-[10.5px] text-muted leading-snug">
                        Sent to the back — it can still be scheduled this week if there&apos;s room.
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => void handleHoldUntilNextWeek(t.id)}
                          className="rounded border border-accent text-accent px-1.5 py-0.5 text-[10.5px] hover:bg-accent/10"
                        >
                          not before next week
                        </button>
                        <button
                          onClick={() => setJustBacklogged(null)}
                          className="text-[10.5px] text-muted-2 hover:text-text"
                        >
                          that&apos;s fine
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {grouped[status].length === 0 && <div className="px-1 text-[10.5px] text-muted-2">empty</div>}
            </KanbanColumn>
          ))}
        </div>
      </DndContext>

      <CommitmentPanelHost
        data={data}
        pace={pace}
        openId={openCommitment}
        onClose={() => setOpenCommitment(null)}
        onSaved={async () => {
          await refresh();
          onMutated?.();
        }}
      />

      {openTask && (
        <TaskPanel
          task={openTask === "new" ? null : (data.rawTasks.find((t) => t.id === openTask) ?? null)}
          projects={data.projects}
          categories={data.categories}
          whyNot={openTask ? (whyNot.byTask.get(openTask) ?? null) : null}
          onClose={() => setOpenTask(null)}
          onSaved={async () => {
            await refresh();
            onMutated?.();
          }}
        />
      )}
    </div>
  );
}
