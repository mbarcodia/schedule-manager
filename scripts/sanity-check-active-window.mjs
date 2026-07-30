// Verifies the active window on a commitment's weekly hours (run: npx tsx
// scripts/sanity-check-active-window.mjs).
//
// Weekly hours used to apply to every week in the horizon, so a commitment that
// only starts next term booked time from the day it was created. The window
// bounds which weeks generate hours at all, and clips the week it starts or
// ends part-way through.

import { computeSchedule } from "../src/lib/scheduling/engine.ts";

const TZ = "America/New_York";
const COMMITMENT = "33333333-3333-3333-3333-333333333333";
const WEEKLY_MIN = 300; // 5h/week

// A Monday, so gday 0 is this same day and week boundaries are easy to reason
// about: week w starts at gday 7w.
const MONDAY = new Date(2026, 6, 27, 8, 0);
const gdayToAbs = (gday) => gday * 1440;

function inputs({ activeFromAbs = null, activeUntilAbs = null, timeOfDay = null } = {}) {
  return {
    timezone: TZ,
    horizonWeeks: 4,
    weeklyHours: Object.fromEntries(
      Array.from({ length: 7 }, (_, d) => [d, d < 5 ? { start: 9 * 60, end: 17 * 60 } : null]),
    ),
    tasks: [],
    projects: [
      {
        id: COMMITMENT,
        title: "Course prep",
        weeklyMinMin: WEEKLY_MIN,
        chunk: 120,
        preferMorning: true,
        timeOfDay,
        activeFromAbs,
        activeUntilAbs,
        researchOrd: 1,
        categoryId: null,
        deadlineDate: null,
      },
    ],
    events: [],
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

const minutesInWeek = (blocks, week) =>
  blocks
    .filter((b) => b.projectId === COMMITMENT && Math.floor(b.gday / 7) === week && b.status !== "missed")
    .reduce((sum, b) => sum + (b.end - b.start), 0);

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "  OK" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

// No window: every week gets its hours, which is the old behaviour and still
// the default.
const open = computeSchedule(inputs(), MONDAY).blocks;
check("unbounded, week 0", minutesInWeek(open, 0), WEEKLY_MIN);
check("unbounded, week 3", minutesInWeek(open, 3), WEEKLY_MIN);

// Starts at the beginning of week 2: the first two weeks generate nothing.
const startsLater = computeSchedule(inputs({ activeFromAbs: gdayToAbs(14) }), MONDAY).blocks;
check("starts week 2, week 0", minutesInWeek(startsLater, 0), 0);
check("starts week 2, week 1", minutesInWeek(startsLater, 1), 0);
check("starts week 2, week 2", minutesInWeek(startsLater, 2), WEEKLY_MIN);
check("starts week 2, week 3", minutesInWeek(startsLater, 3), WEEKLY_MIN);

// Ends at the close of week 1 (end of Tuesday gday 8, i.e. abs 9*1440).
const endsEarly = computeSchedule(inputs({ activeUntilAbs: gdayToAbs(9) }), MONDAY).blocks;
check("ends in week 1, week 0", minutesInWeek(endsEarly, 0), WEEKLY_MIN);
check("ends in week 1, week 2", minutesInWeek(endsEarly, 2), 0);
check("ends in week 1, week 3", minutesInWeek(endsEarly, 3), 0);
// Mon+Tue of week 1 hold 5 hours comfortably, so a window ending there clips
// nothing: the week still gets its full allowance.
check("ends in week 1, that week still fits", minutesInWeek(endsEarly, 1), WEEKLY_MIN);
const pastTheEnd = endsEarly.filter(
  (b) => b.projectId === COMMITMENT && b.gday * 1440 + b.end > gdayToAbs(9) && b.status !== "missed",
);
check("nothing placed past the window's end", pastTheEnd.length, 0);

// A window ending at Monday noon of week 1 leaves only 9am-12pm — three hours
// against a five-hour week, so that week is genuinely clipped rather than just
// bounded.
const tight = computeSchedule(inputs({ activeUntilAbs: gdayToAbs(7) + 12 * 60 }), MONDAY).blocks;
const clipped = minutesInWeek(tight, 1);
check("tight window clips the week", clipped > 0 && clipped < WEEKLY_MIN, true);
check("tight window fills the hours it can", clipped, 180);

// A window can also close a commitment out entirely.
const closed = computeSchedule(
  inputs({ activeFromAbs: gdayToAbs(1), activeUntilAbs: gdayToAbs(1) }),
  MONDAY,
).blocks;
check("zero-width window schedules nothing", minutesInWeek(closed, 0), 0);

// Time of day is the commitment's own business now: the engine used to force
// mornings on every weekly-hours block via the internal "research" tag.
const afternoons = computeSchedule(inputs({ timeOfDay: "afternoon" }), MONDAY).blocks.filter(
  (b) => b.projectId === COMMITMENT && b.status !== "missed",
);
check("afternoon commitment placed after noon", afternoons.every((b) => b.start >= 12 * 60), true);
check("afternoon commitment still gets its hours", minutesInWeek(afternoons, 0), WEEKLY_MIN);

const mornings = computeSchedule(inputs({ timeOfDay: "morning" }), MONDAY).blocks.filter(
  (b) => b.projectId === COMMITMENT && b.status !== "missed",
);
check("morning commitment placed before noon", mornings.every((b) => b.end <= 12 * 60), true);

console.log(failures ? `\n${failures} check(s) failed` : "\nall active-window checks passed");
process.exit(failures ? 1 : 0);
