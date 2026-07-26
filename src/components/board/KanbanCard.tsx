"use client";

// One task card — visual template borrowed from PlannerSidebar's note cards,
// category color applied the way Block.tsx treats calendar blocks.

import { categoryPalette } from "@/lib/scheduling/render";
import type { Category } from "@/lib/scheduling/types";
import type { RawScheduleRows } from "@/lib/scheduling/from-db";

export type TaskRow = RawScheduleRows["tasks"][number];

interface KanbanCardProps {
  task: TaskRow;
  category: Category | null;
}

export function KanbanCard({ task, category }: KanbanCardProps) {
  const palette = category ? categoryPalette(category.color) : null;
  const deadline = task.deadline_at ? new Date(task.deadline_at) : null;

  return (
    <div
      className="rounded-md border border-border bg-surface px-2.5 py-2"
      style={palette ? { borderLeft: `3px solid ${palette.border}` } : undefined}
    >
      <div className="flex items-baseline justify-between gap-1.5">
        <span className="text-[9px] tracking-wide uppercase text-muted-2">
          {category?.name ?? task.priority}
        </span>
        {task.important && (
          <span className="text-[9px] font-semibold" style={{ color: "#e0a94e" }} title="Marked important">
            ★
          </span>
        )}
      </div>
      <div className="text-[11.5px] text-text truncate" title={task.title}>
        {task.title}
      </div>
      <div className="mt-0.5 text-[10px] text-muted">
        {(task.duration_min / 60).toFixed(task.duration_min % 60 === 0 ? 0 : 1)}h
        {deadline && <> · due {deadline.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</>}
      </div>
    </div>
  );
}
