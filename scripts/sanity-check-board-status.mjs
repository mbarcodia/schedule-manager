// Sanity check for the kanban column derivation (run: npx tsx scripts/sanity-check-board-status.mjs).
// deriveBoardStatuses is pure over ComputeScheduleResult.blocks, so synthetic
// blocks are enough — no engine, no DB.

import { plannerCommitmentHref, plannerTaskHref } from "../src/lib/planner/board-links.ts";
import { todoItemHref } from "../src/lib/planner/todo-links.ts";
import { deriveBoardStatuses, boardStatusFor } from "../src/lib/planner/board-status.ts";

const block = (taskId, gday, status) => ({
  type: "task",
  taskId,
  gday,
  start: 540,
  end: 600,
  tagLabel: "Task",
  title: taskId,
  priority: "med",
  status,
});

const schedule = {
  blocks: [
    // t-later-week: only scheduled next week -> backlog
    block("t-later-week", 8, undefined),
    // t-queued: this week, nothing started -> this_week
    block("t-queued", 2, undefined),
    block("t-queued", 3, undefined),
    // t-active: a chunk running right now -> in_progress
    block("t-active", 0, "active"),
    block("t-active", 4, undefined),
    // t-partial: some progress logged -> in_progress
    block("t-partial", 0, "partial"),
    block("t-partial", 2, undefined),
    // t-mixed: one done, one still queued -> in_progress
    block("t-mixed", 0, "done"),
    block("t-mixed", 3, undefined),
    // t-done: everything this week checked off -> done
    block("t-done", 0, "done"),
    block("t-done", 1, "done"),
    // t-done-more-later: done this week, more next week -> done (this-week concept)
    block("t-done-more-later", 0, "done"),
    block("t-done-more-later", 9, undefined),
    // non-task blocks must be ignored
    { type: "meeting", gday: 0, start: 600, end: 660, tagLabel: "Meeting", title: "standup", priority: null },
  ],
  overflow: [],
  risk: [],
  nearDeadline: [],
  missed: [],
};

const expected = {
  "t-later-week": "backlog",
  "t-queued": "this_week",
  "t-active": "in_progress",
  "t-partial": "in_progress",
  "t-mixed": "in_progress",
  "t-done": "done",
  "t-done-more-later": "done",
  "t-unscheduled": "backlog", // absent from blocks entirely -> backlog fallback
};

const index = deriveBoardStatuses(schedule);
let failed = 0;
for (const [taskId, want] of Object.entries(expected)) {
  const got = boardStatusFor(index, taskId);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${taskId}: got=${got} want=${want}`);
}

// ------------------------------------------------- calendar -> board links
//
// The contract the calendar popover and the planner page have to agree on. Two
// params rather than one shared "item": the ids come from different tables and
// open different panels, and a stale link whose row is gone must not be
// indistinguishable from a typo.
const links = [
  ["a task link opens the Progress board", plannerTaskHref("t1"), "/planner?view=kanban&task=t1"],
  ["a commitment link does too", plannerCommitmentHref("p1"), "/planner?view=kanban&commitment=p1"],
  ["neither collides with the to-do link's param", todoItemHref("i1"), "/planner?view=todos&item=i1"],
  // A weekly-hours block's id is synthetic; only parsing it tells a commitment
  // from a task, since the engine sets projectId on both.
  ["the synthetic id yields the commitment id", /^research-(.+)-w\d+$/.exec("research-abc-123-w2")?.[1], "abc-123"],
  ["a plain task id does not match it", /^research-(.+)-w\d+$/.test("abc-123"), false],
];
for (const [label, got, want] of links) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : `: got=${got} want=${want}`}`);
}

process.exit(failed ? 1 : 0);
