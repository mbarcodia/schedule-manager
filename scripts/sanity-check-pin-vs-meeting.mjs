// A pin yields to a meeting (run: npx tsx scripts/sanity-check-pin-vs-meeting.mjs).
//
// From a real report: the planner pinned next week's tasks, meetings then
// synced in on top of them, and the calendar showed tasks sitting inside
// meetings — hours that could never be worked.
//
// The mechanism, because it is worth not reintroducing: pinning is a FIXED
// placement. It writes its slot straight into the busy set rather than
// searching for a free one. Creating a pin refuses to overlap an event, but
// nothing re-checked afterwards, and markBusy only ADDS minutes — so a meeting
// arriving later did not push the pin aside, it just occupied the same
// minutes. Both blocks rendered. And because pinReduction had already taken
// the pinned minutes out of the auto-scheduling pool, the work was not
// re-placed anywhere else and nothing showed up in didNotFit either: the
// schedule called itself complete while holding an impossible hour.
//
// The rule this file defends is the app's core promise — everything that is
// not a meeting moves around the things that are, INCLUDING work the user
// pinned. A released pin's hours go back into the pool and get scheduled
// somewhere they can happen, and the release is reported rather than absorbed.
//
// AND ONLY FUTURE PINS ARE RELEASED. A past pin may already have been worked
// and ticked off; releasing it would take a completed block off the calendar,
// which is the same class of bug as a hold erasing logged work.

import { computeSchedule } from "../src/lib/scheduling/engine.ts";

let failures = 0;
let checks = 0;
function check(label, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

/** Monday 24 Aug 2026, 08:00 UTC — before the working day, so gday 0 is that
 * Monday and every slot below is still in the future. */
const NOW = new Date(Date.UTC(2026, 7, 24, 8, 0));
const RESEARCH = "cat-research";
const HOURS = {};
for (let d = 0; d < 5; d++) HOURS[d] = { start: 540, end: 1020 };
HOURS[5] = null;
HOURS[6] = null;

function inputs(over = {}) {
  return {
    timezone: "UTC",
    horizonWeeks: 3,
    weeklyHours: HOURS,
    dayOverrides: {},
    allDayBlocks: {},
    events: [],
    recurringRules: [],
    tasks: [],
    projects: [],
    completed: {},
    partial: {},
    pinned: {},
    researchPins: [],
    labelNames: { [RESEARCH]: "Research" },
    graceHours: 4,
    historyBlocks: [],
    currentWeekFallback: [],
    labelTargetPct: {},
    labelTargetBasis: {},
    ...over,
  };
}

const run = (over) => computeSchedule(inputs(over), NOW);
const PINNED_TASK = {
  id: "t1",
  title: "Pinned work",
  priority: "medium",
  duration: 60,
  chunk: 60,
  deadline: 99999,
  floor: 0,
  ord: 50,
  pins: [{ gday: 2, start: 600, length: 60 }],
};
/** Does any task block overlap any meeting? The thing that must never be true. */
const doubleBooked = (s) => {
  const tasks = s.blocks.filter((b) => b.type === "task");
  const meetings = s.blocks.filter((b) => b.type === "synced" && !b.allDay);
  return tasks.some((t) => meetings.some((m) => m.gday === t.gday && t.start < m.end && t.end > m.start));
};
const blocksFor = (s, id) => s.blocks.filter((b) => b.taskId === id);

// ------------------------------------------------- the pin is honoured normally

console.log("== an unobstructed pin still holds its slot ==");
const clean = run({ tasks: [PINNED_TASK] });
check("it sits exactly where it was pinned", blocksFor(clean, "t1").map((b) => [b.gday, b.start, b.end]), [[2, 600, 660]]);
check("nothing is reported as displaced", clean.displacedPins, []);

// ------------------------------------------------------------- the reported bug

console.log("\n== a meeting arriving on the pinned slot ==");
const clash = run({
  tasks: [PINNED_TASK],
  events: [{ id: "m1", title: "New meeting", gday: 2, start: 600, end: 660, allDay: false }],
});
check("the task is NOT double-booked with the meeting", doubleBooked(clash), false);
check("the work is still scheduled somewhere", blocksFor(clash, "t1").length > 0, true);
check("...for its full hour", blocksFor(clash, "t1").reduce((n, b) => n + (b.end - b.start), 0), 60);
check("...somewhere other than the taken slot", blocksFor(clash, "t1").every((b) => !(b.gday === 2 && b.start === 600)), true);
check("and the release is reported", clash.displacedPins, ["Pinned work"]);
check("the meeting itself is untouched", clash.blocks.filter((b) => b.type === "synced").map((b) => [b.gday, b.start]), [[2, 600]]);

// A partial overlap is just as impossible as an exact one.
console.log("\n== a meeting overlapping only part of the pin ==");
const partial = run({
  tasks: [PINNED_TASK],
  events: [{ id: "m2", title: "Overlapping meeting", gday: 2, start: 630, end: 700, allDay: false }],
});
check("a partial overlap also releases the pin", partial.displacedPins, ["Pinned work"]);
check("and nothing is double-booked", doubleBooked(partial), false);

// Touching but not overlapping must NOT release it — an adjacent meeting is
// the normal case and releasing on it would make pinning useless.
console.log("\n== a meeting that merely abuts the pin ==");
const abuts = run({
  tasks: [PINNED_TASK],
  events: [{ id: "m3", title: "Right after", gday: 2, start: 660, end: 720, allDay: false }],
});
check("an adjacent meeting leaves the pin alone", abuts.displacedPins, []);
check("the pin keeps its slot", blocksFor(abuts, "t1").map((b) => [b.gday, b.start]), [[2, 600]]);

// ------------------------------------------------------------- research pins

console.log("\n== a commitment's pinned hour behaves the same way ==");
const RESEARCH_PROJECT = {
  id: "p1",
  title: "Ocean study",
  weeklyMinMin: 180,
  chunk: 60,
  minChunk: 60,
  categoryId: RESEARCH,
  researchOrd: 5,
};
const rpClash = run({
  projects: [RESEARCH_PROJECT],
  researchPins: [{ projectId: "p1", gday: 2, start: 600, length: 60 }],
  events: [{ id: "m4", title: "New meeting", gday: 2, start: 600, end: 660, allDay: false }],
});
check("a research pin is released too", rpClash.displacedPins, ["Ocean study"]);
check("and nothing is double-booked", doubleBooked(rpClash), false);
check(
  "its weekly hours are still fully placed this week",
  rpClash.blocks.filter((b) => b.projectId === "p1" && b.gday < 7).reduce((n, b) => n + (b.end - b.start), 0),
  180,
);

// ------------------------------------------------- two pins on the same slot

console.log("\n== two pins claiming one slot ==");
const twoPins = run({
  tasks: [
    PINNED_TASK,
    { ...PINNED_TASK, id: "t2", title: "Other pinned work" },
  ],
});
check("the second is released rather than stacked", twoPins.displacedPins, ["Other pinned work"]);
check(
  "both are still scheduled, in different slots",
  new Set(
    [...blocksFor(twoPins, "t1"), ...blocksFor(twoPins, "t2")].map((b) => `${b.gday}-${b.start}`),
  ).size,
  2,
);

// --------------------------------------------------- history is not rewritten

console.log("\n== a pin whose time has passed is left alone ==");
// Same collision, seen from LATER THE SAME DAY, so the slot is history. The
// block must stay put even though a meeting overlaps it: it may have been
// worked and ticked off, and dropping it would erase that.
//
// gday is relative to the current week, so advancing NOW by a week does not
// move a gday into the past — it just renames the date. Wednesday afternoon is
// what puts gday 2's 10:00 slot behind us.
const past = computeSchedule(
  inputs({
    tasks: [PINNED_TASK],
    events: [{ id: "m5", title: "New meeting", gday: 2, start: 600, end: 660, allDay: false }],
  }),
  new Date(Date.UTC(2026, 7, 26, 14, 0)),
);
check("a past pin is not released", past.displacedPins, []);
check("its block is still on the calendar", past.blocks.some((b) => b.taskId === "t1" && b.gday === 2 && b.start === 600), true);

// ---------------------------------------------------------------- stability

console.log("\n== stability ==");
check(
  "computing twice on identical inputs gives an identical schedule",
  JSON.stringify(run({ tasks: [PINNED_TASK], events: [{ id: "m1", title: "New meeting", gday: 2, start: 600, end: 660, allDay: false }] }).blocks),
  JSON.stringify(clash.blocks),
);

console.log(`\n${checks - failures}/${checks} pin-vs-meeting checks passed`);
process.exit(failures ? 1 : 0);
