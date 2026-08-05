// Lifetime minutes worked per commitment.
//
// Separate from queryScheduleRows' progress_log fetch, which is deliberately
// windowed to a fortnight back — that window exists to resolve done/missed
// status on the visible calendar, and it is the wrong input for "how far through
// this project am I". A commitment three months in would report almost none of
// its effort.
//
// Two details that matter for the total being right:
//
//   ARCHIVED tasks count. Their hours were genuinely worked, and archiving is
//   how finished work is retired (never deletion, precisely so the record
//   survives) — so attribution reads every task, not just the live ones.
//
//   A null minutes_done means the whole block was completed, so its length is
//   the minutes worked; a number means only that much of it was.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { loggedMinutesByCommitment } from "./pace";

export async function fetchLoggedMinutesByCommitment(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Record<string, number>> {
  const [{ data: progress }, { data: tasks }] = await Promise.all([
    supabase
      .from("progress_log")
      .select("subject_type,subject_id,start_min,end_min,minutes_done")
      .eq("user_id", userId),
    // No archived_at filter — see the note above.
    supabase.from("tasks").select("id,project_id").eq("user_id", userId),
  ]);
  return loggedMinutesByCommitment(progress ?? [], tasks ?? []);
}
