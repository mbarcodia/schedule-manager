// Emptying the Trash. The only place in the app that destroys anything.
//
// It exists because a Trash you cannot empty is just a slower way of keeping
// everything, and someone who deletes a note with a password in it means it.
// Everything about it is built to be hard to reach by accident and impossible to
// reach by mistake:
//
//   - it only ever touches rows that already have `deleted_at` set, so a live
//     row cannot be caught by it even if the id is wrong;
//   - it is scoped to one user;
//   - it is never called by the chat, by a cron job, or by anything on a timer.
//     Nothing in Trash expires. The only caller is a button a person pressed,
//     behind a typed confirmation.
//
// This file is the sole entry in ALLOWED_HARD_DELETE in
// scripts/sanity-check-deletes.mjs for the tables it touches.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { TRASHABLE, type TrashableTable } from "./soft-delete";

type Client = SupabaseClient<Database>;

export interface PurgeResult {
  destroyed: number;
  error: string | null;
}

/** Destroys every trashed row for one user. Children go before parents so a
 * foreign key can never leave a child stranded mid-purge. */
export async function emptyTrash(supabase: Client, userId: string): Promise<PurgeResult> {
  // Children first, parents last — the reverse of how they were trashed.
  const order: TrashableTable[] = [
    "todo_items",
    "list_items",
    "targets",
    "notes",
    "events",
    "todo_lists",
    "lists",
  ];
  // A table added to TRASHABLE and forgotten here would silently survive an
  // "empty trash", which is the sort of quiet mismatch this codebase keeps
  // finding. Fail loudly at the call site instead.
  const missing = TRASHABLE.filter((t) => !order.includes(t));
  if (missing.length) {
    return { destroyed: 0, error: `Trash can't be emptied: ${missing.join(", ")} not covered by the purge order.` };
  }

  let destroyed = 0;
  for (const table of order) {
    const { data, error } = await supabase
      .from(table)
      .delete()
      .eq("user_id", userId)
      .not("deleted_at", "is", null)
      .select("id");
    if (error) return { destroyed, error: `Couldn't empty the Trash (${table}): ${error.message}` };
    destroyed += data?.length ?? 0;
  }
  return { destroyed, error: null };
}
