// Removing something puts it in Trash. There is no other way to remove it.
//
// The rule this file exists to make cheap: no code path may hard-DELETE a row
// that holds something the user typed. Deleting is stamping `deleted_at`, reads
// filter it out, and the Trash view reads the complement. Migration 0043 has the
// full reasoning; this is the half that runs.
//
// Two things are easy to get wrong by hand, so neither is left to the caller.
//
// CHILDREN. The foreign keys still say `on delete cascade`, and that clause now
// never fires, because nothing hard-deletes any more. A list whose items were
// not stamped explicitly would vanish from the board while its items stayed
// live — orphaned rows pointing at a parent no read can see. So the parent
// helpers stamp their children in the same call.
//
// THE TIMESTAMP. Parent and children share one exact value, and restore matches
// on it. That is what stops "restore this list" from also resurrecting the three
// items you deleted individually last month, and what makes "restore this list"
// bring back exactly the fourteen it took with it.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { writeError } from "@/lib/planner/write";

type Client = SupabaseClient<Database>;

/** Tables that hold user-authored content and therefore have a Trash.
 *
 * Kept as a value, not just a type: scripts/sanity-check-deletes.mjs reads this
 * list to decide which `.delete()` calls in the codebase are violations, so
 * adding a table here is what puts it under the rule. */
export const TRASHABLE = [
  "notes",
  "todo_items",
  "todo_lists",
  "lists",
  "list_items",
  "targets",
  "events",
  // A routine note EXPIRES on its own (0044) and that is not a delete — the row
  // stays live and merely stops being surfaced. It is here for the other way one
  // goes away: the chat removing it by fuzzy name match, which is precisely the
  // failure mode this list exists to make survivable.
  "routine_notes",
] as const;

export type TrashableTable = (typeof TRASHABLE)[number];

/** What a delete is about to destroy, so the confirmation can say it.
 *
 * "Delete this list and everything on it?" is not a question anyone can answer
 * — a list of two and a list of forty read the same. Counting first costs one
 * query and turns the prompt into a decision. */
export interface DeleteImpact {
  /** The thing itself, e.g. `Reading list`. */
  title: string;
  /** One line per category of collateral, e.g. `14 items` / `3 with booked hours`. */
  also: string[];
}

/** Turns an impact into the fields a confirmation dialog needs. Shared so every
 * one of these is worded the same way, and structured rather than pre-joined so
 * the consequences render as a list you can scan instead of a run-on string. */
export function describeImpact(impact: DeleteImpact): {
  title: string;
  lines: string[];
  footnote: string;
  confirmLabel: string;
} {
  return {
    title: `Move "${impact.title}" to Trash?`,
    lines: impact.also,
    footnote: "Nothing is destroyed — restore it from the Trash tab, and it comes back with everything listed here.",
    confirmLabel: "Move to Trash",
  };
}

/** A single row, no children. Returns null on success, a sentence on failure. */
export async function softDelete(
  supabase: Client,
  table: TrashableTable,
  id: string,
  what: string,
  stamp: string = new Date().toISOString(),
): Promise<string | null> {
  return writeError(
    what,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase.from(table) as any).update({ deleted_at: stamp }).eq("id", id).is("deleted_at", null),
  );
}

/** Restore, matching on the exact timestamp so a parent brings back only the
 * children it took with it. */
export async function restore(
  supabase: Client,
  table: TrashableTable,
  id: string,
  what: string,
): Promise<string | null> {
  return writeError(
    what,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase.from(table) as any).update({ deleted_at: null }).eq("id", id),
  );
}

/** A to-do list and every item on it, sharing one timestamp.
 *
 * Note what is NOT touched: the tasks and events an item had booked. Those are
 * separate rows on the calendar with their own Trash entries, and `todo_items`
 * points at them with `on delete set null` — a link, not ownership. The caller
 * decides whether the booked time goes too (TodoView does, because hours
 * belonging to a to-do you deleted are hours belonging to nothing). */
export async function softDeleteTodoList(
  supabase: Client,
  listId: string,
): Promise<string | null> {
  const stamp = new Date().toISOString();
  const itemsFailed = await writeError(
    "Couldn't move that list's items to Trash",
    supabase.from("todo_items").update({ deleted_at: stamp }).eq("list_id", listId).is("deleted_at", null),
  );
  if (itemsFailed) return itemsFailed;
  return softDelete(supabase, "todo_lists", listId, "Couldn't move that list to Trash", stamp);
}

/** Restores a to-do list and exactly the items that went with it. */
export async function restoreTodoList(
  supabase: Client,
  listId: string,
  stamp: string,
): Promise<string | null> {
  const itemsFailed = await writeError(
    "Couldn't restore that list's items",
    supabase.from("todo_items").update({ deleted_at: null }).eq("list_id", listId).eq("deleted_at", stamp),
  );
  if (itemsFailed) return itemsFailed;
  return restore(supabase, "todo_lists", listId, "Couldn't restore that list");
}

/** A keeping-track list and its items. Same shape as the to-do version; kept
 * separate because they are different tables with different children rather
 * than one generic helper taking four string parameters. */
export async function softDeleteList(supabase: Client, listId: string): Promise<string | null> {
  const stamp = new Date().toISOString();
  const itemsFailed = await writeError(
    "Couldn't move that list's items to Trash",
    supabase.from("list_items").update({ deleted_at: stamp }).eq("list_id", listId).is("deleted_at", null),
  );
  if (itemsFailed) return itemsFailed;
  return softDelete(supabase, "lists", listId, "Couldn't move that list to Trash", stamp);
}

export async function restoreList(
  supabase: Client,
  listId: string,
  stamp: string,
): Promise<string | null> {
  const itemsFailed = await writeError(
    "Couldn't restore that list's items",
    supabase.from("list_items").update({ deleted_at: null }).eq("list_id", listId).eq("deleted_at", stamp),
  );
  if (itemsFailed) return itemsFailed;
  return restore(supabase, "lists", listId, "Couldn't restore that list");
}

/** Counts what deleting a to-do list would take with it, including the booked
 * time — which is the part people forget is attached. */
export async function todoListImpact(
  supabase: Client,
  listId: string,
  title: string,
): Promise<DeleteImpact> {
  const { data } = await supabase
    .from("todo_items")
    .select("id,task_id,event_id")
    .eq("list_id", listId)
    .is("deleted_at", null);
  const items = data ?? [];
  const booked = items.filter((i) => i.task_id).length;
  const evented = items.filter((i) => i.event_id).length;
  const also: string[] = [];
  if (items.length) also.push(`${items.length} item${items.length === 1 ? "" : "s"}`);
  if (booked) also.push(`${booked} with booked hours on the calendar`);
  if (evented) also.push(`${evented} holding a slot as an event`);
  return { title, also };
}

export async function listImpact(
  supabase: Client,
  listId: string,
  title: string,
): Promise<DeleteImpact> {
  const { count } = await supabase
    .from("list_items")
    .select("id", { count: "exact", head: true })
    .eq("list_id", listId)
    .is("deleted_at", null);
  const n = count ?? 0;
  return { title, also: n ? [`${n} item${n === 1 ? "" : "s"}`] : [] };
}
