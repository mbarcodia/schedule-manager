// Verifies where a routine lands when the day doesn't open at its usual time
// (run: npx tsx scripts/sanity-check-routines.mjs).
//
// A routine pinned to 9:00-9:15 vanished entirely on a day whose hours start at
// 11:00 — the window fell outside the day, so the engine skipped it. Correct by
// the letter of the rule and wrong in spirit: "start work after emails" is about
// order, not about nine o'clock, so a Monday-to-Friday routine silently missing
// on one weekday is a bug from the user's side.

import { computeSchedule } from "../src/lib/scheduling/engine.ts";

const MONDAY = new Date(2026, 6, 27, 8, 0);
const DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Mon-Fri, but one weekday opens late. */
function inputs({ lateDay = 3, lateStart = 11 * 60, rules } = {}) {
  return {
    timezone: "America/New_York",
    horizonWeeks: 1,
    weeklyHours: Object.fromEntries(
      Array.from({ length: 7 }, (_, d) => [
        d,
        d > 4 ? null : { start: d === lateDay ? lateStart : 9 * 60, end: 17 * 60 },
      ]),
    ),
    tasks: [],
    projects: [],
    events: [],
    recurringRules: rules ?? [
      { id: "r-email", title: "Emails", days: [0, 1, 2, 3, 4], length: 15, winStart: 9 * 60, winEnd: 9 * 60 + 15 },
    ],
    dayOverrides: {},
    graceHours: 4,
    allDayBlocks: {},
    researchPins: [],
    completed: {},
    partial: {},
    pinned: {},
    tagLabels: { task: "Work", research: "Research", deepFocus: "Deep focus", block: "Routine" },
  };
}

const at = (blocks, gday, title) => blocks.find((b) => b.gday === gday && b.title === title);
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

const blocks = computeSchedule(inputs(), MONDAY).blocks;
for (const d of [0, 1, 2, 4]) {
  check(`${DAY[d]} keeps its 9:00 slot`, at(blocks, d, "Emails")?.start, 9 * 60);
}
check("Thu slides to the 11:00 open", at(blocks, 3, "Emails")?.start, 11 * 60);
check("Thu keeps its 15-minute length", at(blocks, 3, "Emails")?.end, 11 * 60 + 15);
check("it appears on all five weekdays", blocks.filter((b) => b.title === "Emails").length, 5);

// A day-override start (e.g. "I'm starting at 10 today") gets the same treatment.
const overridden = { ...inputs({ lateDay: 9 }), dayOverrides: { 0: { start: 10 * 60 } } };
check("a one-off late start also slides it", at(computeSchedule(overridden, MONDAY).blocks, 0, "Emails")?.start, 10 * 60);

// An evening routine on a day that closes earlier must NOT be dragged to the
// morning — skipping is right there.
const evening = inputs({
  lateDay: 9,
  rules: [{ id: "r-eve", title: "Wrap up", days: [0], length: 30, winStart: 18 * 60, winEnd: 19 * 60 }],
});
check("a routine after the day closes is skipped, not moved", at(computeSchedule(evening, MONDAY).blocks, 0, "Wrap up"), undefined);

console.log(failures ? `\n${failures} check(s) failed` : "\nall routine checks passed");
process.exit(failures ? 1 : 0);
