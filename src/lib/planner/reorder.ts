// Putting things in the order you want them.
//
// `sort_order` has been on todo_lists, todo_items, lists and list_items since
// they were created (0021, 0025), indexed, and used as the primary key of every
// ORDER BY in both board views. Nothing ever WROTE it. So every row sat at 0 and
// the tie-break — created_at, or name — silently did all the work: the lists were
// in the order you happened to make them, permanently, and the only way to move
// something up was to delete it and retype it.
//
// This file is the write half. It is deliberately arithmetic only, with the
// database call at the end kept to one statement per moved row: reordering is the
// kind of thing that has to feel instant, and the alternative shapes (a fractional
// rank, a linked list of prev-ids) buy nothing at the scale of one person's to-do
// list and cost a migration plus a rebalancing routine.
//
// WHAT IS ORDERED IS THE WHOLE GROUP, NOT WHAT IS ON SCREEN. Both views filter
// before rendering — completed items hidden, hidden items hidden — so the visible
// rows are a subset. Assigning 0..n-1 across only the visible ones would give a
// hidden row an index that collides with a visible one and reshuffle the list the
// moment "show completed" was ticked. Every function here therefore takes the
// full group and moves within it, using the visible rows only to say WHERE.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { writeError } from "@/lib/planner/write";

/** Tables that carry a user-arranged order. */
export type OrderedTable = "todo_lists" | "todo_items" | "lists" | "list_items";

/** Which kind of thing is being dragged. Both views host two independent
 * orderings at once — the cards, and the rows inside each card — and dnd-kit
 * works off one flat id space, so the kind travels in the id. Without it,
 * dropping an item onto a list card would be indistinguishable from dropping it
 * onto a row. */
export type DragKind = "list" | "item";

export function dragId(kind: DragKind, id: string): string {
  return `${kind}:${id}`;
}

export function parseDragId(raw: string | number): { kind: DragKind; id: string } | null {
  const s = String(raw);
  const at = s.indexOf(":");
  if (at < 0) return null;
  const kind = s.slice(0, at);
  if (kind !== "list" && kind !== "item") return null;
  return { kind, id: s.slice(at + 1) };
}

/** Moves `activeId` to where `overId` currently sits, keeping everything else in
 * order. Returns null when the move is a no-op or either id isn't in the group —
 * which is also how a cross-list drag gets rejected, since the caller passes only
 * one list's rows.
 *
 * The insertion is "take it out, then put it back at the target's index", which
 * is what makes dragging down and dragging up both land where the pointer is
 * rather than one off in one of the two directions. */
export function moveWithin<T extends { id: string }>(rows: T[], activeId: string, overId: string): T[] | null {
  if (activeId === overId) return null;
  const from = rows.findIndex((r) => r.id === activeId);
  const to = rows.findIndex((r) => r.id === overId);
  if (from < 0 || to < 0) return null;
  const out = rows.slice();
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

/** The rows whose stored position no longer matches where they are, so only
 * those get written. On the very first reorder of a group that is everything
 * (they are all 0); afterwards it is just the span that shifted. */
export function changedSortOrders<T extends { id: string; sort_order: number }>(
  ordered: T[],
): { id: string; sort_order: number }[] {
  const out: { id: string; sort_order: number }[] = [];
  ordered.forEach((row, index) => {
    if (row.sort_order !== index) out.push({ id: row.id, sort_order: index });
  });
  return out;
}

/** Writes the new positions. One statement per changed row, in parallel, and the
 * first failure is the message — a half-applied order is still a valid order
 * (nothing is lost, the list just isn't where you put it), so this reports rather
 * than trying to roll back. */
export async function persistOrder(
  supabase: SupabaseClient<Database>,
  table: OrderedTable,
  updates: { id: string; sort_order: number }[],
): Promise<string | null> {
  if (!updates.length) return null;
  const results = await Promise.all(
    updates.map((u) =>
      writeError(
        "Couldn't save the new order",
        // Same cast as soft-delete.ts: a table name held in a variable defeats
        // the client's per-table generic resolution, which then types the
        // payload as `never`.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase.from(table) as any).update({ sort_order: u.sort_order }).eq("id", u.id),
      ),
    ),
  );
  return results.find((r) => r !== null) ?? null;
}

/** Where a NEW row goes: after everything already there.
 *
 * This is the other half of making `sort_order` real, and the easy half to miss.
 * The column defaults to 0, which was harmless while nothing wrote it and every
 * row tied — but once a list has been arranged by hand, a fresh row inserted at 0
 * lands at the TOP, above things deliberately put first. Adding "call the
 * plumber" should not displace whatever you decided was most important this
 * morning.
 *
 * Takes rows rather than querying so the UI can use what it already has in
 * state; the chat paths pass the rows they fetched to resolve the list. */
export function nextSortOrder(rows: { sort_order: number }[]): number {
  return rows.length ? Math.max(...rows.map((r) => r.sort_order)) + 1 : 0;
}

/** The whole reorder, since all four call sites do exactly this.
 *
 * Returns the reordered rows so the caller can show the new order immediately
 * rather than waiting for a refetch — dragging something and watching it snap
 * back for 300ms before reappearing where you put it reads as a failed drag. */
export async function applyReorder<T extends { id: string; sort_order: number }>(
  supabase: SupabaseClient<Database>,
  table: OrderedTable,
  group: T[],
  activeId: string,
  overId: string,
): Promise<{ ordered: T[]; error: string | null } | null> {
  const ordered = moveWithin(group, activeId, overId);
  if (!ordered) return null;
  const error = await persistOrder(supabase, table, changedSortOrders(ordered));
  return { ordered: ordered.map((row, index) => ({ ...row, sort_order: index })), error };
}
