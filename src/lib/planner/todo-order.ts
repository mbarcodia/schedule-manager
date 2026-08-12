// What order a to-do list is in.
//
// One helper, called by the board and by the chat's list_todos, because the thing
// that must never happen is the two disagreeing: asking "what's on my Reviews
// list" and getting a different order from the one on screen makes both answers
// untrustworthy. The rule is a mixed one (a nulls-last date sort followed by a
// manual sort), which is exactly why it lives here in TypeScript instead of half
// in an ORDER BY — see migration 0045.

import type { Database } from "@/lib/supabase/database.types";

export type TodoSortMode = Database["public"]["Tables"]["todo_lists"]["Row"]["sort_mode"];

/** The two orders, with the wording the UI and the chat both use. Kept as data so
 * a control can render them without restating the vocabulary. */
export const TODO_SORT_MODES: { id: TodoSortMode; label: string; hint: string }[] = [
  { id: "manual", label: "in the order I arrange them", hint: "drag any item to move it" },
  { id: "due", label: "by due date, soonest first", hint: "undated items last, and those you can still drag" },
];

export function describeSortMode(mode: TodoSortMode): string {
  return TODO_SORT_MODES.find((m) => m.id === mode)?.label ?? mode;
}

type Sortable = { due_at: string | null; sort_order: number; created_at: string };

/** Position within a hand-arranged run. `sort_order` first, creation time as the
 * tie-break — which is what every row falls back to until something writes an
 * order, and matches what the board's own query asks for. */
function manualCmp(a: Sortable, b: Sortable): number {
  return a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at);
}

/** The list in the order it should be displayed and read back.
 *
 * Returns a new array; the input is not touched, since callers hold these in
 * React state. In 'due' mode a DATED item's `sort_order` is deliberately ignored
 * rather than cleared — switching the list back to 'manual' then restores
 * whatever arrangement it had before, instead of having quietly destroyed it. */
export function sortTodoItems<T extends Sortable>(items: T[], mode: TodoSortMode): T[] {
  if (mode !== "due") return items.slice().sort(manualCmp);
  const dated = items.filter((i) => i.due_at != null);
  const undated = items.filter((i) => i.due_at == null);
  // Soonest first. The date comparison is on the stored timestamp, so an all-day
  // item (which holds the end of its day) sorts after a timed item on the same
  // date — correct: "any time on the 14th" is a later commitment than "2pm on
  // the 14th".
  dated.sort((a, b) => a.due_at!.localeCompare(b.due_at!) || manualCmp(a, b));
  undated.sort(manualCmp);
  return [...dated, ...undated];
}

/** Can this item be dragged, given its list's mode?
 *
 * In 'due' mode a dated item's position is decided by its date, so offering a
 * handle would be offering a control that does nothing — the specific failure
 * this codebase keeps finding. Undated items keep theirs, because dates cannot
 * order them. */
export function canDragTodo(item: { due_at: string | null }, mode: TodoSortMode): boolean {
  return mode !== "due" || item.due_at == null;
}

/** The rows a reorder is allowed to rearrange: the hand-arranged run the dragged
 * item belongs to. In 'due' mode that is the undated tail only, so a drag can
 * never renumber rows whose order is owned by their dates. */
export function reorderableGroup<T extends Sortable>(items: T[], mode: TodoSortMode): T[] {
  const scoped = mode === "due" ? items.filter((i) => i.due_at == null) : items;
  return scoped.slice().sort(manualCmp);
}
