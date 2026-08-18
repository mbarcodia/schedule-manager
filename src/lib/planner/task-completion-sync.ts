// Keeps a task's archived state and its source to-do's tick in sync, in both
// directions.
//
// TodoView's own toggle() already does the todo->task half: ticking a to-do
// archives whatever hours it booked. This is the other half — task->todo —
// called from every place a task can become "done" so ticking one always
// shows up on the other, regardless of which side did it:
//   - the Kanban board's Done column (setTaskArchived)
//   - the chat's remove_item / complete_task tools
//   - the calendar checkbox, once a task's LAST remaining minutes are logged
//     (syncTaskCompletionFromProgress, below)

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/** Ticks or un-ticks a task's source to-do to match its archived state. A
 * no-op when the task didn't come from a to-do (task_id is never set on any
 * row). Errors are swallowed the way a background reconciliation should be:
 * the archive itself already succeeded, and a to-do that doesn't follow along
 * this one time is far less harmful than surfacing a scary error for a
 * courtesy sync the user didn't directly ask for. */
export async function syncTodoOnTaskArchive(
  supabase: SupabaseClient<Database>,
  taskId: string,
  archived: boolean,
): Promise<void> {
  await supabase
    .from("todo_items")
    .update({ done: archived, completed_at: archived ? new Date().toISOString() : null })
    .eq("task_id", taskId)
    .is("deleted_at", null);
}

/** Recomputes whether a task's logged + pinned-early minutes now cover its
 * full duration, and archives (or restores) it to match — then carries that
 * onto its to-do via syncTodoOnTaskArchive. This is what makes the calendar
 * checkbox behave like the Kanban board: the engine already treats a fully
 * credited task as owing no more work (see engine.ts's `credit`/preDone), so
 * this just makes archived_at agree with what the scheduler already believes,
 * for a task (never a research/anchor subject — those are ongoing by design
 * and have no "fully done" state).
 *
 * Called after every calendar completion write (setProgress, pinDone,
 * unpinDone) so un-ticking a task's last chunk restores it exactly as
 * ticking the to-do's own checkbox does today. */
export async function syncTaskCompletionFromProgress(
  supabase: SupabaseClient<Database>,
  taskId: string,
): Promise<void> {
  const { data: task } = await supabase.from("tasks").select("duration_min,archived_at").eq("id", taskId).single();
  if (!task) return;

  const [{ data: prog }, { data: pins }] = await Promise.all([
    supabase.from("progress_log").select("minutes_done,start_min,end_min").eq("subject_type", "task").eq("subject_id", taskId),
    supabase.from("pinned_chunks").select("start_min,end_min").eq("subject_type", "task").eq("subject_id", taskId),
  ]);
  const doneMin =
    (prog ?? []).reduce((n, p) => n + (p.minutes_done ?? p.end_min - p.start_min), 0) +
    (pins ?? []).reduce((n, p) => n + (p.end_min - p.start_min), 0);

  const isDone = doneMin >= task.duration_min;
  const wasArchived = task.archived_at != null;
  if (isDone === wasArchived) return; // already in sync — the common case, no write needed

  await supabase
    .from("tasks")
    .update({ archived_at: isDone ? new Date().toISOString() : null })
    .eq("id", taskId);
  await syncTodoOnTaskArchive(supabase, taskId, isDone);
}
