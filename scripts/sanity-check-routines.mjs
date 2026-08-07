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

// ---------------------------------------------------------------------------
// ANCHORED ROUTINES (migration 0039): the same rule stated as "the first thing
// in my day" rather than as 9:00, so it follows the hours instead of needing to
// be changed in two places.

const anchoredRules = (over = {}) => [
  { id: "r-email", title: "Emails", days: [0, 1, 2, 3, 4], length: 15, winStart: null, winEnd: null, anchor: "day_start", ...over },
];

const anchored = computeSchedule(inputs({ rules: anchoredRules() }), MONDAY).blocks;
check("anchored: takes the 9:00 open", at(anchored, 0, "Emails")?.start, 9 * 60);
check("anchored: follows a late-opening day to 11:00", at(anchored, 3, "Emails")?.start, 11 * 60);
check("anchored: appears on all five weekdays", anchored.filter((b) => b.title === "Emails").length, 5);

// The point of the whole feature: work cannot be placed in front of it. An
// unanchored 9:00-9:15 routine gives the same answer on a normal day — this is
// the day whose hours moved, where the fixed one used to leave a gap in front.
const withWork = {
  ...inputs({ rules: anchoredRules() }),
  tasks: [
    { id: "t1", title: "Write", priority: "high", duration: 120, chunk: 60, deadline: 99999, floor: 0 },
  ],
};
const workBlocks = computeSchedule(withWork, MONDAY).blocks;
const firstWorkThu = workBlocks.filter((b) => b.gday === 3 && b.taskId === "t1").sort((a, b) => a.start - b.start)[0];
const firstWorkMon = workBlocks.filter((b) => b.gday === 0 && b.taskId === "t1").sort((a, b) => a.start - b.start)[0];
check("anchored: no work before it on a normal day", firstWorkMon == null || firstWorkMon.start >= 9 * 60 + 15, true);
check("anchored: no work before it on the late day either", firstWorkThu == null || firstWorkThu.start >= 11 * 60 + 15, true);

// A meeting sitting on the opening: slide within the first half of the day.
const meetingAtOpen = {
  ...inputs({ lateDay: 9, rules: anchoredRules() }),
  events: [{ id: "e1", title: "Standup", gday: 0, start: 9 * 60, end: 9 * 60 + 30 }],
};
check(
  "anchored: slides past a meeting on the opening",
  at(computeSchedule(meetingAtOpen, MONDAY).blocks, 0, "Emails")?.start,
  9 * 60 + 30,
);

// A morning booked solid: skipped for that day rather than turning up at 4pm,
// which is what "first thing" would have stopped meaning.
const morningFull = {
  ...inputs({ lateDay: 9, rules: anchoredRules() }),
  events: [{ id: "e2", title: "Offsite", gday: 0, start: 9 * 60, end: 15 * 60 }],
};
check(
  "anchored: skipped when its half of the day is full",
  at(computeSchedule(morningFull, MONDAY).blocks, 0, "Emails"),
  undefined,
);

// day_end is the mirror, and must not drift into the morning.
const endAnchored = inputs({
  lateDay: 9,
  rules: [{ id: "r-wrap", title: "Wrap up", days: [0], length: 30, winStart: null, winEnd: null, anchor: "day_end" }],
});
check("day_end: takes the last slot of the day", at(computeSchedule(endAnchored, MONDAY).blocks, 0, "Wrap up")?.start, 16 * 60 + 30);
const endBlocked = {
  ...endAnchored,
  events: [{ id: "e3", title: "Seminar", gday: 0, start: 16 * 60, end: 17 * 60 }],
};
check(
  "day_end: slides earlier when the close is taken",
  at(computeSchedule(endBlocked, MONDAY).blocks, 0, "Wrap up")?.start,
  15 * 60 + 30,
);

// Contention: a fixed slot on the day's opening keeps it, and the anchored
// routine goes after — the ordering anchorTightness imposes.
const contended = inputs({
  lateDay: 9,
  rules: [
    { id: "r-email", title: "Emails", days: [0], length: 15, winStart: null, winEnd: null, anchor: "day_start" },
    { id: "r-lab", title: "Lab meeting", days: [0], length: 60, winStart: 9 * 60, winEnd: 10 * 60 },
  ],
});
const contendedBlocks = computeSchedule(contended, MONDAY).blocks;
check("a fixed 9:00 routine keeps 9:00", at(contendedBlocks, 0, "Lab meeting")?.start, 9 * 60);
check("the anchored one goes after it", at(contendedBlocks, 0, "Emails")?.start, 10 * 60);

// ...and a "wherever it fits" routine no longer takes the opening out from
// under the thing that is meant to start the day.
const vsFlexible = inputs({
  lateDay: 9,
  rules: [
    { id: "r-flex", title: "Reading", days: [0], length: 60, winStart: null, winEnd: null },
    { id: "r-email", title: "Emails", days: [0], length: 15, winStart: null, winEnd: null, anchor: "day_start" },
  ],
});
const flexBlocks = computeSchedule(vsFlexible, MONDAY).blocks;
check("anchored beats a flexible routine to the opening", at(flexBlocks, 0, "Emails")?.start, 9 * 60);
check("the flexible one follows it", at(flexBlocks, 0, "Reading")?.start, 9 * 60 + 15);

// A day too short to hold it at all is still skipped, not forced.
const tinyDay = {
  ...inputs({ lateDay: 0, lateStart: 16 * 60 + 50, rules: anchoredRules({ length: 30 }) }),
};
check("a day shorter than the routine skips it", at(computeSchedule(tinyDay, MONDAY).blocks, 0, "Emails"), undefined);

console.log(failures ? `\n${failures} check(s) failed` : "\nall routine checks passed");
process.exit(failures ? 1 : 0);
