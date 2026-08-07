// The two capacity assumptions, and the arithmetic that has to hold for them to
// mean anything (run: npx tsx scripts/sanity-check-reserve.mjs).
//
// The failure this exists to prevent is double-counting. An expected meeting
// load is a FORECAST: if it kept reserving 12h in a week that already has 12h of
// real meetings on it, the week would be charged twice for the same hours and
// would read as over-full whenever the forecast came true. The misc reserve is
// the opposite — a floor that must never decay, because nothing visible ever
// spends it.

import {
  NO_RESERVE,
  bookableMinForWeek,
  hasReserve,
  reserveBreakdown,
  reservedMinForWeek,
  typicalBookableWeekMin,
} from "../src/lib/scheduling/reserve.ts";
import { buildWeekReview } from "../src/lib/scheduling/week-review.ts";
import { computePace, paceSentence } from "../src/lib/scheduling/pace.ts";

const H = 60;
let failures = 0;
let checks = 0;
function check(label, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

const reserve = { expectedMeetingMin: 12 * H, miscMin: 8 * H };

console.log("== the forecast decays, the floor doesn't ==");
check("an empty week holds back both in full", reservedMinForWeek(reserve, 0), 20 * H);
check("5h of real meetings absorb 5h of the forecast", reservedMinForWeek(reserve, 5 * H), 15 * H);
check("once the forecast is met, only the floor stands", reservedMinForWeek(reserve, 12 * H), 8 * H);
check("and it never goes negative past that", reservedMinForWeek(reserve, 30 * H), 8 * H);
check("no reserve set = nothing held back", reservedMinForWeek(NO_RESERVE, 0), 0);
check("hasReserve is false only when both are zero", [hasReserve(NO_RESERVE), hasReserve({ expectedMeetingMin: 0, miscMin: 60 })], [false, true]);

console.log("\n== what a week can be asked for ==");
const week = { capacityMin: 40 * H, meetingsMin: 5 * H, routinesMin: 5 * H, reserve };
check("capacity minus meetings, routines and the reserve", bookableMinForWeek(week), 15 * H);
check("without a reserve it is just the free time", bookableMinForWeek({ ...week, reserve: NO_RESERVE }), 30 * H);
check(
  "a week whose meetings exceed its hours has no room, not negative room",
  bookableMinForWeek({ capacityMin: 8 * H, meetingsMin: 20 * H, routinesMin: 0, reserve }),
  0,
);
check("the breakdown splits the two", reserveBreakdown(reserve, 5 * H), {
  totalMin: 15 * H,
  meetingForecastMin: 7 * H,
  miscMin: 8 * H,
});
check("and is absent when nothing is reserved", reserveBreakdown(NO_RESERVE, 0), null);

console.log("\n== a normal week ==");
const weeklyHours = Object.fromEntries(
  Array.from({ length: 7 }, (_, d) => [d, d > 4 ? null : { start: 9 * H, end: 17 * H }]),
);
const routines = [
  { days: [0, 1, 2, 3, 4], length: 15 }, // 75m
  { days: [1, 3], length: 45 }, // 90m
];
// 40h - 2.75h routines - 12h forecast (no meetings on a week nobody has planned) - 8h floor
check("routines are counted from the rules", typicalBookableWeekMin(weeklyHours, routines, reserve), 40 * H - 165 - 20 * H);
check("weekend routines don't count, since none are ever placed", typicalBookableWeekMin(weeklyHours, [{ days: [5, 6], length: 60 }], NO_RESERVE), 40 * H);
check("no reserve leaves the gross week less routines", typicalBookableWeekMin(weeklyHours, routines, NO_RESERVE), 40 * H - 165);

console.log("\n== the week view ==");
const blocks = (list) => list.map((b) => ({ tagLabel: null, priority: null, title: "x", ...b }));
const review = (over = {}) =>
  buildWeekReview({
    schedule: {
      blocks: blocks([
        { type: "synced", gday: 0, start: 9 * H, end: 14 * H }, // 5h of meetings
        { type: "anchor", gday: 1, start: 9 * H, end: 14 * H }, // 5h of routines
        { type: "task", gday: 2, start: 9 * H, end: 16 * H }, // 7h of work
      ]),
      labelTargetsByWeek: [[]],
      labelTargets: [],
      overflow: [],
      beyondHorizon: [],
      unplaced: [],
      risk: [],
      nearDeadline: [],
      missed: [],
      weeklyTargetMinByProject: {},
    },
    projects: [],
    categories: [],
    weeklyHours,
    dayOverrides: {},
    allDayBlocks: {},
    logged: [],
    weekStart: new Date(2026, 7, 3),
    offset: 0,
    reserve,
    ...over,
  });

const r = review();
check("the week reports what it holds back", r.reservedMin, 15 * H);
check("of which the forecast part is what's left of it", r.reservedForMeetingsMin, 7 * H);
check("bookable is capacity less meetings, routines and reserve", r.bookableMin, 15 * H);
check("7h of work sits inside 15h of room", r.overBookedMin, 0);
check("free time is still reported gross, unchanged", r.freeMin, 40 * H - 5 * H - 5 * H - 7 * H);

// The same week with much more work booked: the plan has eaten into the reserve.
const heavy = review({
  schedule: {
    blocks: blocks([
      { type: "synced", gday: 0, start: 9 * H, end: 14 * H },
      { type: "anchor", gday: 1, start: 9 * H, end: 14 * H },
      { type: "task", gday: 2, start: 9 * H, end: 17 * H },
      { type: "task", gday: 3, start: 9 * H, end: 17 * H },
      { type: "task", gday: 4, start: 9 * H, end: 17 * H },
    ]),
    labelTargetsByWeek: [[]],
    labelTargets: [],
    overflow: [],
    beyondHorizon: [],
    unplaced: [],
    risk: [],
    nearDeadline: [],
    missed: [],
    weeklyTargetMinByProject: {},
  },
});
check("24h booked against 15h of room is 9h into the reserve", heavy.overBookedMin, 9 * H);

// A past week is a record: nothing is held back in hours already spent.
const past = review({ offset: -1 });
check("a past week reserves nothing", [past.reservedMin, past.overBookedMin], [0, 0]);

console.log("\n== pace stops advising the impossible ==");
const project = {
  id: "p1",
  title: "Proposal",
  weeklyMinMin: 4 * H,
  effortEstimateMin: 100 * H,
  deadlineDate: new Date(2026, 7, 21),
  deadlineKind: "hard",
  important: true,
};
const now = new Date(2026, 7, 7);
const paceOf = (bookableWeekMin) =>
  computePace({ projects: [project], targets: [], loggedByProject: { p1: 10 * H }, weeklyHours, now, bookableWeekMin })[0];

check("a rate no week can hold is flagged", paceOf(15 * H).exceedsWeekMin, 15 * H);
check("with no assumptions set, nothing is flagged", paceOf(null).exceedsWeekMin, null);
check(
  "a rate that fits is not flagged",
  computePace({
    projects: [{ ...project, effortEstimateMin: 12 * H, deadlineDate: new Date(2026, 8, 30) }],
    targets: [],
    loggedByProject: { p1: 1 * H },
    weeklyHours,
    now,
    bookableWeekMin: 15 * H,
  })[0].exceedsWeekMin,
  null,
);
check(
  "and the sentence says so rather than recommending it flatly",
  paceSentence(paceOf(15 * H)).includes("more than the 15h a normal week has free"),
  true,
);
check("without the ceiling the sentence is unchanged", paceSentence(paceOf(null)).includes("normal week"), false);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
