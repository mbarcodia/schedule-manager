// Eisenhower quadrant assignment. "Important" is the explicit per-task flag
// (tasks.important); "urgent" is derived from deadline_at — no column.

import { zonedNow } from "@/lib/scheduling/time";
import { URGENT_THRESHOLD_DAYS } from "./board-constants";
import type { TaskRow } from "@/components/board/KanbanCard";

export type Quadrant = "do" | "schedule" | "delegate" | "eliminate";

/** Deadline within URGENT_THRESHOLD_DAYS calendar days (today inclusive),
 * measured in the user's timezone. Overdue counts as urgent; no deadline is
 * never urgent. */
export function isUrgent(task: TaskRow, timezone: string, at: Date = new Date()): boolean {
  if (!task.deadline_at) return false;
  const now = zonedNow(timezone, at);
  const deadline = zonedNow(timezone, new Date(task.deadline_at));
  const todayUtc = Date.UTC(now.year, now.month - 1, now.day);
  const deadlineUtc = Date.UTC(deadline.year, deadline.month - 1, deadline.day);
  return (deadlineUtc - todayUtc) / 86400000 <= URGENT_THRESHOLD_DAYS;
}

export function quadrantFor(task: TaskRow, timezone: string, at: Date = new Date()): Quadrant {
  const urgent = isUrgent(task, timezone, at);
  if (task.important) return urgent ? "do" : "schedule";
  return urgent ? "delegate" : "eliminate";
}

/** The same two axes for a commitment. Urgency comes from the soonest date still
 * to be met — its own deadline or an unmet target — so a commitment with no
 * dates is never urgent, exactly as a task with no deadline isn't.
 *
 * Commitments needed their own entry point because they carry dates in two
 * places (a deadline and any number of targets) where a task carries one. */
export function commitmentQuadrant(
  commitment: { important?: boolean; deadlineDate?: Date | null },
  nextDate: Date | null,
  timezone: string,
  at: Date = new Date(),
): Quadrant {
  const dates = [nextDate, commitment.deadlineDate ?? null].filter((d): d is Date => d != null);
  const soonest = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
  const urgent = soonest ? isUrgent({ deadline_at: soonest.toISOString() } as TaskRow, timezone, at) : false;
  if (commitment.important) return urgent ? "do" : "schedule";
  return urgent ? "delegate" : "eliminate";
}
