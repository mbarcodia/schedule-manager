// ONE TASK AT A TIME: nothing the engine plans may share an hour with anything
// else it plans. Only meetings overlap each other, and only COMPLETIONS overlap
// completions ("I did both of these at the same time").
// (run: npx tsx scripts/sanity-check-no-double-booking.mjs)
//
// Regression for a live bug. Ticking a task fully done ARCHIVES it
// (syncTaskCompletionFromProgress), and archived tasks are filtered out of the
// engine's inputs. Pass 1 replans the current week from Monday to work out
// where each chunk landed, so with the def gone it read the worked hour as
// empty and slid the next task into it — and the completed block was then
// re-added from currentWeekFallback on top. Checking off "Review lecturer
// applications" at 9:15-10:00 put "Design course syllabus" in the same slot.

import { computeSchedule } from "../src/lib/scheduling/engine.ts";

const DONE_TASK = "11111111-1111-1111-1111-111111111111";
const NEXT_TASK = "22222222-2222-2222-2222-222222222222";

// Monday, 10:50am — after the 9:15-10:00 slot that got worked.
const NOW = new Date(2026, 7, 24, 10, 50);

function inputs({ archived, extraProgress = [] }) {
  // The worked hour, exactly as progress_log records it once ticked.
  const worked = [{ taskId: DONE_TASK, title: "Review lecturer applications", gday: 0, start: 555, end: 600 }, ...extraProgress];
  return {
    timezone: "America/New_York",
    horizonWeeks: 2,
    weeklyHours: Object.fromEntries(
      Array.from({ length: 7 }, (_, d) => [d, d < 5 ? { start: 9 * 60, end: 17 * 60 } : null]),
    ),
    // `archived` is the state AFTER completion: the finished task's row is gone
    // from the engine's inputs, so nothing generates a def for it.
    tasks: [
      ...(archived
        ? []
        : [{ id: DONE_TASK, title: "Review lecturer applications", priority: "medium", duration: 45, chunk: 45, deadline: 99999, floor: 0 }]),
      { id: NEXT_TASK, title: "Design course syllabus", priority: "medium", duration: 30, chunk: 30, deadline: 99999, floor: 0 },
    ],
    projects: [],
    events: [],
    recurringRules: [],
    dayOverrides: {},
    researchPins: [],
    completed: Object.fromEntries(worked.map((w) => [`${w.taskId}@${w.gday}-${w.start}`, true])),
    partial: {},
    pinned: {},
    labelNames: {},
    historyBlocks: [],
    labelTargetPct: {},
    labelTargetBasis: {},
    // What from-db builds for a progress_log row in the current week — the
    // safety net that re-adds work pass 1 could not reconstruct.
    currentWeekFallback: worked.map((w) => ({
      type: "task",
      taskId: w.taskId,
      projectId: null,
      categoryId: null,
      tagLabel: null,
      title: w.title,
      gday: w.gday,
      start: w.start,
      end: w.end,
      priority: null,
      status: "done",
      partMin: null,
      key: `${w.taskId}@${w.gday}-${w.start}`,
      abs: w.gday * 1440 + w.start,
    })),
  };
}

/** Every pair of blocks sharing a minute that isn't allowed to. */
function badOverlaps(blocks) {
  const out = [];
  const byDay = new Map();
  for (const b of blocks) {
    if (b.allDay) continue;
    if (!byDay.has(b.gday)) byDay.set(b.gday, []);
    byDay.get(b.gday).push(b);
  }
  for (const list of byDay.values()) {
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.end <= b.start || b.end <= a.start) continue;
        const bothMeetings = a.type === "synced" && b.type === "synced";
        const settled = (x) => x.status === "done" || x.status === "partial";
        if (bothMeetings || (settled(a) && settled(b))) continue; // allowed
        out.push(`${a.title} ${a.start}-${a.end} [${a.status ?? a.type}] × ${b.title} ${b.start}-${b.end} [${b.status ?? b.type}]`);
      }
  }
  return out;
}

const after = computeSchedule(inputs({ archived: true }), NOW);
const bad = badOverlaps(after.blocks);
const doneBlock = after.blocks.filter((b) => b.taskId === DONE_TASK && b.status === "done");
const nextBlocks = after.blocks.filter((b) => b.taskId === NEXT_TASK);
const nextOnTop = nextBlocks.filter((b) => b.gday === 0 && b.start < 600 && b.end > 555);

// The other half of the rule: a plan that DID lose its hour to logged work is
// dropped, not drawn underneath it. Forced here by logging a second task's
// worked hour that pass 1 has no way to anticipate.
const stacked = computeSchedule(
  inputs({
    archived: false,
    extraProgress: [{ taskId: "33333333-3333-3333-3333-333333333333", title: "Something else entirely", gday: 0, start: 540, end: 660 }],
  }),
  NOW,
);
const stackedBad = badOverlaps(stacked.blocks);

const checks = [
  ["nothing is double-booked once the finished task is archived", bad.length === 0, bad.join("; ")],
  ["the completed hour is still on the calendar", doneBlock.length === 1, `${doneBlock.length} done blocks`],
  ["the next task is scheduled, not lost", nextBlocks.length > 0, "no blocks at all"],
  ["the next task did not move into the worked hour", nextOnTop.length === 0, `${nextOnTop.length} blocks at 9:15-10:00`],
  ["a plan superseded by logged work is dropped, not stacked", stackedBad.length === 0, stackedBad.join("; ")],
  ["a superseded plan is not reported as missed", !stacked.missed.includes("Design course syllabus"), stacked.missed.join(", ")],
];

let failed = 0;
for (const [label, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` — ${detail}`}`);
}
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
