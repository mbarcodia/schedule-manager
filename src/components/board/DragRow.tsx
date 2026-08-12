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
  orientation = "vertical",
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
  /** Which way this group flows, which decides where the insertion line goes.
   * "vertical" = rows stacked down a column (a checklist), so the line is
   * horizontal, above or below. "horizontal" = cards flowing across a wrapping
   * grid, so the line is vertical, on the left or right edge. */
  orientation?: "vertical" | "horizontal";
  className?: string;
  children: (handle: React.ReactNode) => React.ReactNode;
}) {
  const composite = dragId(kind, id);
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    transform,
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
  /** Coming from an earlier position, so it will settle AFTER this row — which
   * puts the line on this row's far edge rather than its near one. */
  const fromEarlier = willAccept && (activeData?.index ?? 0) < index;

  const handle = (
    <button
      ref={setDragRef}
      {...attributes}
      {...listeners}
      aria-label="Reorder"
      title="Drag to reorder"
      // A fixed 16px box with the icon centred in it, rather than a bare 12px
      // SVG. An icon dropped straight into a flex row has no text baseline, so it
      // sat a pixel or two off from the checkbox and the first line of text and
      // every row read as slightly out of true. h-4 matches the line box these
      // rows use, so it lines up under both items-start and items-center.
      className="flex-none flex items-center justify-center h-4 w-3 text-muted-2 opacity-0 group-hover/drag:opacity-100 hover:text-text"
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
        // Follows the pointer. Omitting this was the whole of "the grab feels
        // weird": the row faded where it stood and nothing moved, so there was no
        // way to tell a started drag from a misfired click. Same treatment as
        // KanbanCard, and it must be paired with the raised z-index or the row
        // slides UNDER its neighbours.
        position: "relative",
        ...(transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 30 } : null),
        // Kept nearly opaque on purpose. At 0.4 the thing being dragged was
        // almost invisible exactly while it needed watching.
        opacity: isDragging ? 0.9 : 1,
      }}
    >
      {/* An element, not an inset box-shadow. A shadow on this wrapper is painted
         BEHIND its child, so any row whose content has an opaque background — a
         list card is `bg-panel` — hid the line completely. That is why the line
         showed for checklist rows and never for the cards. */}
      {willAccept && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            background: "var(--color-accent, #9184d9)",
            opacity: 0.5,
            borderRadius: 2,
            pointerEvents: "none",
            zIndex: 40,
            // Rows stack downward, so the gap is above or below. Cards flow
            // left-to-right in a wrapping grid, where a horizontal line would
            // point at the wrong seam entirely.
            // Offsets put the line IN the gap between rows rather than on top of
            // content: the checklist gap is 2px (gap-0.5) and the card gutter is
            // 12px (gap-3), so -2 fills the former and -7 centres it in the latter.
            ...(orientation === "vertical"
              ? { left: 0, right: 0, height: 2, ...(fromEarlier ? { bottom: -2 } : { top: -2 }) }
              : { top: 0, bottom: 0, width: 2, ...(fromEarlier ? { right: -7 } : { left: -7 }) }),
          }}
        />
      )}
      {children(handle)}
    </div>
  );
}
