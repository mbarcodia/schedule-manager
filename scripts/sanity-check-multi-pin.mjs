// A task may hold SEVERAL exact slots, and each one stands on its own
// (run: npx tsx scripts/sanity-check-multi-pin.mjs).
//
// Regression for a live limitation, not a crash. `tasks.pinned_date/start/length`
// held exactly one slot per task, so an 8-hour review that had to happen as four
// 2-hour blocks in one week could only ever hold the first — the planner offered
// four pins, wrote one, and the other six hours drifted past the deadline with
// nothing saying so. Migration 0047 moved pins to their own table.
//
// The second half matters as much as the first: a meeting landing on ONE slot
// must free only that slot. Releasing all four would turn a single Tuesday
// meeting into the loss of a whole week's plan.

import { computeSchedule } from "../src/lib/scheduling/engine.ts";

const TASK = "44444444-4444-4444-4444-444444444444";
// Monday 24 Aug 2026, 08:00 — before the working day, so every slot below is
// still in the future and eligible for release.
const NOW = new Date(2026, 7, 24, 8, 0);

// Tue 9:15-11:15, Thu 9:15-11:15, Thu 14:30-16:30, Fri 12:30-14:30 — four 2h
// blocks, two of them on the same day, which is the shape a single-pin column
// could not express at all.
const SLOTS = [
  { gday: 1, start: 555, length: 120 },
  { gday: 3, start: 555, length: 120 },
  { gday: 3, start: 870, length: 120 },
  { gday: 4, start: 750, length: 120 },
];

function inputs({ pins = SLOTS, events = [] } = {}) {
  return {
    timezone: "America/New_York",
    horizonWeeks: 4,
    weeklyHours: Object.fromEntries(
      Array.from({ length: 7 }, (_, d) => [d, d < 5 ? { start: 9 * 60, end: 17 * 60 } : null]),
    ),
    tasks: [
      {
        id: TASK,
        title: "DOE Review",
        priority: "high",
        duration: 480,
        chunk: 120,
        minChunk: 120,
        deadline: 4 * 1440 + 1020,
        floor: 0,
        pins,
      },
    ],
    projects: [],
    events,
    recurringRules: [],
    dayOverrides: {},
    allDayBlocks: {},
    researchPins: [],
    completed: {},
    partial: {},
    pinned: {},
    labelNames: {},
    labelTargetPct: {},
    labelTargetBasis: {},
    graceHours: 4,
  };
}

const at = (s, gday, start) =>
  s.blocks.filter((b) => b.taskId === TASK && b.gday === gday && b.start === start).length;
const held = (s) =>
  SLOTS.filter((sl) => at(s, sl.gday, sl.start) > 0).length;
const totalMin = (s) =>
  s.blocks.filter((b) => b.taskId === TASK).reduce((n, b) => n + (b.end - b.start), 0);

const all = computeSchedule(inputs(), NOW);

// A meeting straight through the middle of the Tuesday slot only.
const meeting = [
  { id: "m1", source: "google", title: "New meeting", gday: 1, start: 600, end: 660, allDay: false },
];
const invaded = computeSchedule(inputs({ events: meeting }), NOW);

const checks = [
  ["all four slots are held at once", held(all), 4],
  ["and two of them are on the same day", at(all, 3, 555) + at(all, 3, 870), 2],
  ["the whole 8h is on the calendar", totalMin(all), 480],
  // The released hours are not lost: they go back into the pool and are placed
  // like any other work, so the total is unchanged.
  ["a meeting on one slot frees that one", at(invaded, 1, 555), 0],
  ["and leaves the other three exactly where they were", held(invaded), 3],
  ["the displaced task is named, once", invaded.displacedPins, ["DOE Review"]],
  ["its hours are re-placed, not dropped", totalMin(invaded), 480],
];

let failed = 0;
for (const [label, actual, expected] of checks) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
console.log(`${checks.length - failed}/${checks.length} multi-pin checks passed`);
process.exit(failed ? 1 : 0);
