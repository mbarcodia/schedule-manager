// Direct Supabase writes for board interactions (drag-and-drop, toggles) —
// same pattern as useScheduleData's setProgress/pinDone, not the LLM tool
// layer: deterministic UI actions don't need a model round-trip.
//
// Column-drop semantics (V1, user-confirmed):
// - Backlog: soft — clear any pin and send to the back of the queue. The
//   engine may still place it this week if capacity allows. A guaranteed
//   "not before next week" is a SEPARATE, explicit act: the board offers it on
//   the card right after the drop (see holdUntilNextWeek), because the two
//   meanings of "backlog" — "less important than the rest" and "not yet" — are
//   worth keeping apart, and a gesture that silently rewrote a date would be
//   the wrong default for the commoner of the two.
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

/** Next Monday, local, at midnight — the first moment of the next working week.
 * Exported for the sanity check: "next week" is the kind of date that is quietly
 * wrong by a day, and on a Monday it must mean seven days out, not today. */
export function nextMondayISO(now: Date = new Date()): string {
  const days = (8 - ((now.getDay() + 6) % 7) - 1) % 7 || 7;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return d.toISOString();
}

/** The hard half of a backlog drop: this may not be scheduled before next week.
 * Writes the same floor_at column the task panel's "don't start before" field
 * and the chat's not_before both write — one meaning, one column, three ways in. */
export async function holdUntilNextWeek(taskId: string, now: Date = new Date()): Promise<string | null> {
  const supabase = createClient();
  const { error } = await supabase.from("tasks").update({ floor_at: nextMondayISO(now) }).eq("id", taskId);
  return error?.message ?? null;
}

export async function setTaskImportant(taskId: string, important: boolean): Promise<void> {
  const supabase = createClient();
  await supabase.from("tasks").update({ important }).eq("id", taskId);
}

/** Importance on a commitment, mirroring setTaskImportant. Both axes of the
 * Priorities board are per-row flags the user sets; urgency is derived. */
export async function setCommitmentImportant(projectId: string, important: boolean): Promise<void> {
  const supabase = createClient();
  await supabase.from("projects").update({ important }).eq("id", projectId);
}

export async function setTaskArchived(taskId: string, archived: boolean): Promise<void> {
  const supabase = createClient();
  await supabase
    .from("tasks")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", taskId);
}

// ---------------------------------------------------------------------------
// Commitments and their dates.
//
// These carry the three inputs pace needs — a total estimate, weekly hours and a
// date — and until now every one of them could only be set by talking to the
// chat. A card that says "needs estimate and weekly hours to be measurable" with
// no way to supply either is a dead end, so the panel writes them directly and
// the chat tools keep doing the same job from a word dump. Both paths write the
// same columns; neither is the source of truth.
//
// Errors are RETURNED rather than swallowed: a panel that closes on a failed
// write reads as a saved change, which is how two earlier "Save does nothing"
// bugs presented.

/** null clears the field. Hours are stored as minutes throughout. */
export interface CommitmentFields {
  title: string;
  deadlineDate: string | null;
  deadlineKind: "hard" | "goal";
  effortEstimateMin: number | null;
  weeklyMinMin: number | null;
  important: boolean;
  /** YYYY-MM-DD, or null for unbounded on that side. The window the weekly hours
   * apply INSIDE — the commitment-level answer to "not yet": a course starting
   * next term exists now and books nothing until it does. Both ends are
   * inclusive. Was reachable only through the chat until now. */
  activeFrom: string | null;
  activeUntil: string | null;
  /** The label its weekly-hours blocks wear. More than a colour: the label
   * carries the minimum chunk, the time-of-day rule and — the reason this could
   * not stay chat-only — the WEEKLY SHARE this commitment's hours count toward.
   * An unlabelled commitment counts toward no share at all. */
  categoryId: string | null;
  /** A HARD half-of-day restriction on where those hours may go. Null leaves
   * them unrestricted (mornings are still tried first). Setting one can make a
   * large weekly minimum unschedulable — one morning holds only so much — which
   * is why the panel says so next to the control. */
  hoursTimeOfDay: "morning" | "afternoon" | null;
}

export async function saveCommitmentFields(projectId: string, fields: CommitmentFields): Promise<string | null> {
  const supabase = createClient();
  const { error } = await supabase
    .from("projects")
    .update({
      title: fields.title,
      deadline_date: fields.deadlineDate,
      deadline_kind: fields.deadlineKind,
      effort_estimate_min: fields.effortEstimateMin,
      weekly_min_min: fields.weeklyMinMin,
      important: fields.important,
      active_from: fields.activeFrom,
      active_until: fields.activeUntil,
      category_id: fields.categoryId,
      time_of_day: fields.hoursTimeOfDay,
    })
    .eq("id", projectId);
  return error?.message ?? null;
}

/** Pause a commitment, or pick it back up. NOT archiving: it stays on the
 * boards, because the point of recording something you aren't doing is to keep
 * seeing it. Nothing else is touched — above all not weekly_min_min, which is
 * the rate it resumes at (migration 0041). */
export async function setCommitmentOnHold(projectId: string, onHold: boolean): Promise<string | null> {
  const supabase = createClient();
  const { error } = await supabase
    .from("projects")
    .update({ on_hold_at: onHold ? new Date().toISOString() : null })
    .eq("id", projectId);
  return error?.message ?? null;
}

/** A commitment starts as a title and nothing else — an estimate, hours and a
 * date are all things you may not know yet, and pace says so rather than being
 * blocked on them. Returns the new id so the panel can go on to write its dates.
 *
 * chunk_min is left to the column default: it's the block length the engine
 * prefers, which a label's minimum chunk already governs, and asking for it at
 * creation time would be a number with no meaning yet. */
export async function createCommitment(title: string): Promise<{ id: string | null; error: string | null }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { id: null, error: "You appear to be signed out — reload and try again." };
  const { data, error } = await supabase
    .from("projects")
    .insert({ user_id: user.id, title: title.trim() })
    .select("id")
    .single();
  return { id: data?.id ?? null, error: error?.message ?? null };
}

/** Put a commitment away, or bring it back. Not a delete: its logged hours, its
 * targets and its estimate all stay, which is the same promise the board already
 * makes for tasks. See migration 0037. */
export async function setCommitmentArchived(projectId: string, archived: boolean): Promise<string | null> {
  const supabase = createClient();
  const { error } = await supabase
    .from("projects")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", projectId);
  return error?.message ?? null;
}

export interface TargetFields {
  title: string;
  /** YYYY-MM-DD. A target is a day, never a moment. */
  date: string;
  dateKind: "hard" | "goal";
  /** Effort due by this date, for this phase alone. null = undimensioned, and
   * pace then measures the whole commitment's remaining effort against it. */
  effortEstimateMin: number | null;
}

export async function saveTarget(targetId: string, fields: TargetFields): Promise<string | null> {
  const supabase = createClient();
  const { error } = await supabase
    .from("targets")
    .update({
      title: fields.title,
      target_date: fields.date,
      date_kind: fields.dateKind,
      effort_estimate_min: fields.effortEstimateMin,
    })
    .eq("id", targetId);
  return error?.message ?? null;
}

export async function addTarget(projectId: string, fields: TargetFields): Promise<string | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "You appear to be signed out — reload and try again.";
  const { error } = await supabase.from("targets").insert({
    user_id: user.id,
    commitment_id: projectId,
    title: fields.title,
    target_date: fields.date,
    date_kind: fields.dateKind,
    effort_estimate_min: fields.effortEstimateMin,
  });
  return error?.message ?? null;
}

/** Hit or un-hit. Kept rather than deleted, so a commitment reads as a sequence
 * of dates made or missed — same one-field write the Timeline marker does. */
export async function setTargetHit(targetId: string, hit: boolean): Promise<string | null> {
  const supabase = createClient();
  const { error } = await supabase
    .from("targets")
    .update({ completed_at: hit ? new Date().toISOString() : null })
    .eq("id", targetId);
  return error?.message ?? null;
}

/** Deleting is for a checkpoint that shouldn't exist. Hitting one that has been
 * met is setTargetHit — that's a record, and pace still counts its hours. */
export async function deleteTarget(targetId: string): Promise<string | null> {
  const supabase = createClient();
  const { error } = await supabase.from("targets").delete().eq("id", targetId);
  return error?.message ?? null;
}
