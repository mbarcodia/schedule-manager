// Verifies a hard-pinned task's fixed slot clears once it's been checked off
// early (run: npx tsx scripts/sanity-check-task-pin-early-done.mjs).
//
// Regression for a live bug: a task pinned to a specific future slot (e.g.
// "tell Rich about my new app" at 11am tomorrow) kept showing at that slot
// forever, even after the "Just now" early-completion flow (Block.tsx ->
// useScheduleData.pinDone) recorded it done today. The fixed pin is drawn
// from `tasks.pinned_date`/`pinned_start_min` every run regardless of
// progress, so nothing ever cleared it — the early-done credit in
// `inputs.pinned` was never checked against it.

import { computeSchedule } from "../src/lib/scheduling/engine.ts";

const TASK_ID = "33333333-3333-3333-3333-333333333333";
const PIN = { gday: 2, start: 11 * 60, length: 30 }; // tomorrow 11:00am, 30m

function inputs({ withEarlyDonePin }) {
  return {
    timezone: "America/New_York",
    horizonWeeks: 2,
    weeklyHours: Object.fromEntries(
      Array.from({ length: 7 }, (_, d) => [d, d < 5 ? { start: 9 * 60, end: 17 * 60 } : null]),
    ),
    tasks: [
      {
        id: TASK_ID,
        title: "Tell Rich about my new app",
        priority: "medium",
        duration: 30,
        chunk: 30,
        deadline: 99999,
        floor: 0,
        pins: [PIN],
      },
    ],
    projects: [],
    events: [],
    recurringRules: [],
    dayOverrides: {},
    researchPins: [],
    completed: {},
    partial: {},
    // The early-done pin: recorded TODAY (gday 1), covering the task's full
    // 30-minute duration — exactly what Block.tsx's "Just now" button writes.
    pinned: withEarlyDonePin
      ? {
          [`${TASK_ID}@1-570`]: {
            taskId: TASK_ID,
            projectId: null,
            tagLabel: null,
            title: "Tell Rich about my new app",
            gday: 1,
            start: 570,
            end: 600,
            priority: "medium",
          },
        }
      : {},
    labelNames: {},
    historyBlocks: [],
    labelTargetPct: {},
    labelTargetBasis: {},
  };
}

// A fixed Tuesday morning (gday 1), after the early-done pin's 9:30-10:00
// slot, so it reads as a real completed pin rather than one still in the future.
const NOW = new Date(2026, 6, 28, 10, 30);

const before = computeSchedule(inputs({ withEarlyDonePin: false }), NOW);
const beforeAtPin = before.blocks.filter((b) => b.taskId === TASK_ID && b.gday === PIN.gday && b.start === PIN.start);

const after = computeSchedule(inputs({ withEarlyDonePin: true }), NOW);
const afterAtPin = after.blocks.filter((b) => b.taskId === TASK_ID && b.gday === PIN.gday && b.start === PIN.start);
const afterDoneBlock = after.blocks.filter((b) => b.taskId === TASK_ID && b.status === "done");

const checks = [
  ["without an early-done pin, the fixed slot shows tomorrow", beforeAtPin.length === 1, `${beforeAtPin.length} blocks at the pin`],
  ["once checked off early, the fixed slot is gone", afterAtPin.length === 0, `${afterAtPin.length} blocks still at the pin`],
  ["the early completion itself still shows as done", afterDoneBlock.length === 1, `${afterDoneBlock.length} done blocks`],
];

let failed = 0;
for (const [label, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` — got ${detail}`}`);
}
process.exit(failed ? 1 : 0);
