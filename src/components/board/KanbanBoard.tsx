"use client";

import { useMemo } from "react";
import { KanbanCard, type TaskRow } from "./KanbanCard";
import { KanbanColumn } from "./KanbanColumn";
import { deriveBoardStatuses, boardStatusFor, type BoardStatus } from "@/lib/planner/board-status";
import { DEFAULT_WIP_LIMIT } from "@/lib/planner/board-constants";
import type { UseScheduleDataResult } from "@/hooks/useScheduleData";
import type { Category } from "@/lib/scheduling/types";

const COLUMNS: { status: BoardStatus; title: string; subtitle?: string }[] = [
  { status: "backlog", title: "Backlog" },
  { status: "this_week", title: "This Week" },
  { status: "in_progress", title: "In Progress" },
  { status: "done", title: "Done", subtitle: "from the calendar · clears each week" },
];

export function KanbanBoard({ scheduleData }: { scheduleData: UseScheduleDataResult }) {
  const { data, schedule } = scheduleData;

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

  return (
    <div className="flex-1 flex min-h-0 divide-x divide-border">
      {COLUMNS.map(({ status, title, subtitle }) => (
        <KanbanColumn
          key={status}
          title={title}
          subtitle={subtitle}
          count={grouped[status].length}
          warn={status === "in_progress" && wipCount > DEFAULT_WIP_LIMIT}
          badge={status === "in_progress" ? `${wipCount}/${DEFAULT_WIP_LIMIT}` : undefined}
        >
          {grouped[status].map((t) => (
            <KanbanCard key={t.id} task={t} category={t.category_id ? (categoriesById[t.category_id] ?? null) : null} />
          ))}
          {grouped[status].length === 0 && <div className="px-1 text-[10.5px] text-muted-2">empty</div>}
        </KanbanColumn>
      ))}
    </div>
  );
}
