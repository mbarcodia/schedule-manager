// Verifies the two hard split modes from migration 0042
// (run: npx tsx scripts/sanity-check-split-mode.mjs).
//
// What makes these worth pinning is that both are constraints the engine must
// REFUSE to break, and the failure mode of a broken one is silent: work still
// appears on the calendar, just split when it was not allowed to be. Nothing on
// screen says so. So every check here asserts the shape of the placement, not
// merely that the hours landed.
//
// The three cases that matter:
//   one_block  every minute in a single unbroken sitting, or nothing at all
//   one_day    may be cut up, but every piece on ONE day
//   free       today's behaviour, unchanged
//
// And two traps found while writing this:
//   * one_day must not commit to the first day a piece happens to fit on. The
//     earliest opening is routinely on a day with no room for the remainder, and
//     taking it would refuse work that a later day could have swallowed whole.
//   * a task's own minChunk must override its LABEL's in both directions, which
//     is a deliberate reversal (see migration 0042) and so exactly the thing a
//     future refactor is likely to "fix" back into a Math.max.

import { computeSchedule } from "../src/lib/scheduling/engine.ts";
import { whyNotTask } from "../src/lib/scheduling/why-not.ts";

const TZ = "America/New_York";
const TASK = "55555555-5555-5555-5555-555555555555";

// A Monday, so gday 0 is that day. Fixed, never relative to today: a fixture
// dated a few days out silently changes meaning when the calendar passes it.
const MONDAY = new Date(2026, 6, 27, 8, 0);

const NO_DEADLINE = 99999;

/** Working days 9-17 Mon-Fri, with whatever meetings a case needs. */
function inputs({ splitMode = "free", duration = 240, minChunk = 30, chunk = 120, busy = [], deadline = NO_DEADLINE, maxPerDayMin = null }) {
  return {
    timezone: TZ,
    horizonWeeks: 2,
    weeklyHours: Object.fromEntries(
      Array.from({ length: 7 }, (_, d) => [d, d < 5 ? { start: 9 * 60, end: 17 * 60 } : null]),
    ),
    tasks: [
      {
        id: TASK,
        title: "Abstract",
        priority: "medium",
        duration,
        chunk,
        minChunk,
        splitMode,
        deadline,
        floor: 0,
        ord: 0,
        maxPerDayMin,
      },
    ],
    projects: [],
    events: busy.map((b, i) => ({ id: `e${i}`, title: "meeting", ...b })),
    recurringRules: [],
    dayOverrides: {},
    graceHours: 4,
    allDayBlocks: {},
    researchPins: [],
    completed: {},
    partial: {},
    pinned: {},
    labelNames: {},
    labelTargetPct: {},
    labelTargetBasis: {},
    historyBlocks: [],
  };
}

const chunksOf = (blocks) => blocks.filter((b) => b.taskId === TASK);
const minutes = (blocks) => blocks.reduce((s, b) => s + (b.end - b.start), 0);
const daysUsed = (blocks) => new Set(blocks.map((b) => b.gday)).size;

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "  OK" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

// ---------------------------------------------------------------- one_block

// An empty week: 4 hours in one sitting is easy, and must actually be ONE block.
{
  const blocks = chunksOf(computeSchedule(inputs({ splitMode: "one_block" }), MONDAY).blocks);
  check("one_block on an empty week places everything", minutes(blocks), 240);
  check("one_block places it as a single block", blocks.length, 1);
}

// The same 4 hours with "free" splits into the 120-minute preference, which is
// what makes the case above a real assertion rather than a coincidence.
{
  const blocks = chunksOf(computeSchedule(inputs({ splitMode: "free" }), MONDAY).blocks);
  check("free splits the same task into pieces", blocks.length > 1, true);
}

// Every day chopped so the longest unbroken gap is 90 minutes. 4 hours in one
// sitting is now impossible anywhere — and must be REFUSED, not quietly split.
{
  const busy = [];
  for (let gday = 0; gday < 14; gday++) {
    busy.push({ gday, start: 10 * 60 + 30, end: 12 * 60 });
    busy.push({ gday, start: 13 * 60 + 30, end: 15 * 60 + 30 });
  }
  const result = computeSchedule(inputs({ splitMode: "one_block", busy }), MONDAY);
  const blocks = chunksOf(result.blocks);
  check("one_block with no run long enough places nothing", blocks.length, 0);
  check("and it is reported as not fitting", result.overflow.includes("Abstract"), true);

  // The explanation must name the real reason — the hours exist, in 90-minute
  // pieces — rather than falling through to "your calendar is full".
  const reason = whyNotTask(inputs({ splitMode: "one_block", busy }).tasks[0], {
    inputs: inputs({ splitMode: "one_block", busy }),
    schedule: result,
    categories: [],
    weekStart: MONDAY,
    nowAbs: 0,
  });
  check("why-not blames the shape, not the capacity", /one sitting/.test(reason?.text ?? ""), true);
  check("why-not reports the longest real gap", /1\.5h/.test(reason?.text ?? ""), true);
}

// ------------------------------------------------------------------ one_day

// 4 hours, all on one day, on an empty week: may be split, must be one day.
{
  const blocks = chunksOf(computeSchedule(inputs({ splitMode: "one_day" }), MONDAY).blocks);
  check("one_day places everything", minutes(blocks), 240);
  check("one_day uses exactly one day", daysUsed(blocks), 1);
}

// THE TRAP. Monday has a single 2-hour opening and nothing more; Tuesday is
// wide open. A scheduler that commits to the first day something fits on would
// take Monday, place 2 of the 4 hours, and then refuse the rest. The whole task
// must land on Tuesday instead.
{
  const busy = [
    // Monday: only 9:00-11:00 free, rest of the day booked.
    { gday: 0, start: 11 * 60, end: 17 * 60 },
  ];
  const blocks = chunksOf(computeSchedule(inputs({ splitMode: "one_day", busy }), MONDAY).blocks);
  check("one_day skips a day that can't hold all of it", minutes(blocks), 240);
  check("one_day still uses a single day", daysUsed(blocks), 1);
  check("and that day is not the half-open Monday", blocks.every((b) => b.gday !== 0), true);
}

// No day anywhere has 4 free hours: every day holds at most 3. Refused.
{
  const busy = [];
  for (let gday = 0; gday < 14; gday++) busy.push({ gday, start: 12 * 60, end: 17 * 60 });
  const result = computeSchedule(inputs({ splitMode: "one_day", busy }), MONDAY);
  check("one_day with no day big enough places nothing", chunksOf(result.blocks).length, 0);
  check("and it is reported as not fitting", result.overflow.includes("Abstract"), true);

  const reason = whyNotTask(inputs({ splitMode: "one_day", busy }).tasks[0], {
    inputs: inputs({ splitMode: "one_day", busy }),
    schedule: result,
    categories: [],
    weekStart: MONDAY,
    nowAbs: 0,
  });
  check("why-not blames the one-day rule", /one day/.test(reason?.text ?? ""), true);
  check("why-not reports the emptiest day", /3h free/.test(reason?.text ?? ""), true);
}

// A per-day cap below the duration makes one_day impossible by construction —
// the two settings contradict, and the refusal must say which cap did it.
{
  const result = computeSchedule(inputs({ splitMode: "one_day", maxPerDayMin: 120 }), MONDAY);
  check("one_day under a smaller daily cap places nothing", chunksOf(result.blocks).length, 0);
  const reason = whyNotTask(inputs({ splitMode: "one_day", maxPerDayMin: 120 }).tasks[0], {
    inputs: inputs({ splitMode: "one_day", maxPerDayMin: 120 }),
    schedule: result,
    categories: [],
    weekStart: MONDAY,
    nowAbs: 0,
  });
  check("why-not names the daily cap as the fix", /2h-a-day cap/.test(reason?.fix ?? ""), true);
}

// ----------------------------------------------------- interaction with the rest

// one_day must still respect the minimum chunk: 4 hours with a 90-minute floor
// on one day is 90+150 or 120+120, never a 30-minute tail.
{
  const busy = [{ gday: 0, start: 9 * 60, end: 17 * 60 }]; // push it off Monday
  const blocks = chunksOf(computeSchedule(inputs({ splitMode: "one_day", minChunk: 90, busy }), MONDAY).blocks);
  check("one_day honours the minimum chunk", blocks.every((b) => b.end - b.start >= 90), true);
  check("one_day with a floor still fits on one day", daysUsed(blocks), 1);
}

// A deadline still bounds a one_day task: it may not silently slide past it when
// an earlier day would have held it.
{
  const busy = [{ gday: 0, start: 9 * 60, end: 17 * 60 }]; // Monday full
  const deadline = 2 * 1440; // end of Tuesday
  const blocks = chunksOf(computeSchedule(inputs({ splitMode: "one_day", busy, deadline }), MONDAY).blocks);
  check("one_day respects a deadline", blocks.every((b) => b.gday * 1440 + b.end <= deadline), true);
}

// one_block, likewise: the single sitting has to land before the deadline when
// one fits there.
{
  const deadline = 2 * 1440;
  const blocks = chunksOf(computeSchedule(inputs({ splitMode: "one_block", deadline }), MONDAY).blocks);
  check("one_block respects a deadline", blocks.every((b) => b.gday * 1440 + b.end <= deadline), true);
  check("one_block before a deadline is still one block", blocks.length, 1);
}

// THE PIN TRAP. Dragging a task to "In progress" pins one chunk to today and
// leaves the remainder to be placed normally. For a one_day task that remainder
// must join the pin's day — otherwise the board's own drag is what breaks the
// rule, and it does it silently.
{
  const pinned = inputs({ splitMode: "one_day", duration: 240 });
  // Pin 2 of the 4 hours to Tuesday morning; the other 2 must land on Tuesday.
  pinned.tasks[0].pins = [{ gday: 1, start: 9 * 60, length: 120 }];
  const blocks = chunksOf(computeSchedule(pinned, MONDAY).blocks);
  check("a pinned one_day task places all of it", minutes(blocks), 240);
  check("and every piece is on the pinned day", daysUsed(blocks), 1);
  check("which is the day it was pinned to", blocks.every((b) => b.gday === 1), true);
}

// The same pin on a FREE task is unconstrained — proving the check above is
// testing the split mode rather than something pins do on their own.
{
  const pinned = inputs({ splitMode: "free", duration: 240, chunk: 120 });
  pinned.tasks[0].pins = [{ gday: 1, start: 9 * 60, length: 120 }];
  const blocks = chunksOf(computeSchedule(pinned, MONDAY).blocks);
  check("a pinned free task still places all of it", minutes(blocks), 240);
}

// A task shorter than its own minimum chunk is placed at its real length rather
// than made unschedulable — the existing rule, which one_day must not break.
{
  const blocks = chunksOf(
    computeSchedule(inputs({ splitMode: "one_day", duration: 30, minChunk: 90 }), MONDAY).blocks,
  );
  check("a task shorter than its floor still schedules", minutes(blocks), 30);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall split-mode checks passed");
process.exit(failures ? 1 : 0);
