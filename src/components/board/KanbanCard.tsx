"use client";

// One task card — visual template borrowed from PlannerSidebar's note cards,
// category color applied the way Block.tsx treats calendar blocks.

import Link from "next/link";
import { useDraggable } from "@dnd-kit/core";
import { categoryPalette } from "@/lib/scheduling/render";
import { todoItemHref, type TodoLink } from "@/lib/planner/todo-links";
import type { Category } from "@/lib/scheduling/types";
import type { RawScheduleRows } from "@/lib/scheduling/from-db";

export type TaskRow = RawScheduleRows["tasks"][number];

interface KanbanCardProps {
  task: TaskRow;
  category: Category | null;
  /** Present when the card sits in a drag-enabled view. */
  draggable?: boolean;
  /** Set when this work came from a to-do, so the card can link back to it. */
  todoLink?: TodoLink | null;
  onToggleImportant?: (task: TaskRow) => void;
  onArchive?: (task: TaskRow) => void;
}

export function KanbanCard({
  task,
  category,
  draggable = false,
  todoLink,
  onToggleImportant,
  onArchive,
}: KanbanCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    disabled: !draggable,
  });
  const palette = category ? categoryPalette(category.color) : null;
  const deadline = task.deadline_at ? new Date(task.deadline_at) : null;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className="rounded-md border border-border bg-surface px-2.5 py-2 group"
      style={{
        ...(palette ? { borderLeft: `3px solid ${palette.border}` } : undefined),
        ...(transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 30, position: "relative" } : undefined),
        opacity: isDragging ? 0.85 : 1,
        cursor: draggable ? "grab" : undefined,
        touchAction: "none",
      }}
    >
      <div className="flex items-baseline justify-between gap-1.5">
        <span className="text-[9px] tracking-wide uppercase text-muted-2">
          {category?.name ?? task.priority}
        </span>
        <span className="flex items-baseline gap-1.5">
          {onArchive && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onArchive(task);
              }}
              onPointerDown={(e) => e.stopPropagation()}
              title="Archive (keeps its history; restore anytime from the Archive view)"
              className="text-[9px] text-muted-2 opacity-0 group-hover:opacity-100 hover:text-text transition-opacity"
            >
              archive
            </button>
          )}
          {onToggleImportant ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleImportant(task);
              }}
              onPointerDown={(e) => e.stopPropagation()}
              title={task.important ? "Unmark important" : "Mark important (Eisenhower)"}
              className="text-[10px] leading-none"
              style={{ color: task.important ? "#e0a94e" : "var(--color-muted-2, #75798c)" }}
            >
              {task.important ? "★" : "☆"}
            </button>
          ) : (
            task.important && (
              <span className="text-[9px] font-semibold" style={{ color: "#e0a94e" }} title="Marked important">
                ★
              </span>
            )
          )}
        </span>
      </div>
      <div className="text-[11.5px] text-text truncate" title={task.title}>
        {task.title}
      </div>
      <div className="mt-0.5 text-[10px] text-muted">
        {(task.duration_min / 60).toFixed(task.duration_min % 60 === 0 ? 0 : 1)}h
        {deadline && <> · due {deadline.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</>}
      </div>
      {todoLink && (
        // Its date, reminders and notes live on the to-do, not here — so say
        // where they are rather than duplicating them onto the card.
        <Link
          href={todoItemHref(todoLink.itemId)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="mt-0.5 block text-[9.5px] text-muted-2 hover:text-accent-text truncate"
          title={`Open this on your ${todoLink.listName} to-do list`}
        >
          ↗ on your {todoLink.listName} list
        </Link>
      )}
    </div>
  );
}
