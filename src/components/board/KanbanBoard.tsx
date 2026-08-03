"use client";

import { useEffect, useMemo, useState } from "react";
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { KanbanCard, type TaskRow } from "./KanbanCard";
import { fetchTodoLinks, type TodoLink } from "@/lib/planner/todo-links";
import { KanbanColumn } from "./KanbanColumn";
import { deriveBoardStatuses, boardStatusFor, type BoardStatus } from "@/lib/planner/board-status";
import { DEFAULT_WIP_LIMIT } from "@/lib/planner/board-constants";
import { moveTaskToColumn, setTaskImportant, setTaskArchived, type DroppableColumn } from "@/lib/planner/board-actions";
import type { UseScheduleDataResult } from "@/hooks/useScheduleData";
import type { Category } from "@/lib/scheduling/types";

const COLUMNS: { status: BoardStatus; title: string; subtitle?: string }[] = [
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
}

export function KanbanBoard({ scheduleData, onMutated }: KanbanBoardProps) {
  // Which of these tasks came from a to-do, so each card can link home.
  const [todoLinks, setTodoLinks] = useState<Map<string, TodoLink>>(new Map());
  useEffect(() => {
    void fetchTodoLinks().then(setTodoLinks);
  }, []);

  const { data, schedule, refresh } = scheduleData;
  const [notice, setNotice] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const grouped = useMemo(() => {
    const groups: Record<BoardStatus, TaskRow[]> = { backlog: [], this_week: [], in_progress: [], done: [] };
    if (!data || !schedule) return groups;
    const index = deriveBoardStatuses(schedule);
    for (const t of data.rawTasks) groups[boardStatusFor(index, t.id)].push(t);
    return groups;
  }, [data, schedule]);

  const categoriesById = useMemo(() => {
    const map: Record<string, Category> = {};
    for (const c of data?.categories ?? []) map[c.id] = c;
    return map;
  }, [data]);

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
    if (targetCol === "in_progress" && wipCount >= DEFAULT_WIP_LIMIT) {
      setNotice(`Heads up: ${wipCount + 1} tasks in progress exceeds your WIP limit of ${DEFAULT_WIP_LIMIT} — consider parking something first.`);
    }
    await moveTaskToColumn(task, targetCol as DroppableColumn, data?.rawTasks ?? []);
    await refresh();
    onMutated?.();
  }

  async function handleToggleImportant(task: TaskRow) {
    await setTaskImportant(task.id, !task.important);
    await refresh();
    onMutated?.();
  }

  async function handleArchive(task: TaskRow) {
    await setTaskArchived(task.id, true);
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
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex-1 flex min-h-0 divide-x divide-border">
          {COLUMNS.map(({ status, title, subtitle }) => (
            <KanbanColumn
              key={status}
              id={status}
              title={title}
              subtitle={subtitle}
              count={grouped[status].length}
              warn={status === "in_progress" && wipCount > DEFAULT_WIP_LIMIT}
              badge={status === "in_progress" ? `${wipCount}/${DEFAULT_WIP_LIMIT}` : undefined}
            >
              {grouped[status].map((t) => (
                <KanbanCard
                  key={t.id}
                  task={t}
                  category={t.category_id ? (categoriesById[t.category_id] ?? null) : null}
                  todoLink={todoLinks.get(t.id) ?? null}
                  draggable
                  onToggleImportant={handleToggleImportant}
                  onArchive={handleArchive}
                />
              ))}
              {grouped[status].length === 0 && <div className="px-1 text-[10.5px] text-muted-2">empty</div>}
            </KanbanColumn>
          ))}
        </div>
      </DndContext>
    </div>
  );
}
