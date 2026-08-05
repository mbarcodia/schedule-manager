// Everything derived from what was actually worked, fetched once.
//
// Separate from queryScheduleRows' progress_log fetch, which is deliberately
// windowed to a fortnight back — that window exists to resolve done/missed status
// on the visible calendar, and it is the wrong input for "how far through this
// project am I", "how wrong are my estimates" or "how many weeks running have I
// kept this up". All three need the whole history.
//
// Two details that matter for the totals being right:
//
//   ARCHIVED tasks count. Their hours were genuinely worked, and archiving is how
//   finished work is retired (never deletion, precisely so the record survives).
//   They are also the only sound basis for estimate-vs-actual, since a task still
//   in flight hasn't finished running up its actual.
//
//   A null minutes_done means the whole block was completed, so its length is the
//   minutes worked; a number means only that much of it was.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { loggedMinutesByCommitment } from "./pace";
import type { FinishedWork } from "./calibration";

export interface ProgressFacts {
  /** Lifetime minutes worked per commitment. */
  byProject: Record<string, number>;
  /** One entry per finished (archived) task that logged any time, for
   * calibration. */
  finished: FinishedWork[];
  /** Flat log for week-by-week consistency. projectId is null for routines and
   * unlinked work, which still prove the week was a working one. */
  logged: { occurredDate: Date; projectId: string | null; minutes: number }[];
}

export async function fetchProgressFacts(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<ProgressFacts> {
  const [{ data: progress }, { data: tasks }] = await Promise.all([
    supabase
      .from("progress_log")
      .select("subject_type,subject_id,start_min,end_min,minutes_done,occurred_date")
      .eq("user_id", userId),
    // No archived_at filter — see the note above.
    supabase.from("tasks").select("id,project_id,duration_min,archived_at").eq("user_id", userId),
  ]);

  const rows = progress ?? [];
  const taskRows = tasks ?? [];
  const projectOfTask = new Map(taskRows.map((t) => [t.id, t.project_id]));

  const minutesOf = (r: { start_min: number; end_min: number; minutes_done: number | null }) =>
    r.minutes_done ?? r.end_min - r.start_min;

  // Actual minutes per task, for the estimate comparison.
  const actualByTask: Record<string, number> = {};
  for (const r of rows) {
    if (r.subject_type !== "task") continue;
    const m = minutesOf(r);
    if (m > 0) actualByTask[r.subject_id] = (actualByTask[r.subject_id] ?? 0) + m;
  }
  const finished: FinishedWork[] = taskRows
    .filter((t) => t.archived_at && actualByTask[t.id] > 0 && t.duration_min > 0)
    .map((t) => ({ estimateMin: t.duration_min, actualMin: actualByTask[t.id] }));

  return {
    byProject: loggedMinutesByCommitment(rows, taskRows),
    finished,
    logged: rows.map((r) => ({
      occurredDate: new Date(`${r.occurred_date}T12:00:00`),
      projectId:
        r.subject_type === "research"
          ? r.subject_id
          : r.subject_type === "task"
            ? (projectOfTask.get(r.subject_id) ?? null)
            : null,
      minutes: minutesOf(r),
    })),
  };
}
