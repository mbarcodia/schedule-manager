// Sanity check for the week summary (run: npx tsx scripts/sanity-check-week-review.mjs).
//
// buildWeekReview is pure over blocks + logged rows, so synthetic ones are
// enough. The cases worth pinning down are the ones where a wrong answer would
// still look plausible: a missed block counting as work, a logged day landing in
// the wrong week, and a past week being given a target it can't have.

import { zonedDateKey } from "../src/lib/scheduling/time.ts";
import { buildWeekReview, cumulativeTarget } from "../src/lib/scheduling/week-review.ts";

let failures = 0;
let checks = 0;
function check(label, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// Monday 3 Aug 2026, so gday 0 is that Monday.
const WEEK_START = new Date(2026, 7, 3);
const day = (offsetDays) => new Date(2026, 7, 3 + offsetDays);

const WEEKLY_HOURS = {
  0: { start: 540, end: 1020 },
  1: { start: 540, end: 1020 },
  2: { start: 540, end: 1020 },
  3: { start: 540, end: 1020 },
  4: { start: 540, end: 1020 },
  5: null,
  6: null,
};

const block = (over) => ({
  type: "task",
  gday: 0,
  start: 540,
  end: 660,
  categoryId: "research",
  allDay: false,
  title: "x",
  ...over,
});

const CATEGORIES = [
  { id: "research", name: "Research", color: "#d9748f", sortOrder: 0 },
  { id: "teaching", name: "Teaching", color: "#6fae7c", sortOrder: 1 },
];
const PROJECTS = [{ id: "p1", title: "ACE2", categoryId: "research" }];

const run = (over = {}) =>
  buildWeekReview({
    schedule: {
      blocks: over.blocks ?? [],
      labelTargetsByWeek: over.labelTargetsByWeek ?? [[]],
      overflow: [],
      beyondHorizon: [],
      risk: [],
      nearDeadline: [],
      missed: [],
      labelTargets: [],
      weeklyTargetMinByProject: {},
    },
    projects: PROJECTS,
    categories: CATEGORIES,
    weeklyHours: over.weeklyHours ?? WEEKLY_HOURS,
    dayOverrides: over.dayOverrides ?? {},
    allDayBlocks: over.allDayBlocks ?? {},
    logged: over.logged ?? [],
    weekStart: WEEK_START,
    offset: over.offset ?? 0,
  });

// ------------------------------------------------------------------- capacity

check("five 8-hour days is the week's capacity", run().capacityMin, 5 * 480);
check("a closed day takes its hours out", run({ dayOverrides: { 2: { closed: true } } }).capacityMin, 4 * 480);
check("an away day takes its hours out too", run({ allDayBlocks: { 3: "away" } }).capacityMin, 4 * 480);
check(
  "a small week is known by comparison with its own standard, not a fixed threshold",
  (() => {
    const r = run({ allDayBlocks: { 1: "away", 2: "away", 3: "away", 4: "away" } });
    return [r.capacityMin, r.standardCapacityMin];
  })(),
  [480, 2400],
);
check("a normal week is not flagged as small", (() => {
  const r = run();
  return r.capacityMin === r.standardCapacityMin;
})(), true);

// ------------------------------------------------------------- what counts

{
  const r = run({
    blocks: [
      block({ end: 660 }), // 2h of work
      block({ type: "synced", start: 780, end: 840 }), // 1h meeting
      block({ type: "anchor", start: 900, end: 930 }), // 30m routine
    ],
  });
  check("work, meetings and routines are counted apart", [r.workBookedMin, r.meetingsMin, r.routinesMin], [120, 60, 30]);
  check("unbooked is what's left of the week", r.freeMin, 5 * 480 - 120 - 60 - 30);
}

check(
  "an all-day entry is not time — it never counts as a meeting",
  run({ blocks: [block({ type: "synced", allDay: true, start: 0, end: 1440 })] }).meetingsMin,
  0,
);

check(
  "A MISSED BLOCK IS NOT WORK — counting it would make a missed week look finished",
  run({ blocks: [block({ status: "missed" })] }).workBookedMin,
  0,
);

check(
  "a done block counts as both booked and done",
  (() => {
    const r = run({ blocks: [block({ status: "done" })] });
    return [r.workBookedMin, r.workDoneMin];
  })(),
  [120, 120],
);

// ------------------------------------------------------------ which week

check(
  "a block in next week doesn't count in this one",
  run({ blocks: [block({ gday: 7 })] }).workBookedMin,
  0,
);
check(
  "and does count when you look at next week",
  run({ blocks: [block({ gday: 7 })], offset: 1 }).workBookedMin,
  120,
);
check(
  "a logged day is placed by its date, not by an offset",
  run({ logged: [{ occurredDate: day(2), projectId: "p1", minutes: 90 }] }).byLabel.find((l) => l.label === "Research")
    ?.doneMin,
  90,
);
check(
  "logged hours from last week stay in last week",
  run({ logged: [{ occurredDate: day(-3), projectId: "p1", minutes: 90 }] }).byLabel.length,
  0,
);
check(
  "and show up when you look back at it",
  run({ logged: [{ occurredDate: day(-3), projectId: "p1", minutes: 90 }], offset: -1 }).byLabel.find(
    (l) => l.label === "Research",
  )?.doneMin,
  90,
);

// ---------------------------------------------------------------- targets

{
  const targets = [[{ label: "Research", pct: 40, capacityMin: 2400, targetMin: 960, plannedMin: 600, askedMin: 960, belowFloor: [] }]];
  const r = run({ blocks: [block({ start: 540, end: 1020 })], labelTargetsByWeek: targets });
  const research = r.byLabel.find((l) => l.label === "Research");
  check("the target comes from the engine, not recomputed here", research?.targetMin, 960);
  check("booked is counted from the blocks, not from the engine's own figure", research?.bookedMin, 480);
  check("a label with a target shows even at zero booked", run({ labelTargetsByWeek: targets }).byLabel.length, 1);
}

// ------------------------------------------------------- inside working hours
// Everything is measured within the window, because the capacity it is compared
// against is. Without this a conference week read "28.9h of meetings" against a
// week that opens 8h, which looks like a broken number rather than a conference.

check(
  "a meeting is counted only for the part inside working hours",
  run({ blocks: [block({ type: "synced", start: 960, end: 1200 })] }).meetingsMin,
  60,
);
check(
  "and the rest is reported separately rather than dropped",
  run({ blocks: [block({ type: "synced", start: 960, end: 1200 })] }).outOfHoursMeetingsMin,
  180,
);
check(
  "a meeting on an away day counts entirely as out of hours",
  (() => {
    const r = run({ blocks: [block({ type: "synced", gday: 1, start: 540, end: 660 })], allDayBlocks: { 1: "away" } });
    return [r.meetingsMin, r.outOfHoursMeetingsMin];
  })(),
  [0, 120],
);
check(
  "an evening meeting never makes free time negative",
  run({ blocks: [block({ type: "synced", start: 1080, end: 1380 })] }).freeMin,
  5 * 480,
);

// ------------------------------------- a shortfall that isn't about capacity
// The engine rounds each commitment's share to whole blocks no shorter than its
// minimum chunk, and those roundings don't cancel. A week can therefore report a
// shortfall with hours to spare — which reads as a bug unless the two figures
// are kept apart.

{
  const r = run({
    labelTargetsByWeek: [
      [
        {
          label: "Research",
          pct: 40,
          capacityMin: 2220,
          targetMin: 888,
          plannedMin: 810,
          askedMin: 810,
          belowFloor: ["NSF Smoke"],
        },
      ],
    ],
    blocks: [block({ start: 540, end: 900 })],
  });
  const research = r.byLabel.find((l) => l.label === "Research");
  check("the share and what was asked for are both reported", [research?.targetMin, research?.askedMin], [888, 810]);
  check("and so is the commitment that got nothing", research?.belowFloor, ["NSF Smoke"]);
  check("a shortfall can coexist with free time", r.freeMin > 0 && research.bookedMin < research.targetMin, true);
}

check(
  "A PAST WEEK HAS NO TARGET — it is a record, never re-planned",
  run({
    offset: -1,
    labelTargetsByWeek: [
      [{ label: "Research", pct: 40, capacityMin: 2400, targetMin: 960, plannedMin: 0, askedMin: 960, belowFloor: [] }],
    ],
    logged: [{ occurredDate: day(-3), projectId: "p1", minutes: 90 }],
  }).byLabel[0].targetMin,
  null,
);
check("and knows it is one", run({ offset: -1 }).isPast, true);

check(
  "work with no commitment can't be given a label, and says so",
  run({ logged: [{ occurredDate: day(1), projectId: null, minutes: 60 }] }).byLabel.map((l) => [l.label, l.doneMin]),
  [["No label", 60]],
);

// ------------------------------------------------------------- the day line

{
  const r = run();
  const line = cumulativeTarget(r, 960);
  check("the target line ends at the week's target", line[line.length - 1], 960);
  check("it doesn't climb on a day that's closed", [line[4], line[5], line[6]], [960, 960, 960]);
  check("and rises evenly across the open days", [line[0], line[1]], [192, 384]);
}

{
  // A Wednesday off: the line must not imply work that couldn't have happened.
  const r = run({ dayOverrides: { 2: { closed: true } } });
  const line = cumulativeTarget(r, 960);
  check("a closed midweek day flattens the line across it", line[1] === line[2], true);
  check("and the week still totals its target", line[6], 960);
}

// ------------------------------------------------ civil dates in a named zone
//
// zonedDateKey exists because localDateKey is the WRONG helper on the server:
// it formats in the runtime's zone, which on Vercel is UTC. The weekly-summary
// cron bounded occurred_date — a civil date in the USER's zone — with
// toISOString().slice(0,10), so an 8pm New York digest ran after midnight UTC
// and silently dropped the oldest logged day from the week it reported.
{
  const NY = "America/New_York";
  const BERLIN = "Europe/Berlin";
  // 22:00 in New York is 02:00 UTC the NEXT day.
  const evening = new Date("2026-08-07T02:00:00Z");
  check("an evening in New York is still that day", zonedDateKey(NY, evening), "2026-08-06");
  check("and UTC would have called it tomorrow", evening.toISOString().slice(0, 10), "2026-08-07");
  // 01:00 in Berlin is 23:00 UTC the PREVIOUS day.
  const earlyBerlin = new Date("2026-08-06T23:00:00Z");
  check("an early hour in Berlin is already the next day", zonedDateKey(BERLIN, earlyBerlin), "2026-08-07");
  check("and UTC would have called it yesterday", earlyBerlin.toISOString().slice(0, 10), "2026-08-06");
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
