// Verifies that a deadline bounds WHERE work is placed, not just the order it's
// considered in (run: npx tsx scripts/sanity-check-deadline-bound.mjs).
//
// The bug this pins: the scheduler walked forward looking for a gap the size of
// the preferred chunk and took the first one it found. When the time before a
// deadline was free but only in smaller pieces, it sailed past the deadline to
// find a full-size gap — so four hours of preparation for a Wednesday talk were
// booked on Thursday and Friday, flagged "will miss deadline", while Monday and
// Tuesday sat half empty.
//
// Correct behaviour: prefer smaller pieces before the deadline over whole chunks
// after it, and only schedule late when nothing fits at all.

import { computeSchedule } from "../src/lib/scheduling/engine.ts";

const TZ = "America/New_York";
const TASK = "44444444-4444-4444-4444-444444444444";

// A Monday, so gday 0 is that day.
const MONDAY = new Date(2026, 6, 27, 8, 0);

/** Working days 9-17, with meetings carved so no gap reaches two hours: 90
 * minutes is the largest hole before the deadline. */
function inputs({ deadline, chunk = 120, minChunk = 30, duration = 240 }) {
  const busyEvents = [];
  let id = 0;
  for (const gday of [0, 1, 2]) {
    // 10:30-12:00 and 13:30-15:30 booked -> free: 9:00-10:30 (90m),
    // 12:00-13:30 (90m), 15:30-17:00 (90m).
    busyEvents.push({ id: `e${id++}`, title: "meeting", gday, start: 10 * 60 + 30, end: 12 * 60 });
    busyEvents.push({ id: `e${id++}`, title: "meeting", gday, start: 13 * 60 + 30, end: 15 * 60 + 30 });
  }
  return {
    timezone: TZ,
    horizonWeeks: 3,
    weeklyHours: Object.fromEntries(
      Array.from({ length: 7 }, (_, d) => [d, d < 5 ? { start: 9 * 60, end: 17 * 60 } : null]),
    ),
    tasks: [
      {
        id: TASK,
        title: "Prep",
        priority: "medium",
        duration,
        chunk,
        minChunk,
        deadline,
        floor: 0,
        ord: 0,
      },
    ],
    projects: [],
    events: busyEvents,
    recurringRules: [],
    dayOverrides: {},
    graceHours: 4,
    researchPins: [],
    completed: {},
    partial: {},
    pinned: {},
    tagLabels: { task: "Task", research: "Research", deepFocus: "Deep focus", block: "Time block" },
  };
}

const chunksOf = (blocks) => blocks.filter((b) => b.taskId === TASK);
const NO_DEADLINE = 99999;

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "  OK" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

// Deadline at the end of Wednesday (gday 2). Every gap before it is 90 minutes,
// so fitting 4 hours REQUIRES splitting below the 120-minute preference.
const deadline = 3 * 1440;
const bounded = computeSchedule(inputs({ deadline }), MONDAY).blocks;
const placed = chunksOf(bounded);

check("all of it is scheduled", placed.reduce((s, b) => s + (b.end - b.start), 0), 240);
check(
  "nothing lands after the deadline",
  placed.every((b) => b.gday * 1440 + b.end <= deadline),
  true,
);
check("it split into more than two pieces", placed.length > 2, true);
check("no piece exceeds the largest gap", placed.every((b) => b.end - b.start <= 90), true);

// The engine reports risk from the finish time, so a task that now fits must not
// be flagged.
const risk = computeSchedule(inputs({ deadline }), MONDAY).risk;
check("not flagged as missing its deadline", risk.includes("Prep"), false);

// Without a deadline there's nothing to bound, so the preferred chunk size wins
// and it may sit later in the week — the old behaviour, still correct here.
const unbounded = chunksOf(computeSchedule(inputs({ deadline: NO_DEADLINE }), MONDAY).blocks);
check("unbounded still schedules everything", unbounded.reduce((s, b) => s + (b.end - b.start), 0), 240);

// minChunk is still a hard floor: with a 120-minute floor nothing can fit in a
// 90-minute gap, so it has to go late rather than be chopped smaller.
const floored = computeSchedule(inputs({ deadline, minChunk: 120 }), MONDAY).blocks;
const flooredChunks = chunksOf(floored);
check("minChunk is respected over the deadline", flooredChunks.every((b) => b.end - b.start >= 120), true);
check(
  "and that case IS flagged late",
  computeSchedule(inputs({ deadline, minChunk: 120 }), MONDAY).risk.includes("Prep"),
  true,
);

// A deadline that has already passed can't be met; the work must still appear
// rather than vanishing.
const impossible = chunksOf(computeSchedule(inputs({ deadline: 1 }), MONDAY).blocks);
check("an impossible deadline still schedules the work", impossible.length > 0, true);

console.log(failures ? `\n${failures} check(s) failed` : "\nall deadline-bound checks passed");
process.exit(failures ? 1 : 0);
