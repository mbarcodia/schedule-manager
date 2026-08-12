"use client";

// A row you can pick up, and a row you can drop onto — the same row.
//
// Shared by the To-Do and Lists views, which each host two orderings (the cards,
// and the rows inside a card) and want them to behave identically.
//
// WHY A HANDLE AND NOT THE WHOLE ROW. KanbanCard puts the drag listeners on the
// card itself and stops propagation on each button, which works there because a
// task card is mostly a label. These rows are not: they hold a checkbox, an
// expander that opens a whole editing panel, a hide button and a delete button,
// and the text itself is worth selecting with the mouse. Listeners on the row
// would make all of that feel broken — you'd start a drag every time you went to
// tick something off. So the handle is its own small target, revealed on hover so
// a list at rest stays clean.
//
// WHY THE HANDLE IS A RENDER PROP. The two callers need it in different places: a
// checklist row wants it to the left of the checkbox, a list CARD wants it in its
// own header next to the title, and a handle floated outside a grid card looks
// like a mistake. So this component owns the drag/drop wiring and hands the
// handle back to be placed.
//
// WHY EVERY ROW IS ALSO A DROP TARGET. dnd-kit's core has no sortable primitive
// (@dnd-kit/sortable is a separate package this app doesn't carry), so "insert
// here" is expressed as "the row you are over is the position you want". That is
// the whole model: drop onto a row, take its place. The line on the near edge is
// what has to make it obvious.

import { useDraggable, useDroppable } from "@dnd-kit/core";
import { DotsSixVerticalIcon } from "@phosphor-icons/react";
import { dragId, parseDragId, type DragKind } from "@/lib/planner/reorder";

export function DragRow({
  kind,
  id,
  index,
  group,
  className,
  children,
}: {
  kind: DragKind;
  id: string;
  /** Position in the VISIBLE list, used only to decide which edge the insertion
   * line goes on. The ordering itself is computed over the full group, including
   * rows filtered out of view — see reorder.ts. */
  index: number;
  /** Rows in different groups must not accept each other. Two lists' items share
   * one id space, so without this you could drop a to-do onto another list's row
   * and it would silently reorder nothing. */
  group: string;
  className?: string;
  children: (handle: React.ReactNode) => React.ReactNode;
}) {
  const composite = dragId(kind, id);
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id: composite, data: { kind, group, index } });
  const { setNodeRef: setDropRef, isOver, active } = useDroppable({ id: composite, data: { kind, group, index } });

  const activeData = active?.data.current as { kind?: DragKind; group?: string; index?: number } | undefined;
  // Only light up for a drag that could actually land here: same kind, same
  // group, and not the row being dragged.
  const willAccept =
    isOver &&
    !!activeData &&
    activeData.kind === kind &&
    activeData.group === group &&
    parseDragId(active!.id)?.id !== id;
  const fromAbove = willAccept && (activeData?.index ?? 0) < index;

  const handle = (
    <button
      ref={setDragRef}
      {...attributes}
      {...listeners}
      aria-label="Reorder"
      title="Drag to reorder"
      className="flex-none text-muted-2 opacity-0 group-hover/drag:opacity-100 hover:text-text"
      style={{ cursor: "grab", touchAction: "none" }}
    >
      <DotsSixVerticalIcon size={12} />
    </button>
  );

  return (
    <div
      ref={setDropRef}
      className={`group/drag ${className ?? ""}`}
      style={{
        opacity: isDragging ? 0.4 : 1,
        // A line on the edge the row will arrive at, rather than a box around the
        // target — "it goes here" instead of "this one is selected".
        boxShadow: willAccept
          ? fromAbove
            ? "inset 0 -2px 0 0 var(--color-accent, #9184d9)"
            : "inset 0 2px 0 0 var(--color-accent, #9184d9)"
          : undefined,
      }}
    >
      {children(handle)}
    </div>
  );
}
