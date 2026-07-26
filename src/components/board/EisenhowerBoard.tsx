"use client";

// Eisenhower 2×2 — same cards as the kanban view (star toggle moves tasks
// between the important/not-important rows; "urgent" follows deadlines).

import { useMemo } from "react";
import { KanbanCard, type TaskRow } from "./KanbanCard";
import { setTaskImportant, setTaskArchived } from "@/lib/planner/board-actions";
import { quadrantFor, type Quadrant } from "@/lib/planner/eisenhower";
import { URGENT_THRESHOLD_DAYS } from "@/lib/planner/board-constants";
import type { UseScheduleDataResult } from "@/hooks/useScheduleData";
import type { Category } from "@/lib/scheduling/types";

const QUADRANTS: { id: Quadrant; title: string; hint: string }[] = [
  { id: "do", title: "Do", hint: "urgent · important" },
  { id: "schedule", title: "Schedule", hint: "not urgent · important" },
  { id: "delegate", title: "Delegate / Do quick", hint: "urgent · not important" },
  { id: "eliminate", title: "Reconsider", hint: "not urgent · not important" },
];

interface EisenhowerBoardProps {
  scheduleData: UseScheduleDataResult;
  onMutated?: () => void;
}

export function EisenhowerBoard({ scheduleData, onMutated }: EisenhowerBoardProps) {
  const { data, refresh } = scheduleData;

  const grouped = useMemo(() => {
    const groups: Record<Quadrant, TaskRow[]> = { do: [], schedule: [], delegate: [], eliminate: [] };
    if (!data) return groups;
    for (const t of data.rawTasks) groups[quadrantFor(t, data.inputs.timezone)].push(t);
    return groups;
  }, [data]);

  const categoriesById = useMemo(() => {
    const map: Record<string, Category> = {};
    for (const c of data?.categories ?? []) map[c.id] = c;
    return map;
  }, [data]);

  if (!data) return <div className="px-5 py-4 text-[12px] text-muted">Loading…</div>;

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
    <div className="flex-1 min-h-0 overflow-y-auto p-3">
      <div className="text-[10.5px] text-muted-2 px-1 pb-2">
        ★ marks a task important. Urgent = deadline within {URGENT_THRESHOLD_DAYS} days.
      </div>
      <div className="grid grid-cols-2 gap-3" style={{ minHeight: "70%" }}>
        {QUADRANTS.map((q) => (
          <div key={q.id} className="rounded-lg border border-border bg-panel flex flex-col min-h-[160px]">
            <div className="flex-none px-3 py-2 border-b border-border flex items-baseline justify-between">
              <span className="text-[10px] tracking-wide uppercase text-muted-2 font-medium">{q.title}</span>
              <span className="text-[9px] text-muted-2">{q.hint}</span>
            </div>
            <div className="flex-1 p-2 flex flex-col gap-1.5">
              {grouped[q.id].map((t) => (
                <KanbanCard
                  key={t.id}
                  task={t}
                  category={t.category_id ? (categoriesById[t.category_id] ?? null) : null}
                  onToggleImportant={handleToggleImportant}
                  onArchive={handleArchive}
                />
              ))}
              {grouped[q.id].length === 0 && <div className="px-1 text-[10.5px] text-muted-2">empty</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
