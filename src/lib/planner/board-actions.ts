// Direct Supabase writes for board interactions (drag-and-drop, toggles) —
// same pattern as useScheduleData's setProgress/pinDone, not the LLM tool
// layer: deterministic UI actions don't need a model round-trip.
//
// Column-drop semantics (V1, user-confirmed):
// - Backlog: soft — clear any pin and send to the back of the queue. The
//   engine may still place it this week if capacity allows (a guaranteed
//   "not before next week" would set floor_at; deliberate fast-follow).
// - This Week: clear any pin, jump the queue — priority-based placement
//   pulls it into this week's free capacity.
// - In Progress: the one hard action — pin the task's next chunk to today,
//   starting now (matches the "pin to a time" mental model the chat tools
//   already use; anything else scheduled there moves automatically).
// - Done: NOT writable from the board. Completion is real logged work
//   (progress_log tied to calendar blocks); fabricating an entry would
//   falsify the end-of-day/weekly hour accounting.

import { createClient } from "@/lib/supabase/client";
import type { TaskRow } from "@/components/board/KanbanCard";

export type DroppableColumn = "backlog" | "this_week" | "in_progress";

export async function moveTaskToColumn(task: TaskRow, target: DroppableColumn, allTasks: TaskRow[]): Promise<void> {
  const supabase = createClient();
  const ords = allTasks.map((t) => t.ord);

  if (target === "backlog") {
    await supabase
      .from("tasks")
      .update({
        pinned_date: null,
        pinned_start_min: null,
        pinned_length_min: null,
        ord: Math.max(0, ...ords) + 1,
      })
      .eq("id", task.id);
    return;
  }

  if (target === "this_week") {
    await supabase
      .from("tasks")
      .update({
        pinned_date: null,
        pinned_start_min: null,
        pinned_length_min: null,
        ord: Math.min(0, ...ords) - 1,
      })
      .eq("id", task.id);
    return;
  }

  // in_progress: pin the next chunk to today, starting at the next
  // quarter-hour (same rounding pinDone uses).
  const d = new Date();
  const startMin = Math.ceil((d.getHours() * 60 + d.getMinutes()) / 15) * 15;
  const pinnedDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  await supabase
    .from("tasks")
    .update({
      pinned_date: pinnedDate,
      pinned_start_min: startMin,
      pinned_length_min: Math.min(task.chunk_min, task.duration_min),
    })
    .eq("id", task.id);
}

export async function setTaskImportant(taskId: string, important: boolean): Promise<void> {
  const supabase = createClient();
  await supabase.from("tasks").update({ important }).eq("id", taskId);
}

export async function setTaskArchived(taskId: string, archived: boolean): Promise<void> {
  const supabase = createClient();
  await supabase
    .from("tasks")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", taskId);
}
