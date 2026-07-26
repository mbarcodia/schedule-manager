// Kanban column derivation — a pure function over the engine's output, kept
// out of React so the board UI, the system-prompt snapshot (WIP counts), and
// the weekly-review cron all share one source of truth.
//
// Statuses are inherently THIS-WEEK concepts: the engine re-simulates from
// the current week's Monday (gday 0) every run and keeps no cross-week
// completion state, so "done" means "everything scheduled for it this week
// is checked off", not "finished forever" (that's what archiving is for).

import type { ComputeScheduleResult, ScheduleBlock } from "@/lib/scheduling/types";

export type BoardStatus = "backlog" | "this_week" | "in_progress" | "done";

export interface BoardStatusIndex {
  byTaskId: Record<string, BoardStatus>;
}

/** Derive every task's board column in one pass over the schedule. */
export function deriveBoardStatuses(schedule: ComputeScheduleResult): BoardStatusIndex {
  const blocksByTask: Record<string, ScheduleBlock[]> = {};
  for (const b of schedule.blocks) {
    if (b.type !== "task" || !b.taskId) continue;
    (blocksByTask[b.taskId] ??= []).push(b);
  }

  const byTaskId: Record<string, BoardStatus> = {};
  for (const [taskId, blocks] of Object.entries(blocksByTask)) {
    byTaskId[taskId] = statusFromBlocks(blocks);
  }
  return { byTaskId };
}

/** Column for one task. Tasks with no blocks at all (overflow, or fully
 * credited with nothing left to place) don't appear in the index — callers
 * treat missing as "backlog". */
export function boardStatusFor(index: BoardStatusIndex, taskId: string): BoardStatus {
  return index.byTaskId[taskId] ?? "backlog";
}

function statusFromBlocks(blocks: ScheduleBlock[]): BoardStatus {
  const thisWeek = blocks.filter((b) => Math.floor(b.gday / 7) === 0);

  // Scheduled, but not until a later week — not this week's concern.
  if (thisWeek.length === 0) return "backlog";

  if (thisWeek.every((b) => b.status === "done")) return "done";

  // "active" = a chunk is happening right now (abs < NOW < absEnd) — the
  // closest thing the engine has to "currently being worked".
  if (thisWeek.some((b) => b.status === "active")) return "in_progress";

  // Some (but not all) chunks already done/partial — underway, not queued.
  if (thisWeek.some((b) => b.status === "done" || b.status === "partial")) return "in_progress";

  return "this_week";
}
