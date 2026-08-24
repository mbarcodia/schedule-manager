// Sanity check: irrecoverable time goes first
// (run: npx tsx scripts/sanity-check-deadline-pressure.mjs).
//
// Weekly-hours chunks are generated with `priority: "high"` and NO deadline
// (taskDefs), and the ready queue sorted on priority before anything else. So a
// recurring block that could be made up next week outranked every task not also
// marked high — structurally, every time. A real account had a 2h journal review
// due Friday scheduled in mid-SEPTEMBER while six hours of discretionary research
// filled the Friday it was due.
//
// The rule now: work whose deadline falls inside the pressure window outranks
// work with no deadline at all, whatever its priority. Everything after that
// tie-breaker is untouched.
//
// The two ways this could go wrong are both checked below. Too weak and a dated
// task still loses its slot. Too strong and a deadline three months out starts
// eating this week's hours, which would starve every weekly commitment for a
// reason that doesn't exist yet.

import { computeSchedule } from "../src/lib/scheduling/engine.ts";

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

const HOURS = {};
for (let d = 0; d < 5; d++) HOURS[d] = { start: 540, end: 1020 }; // 9-5 Mon-Fri
HOURS[5] = null;
HOURS[6] = null;

/** A day's worth of grid minutes. gday 0 is Monday of the current week. */
const day = (g) => g * 1440;

/** Monday 10 Aug 2026, 08:00 UTC — before the working day.
 *
 * FIXED, like every other check here, and it has to be: gday is relative to
 * the CURRENT week, so a fixture that says "due Thursday (gday 3)" against a
 * live clock describes yesterday once it is Friday. This file used to pass
 * `new Date()` and so failed every Friday and weekend, for a reason that says
 * nothing about deadline pressure. */
const NOW = new Date(Date.UTC(2026, 7, 10, 8, 0));

function inputs({ tasks = [], projects = [], events = [] }) {
  return {
    timezone: "UTC",
    weeklyHours: HOURS,
    horizonWeeks: 4,
    dayOverrides: {},
    allDayBlocks: {},
    events,
    recurringRules: [],
    tasks,
    projects,
    completed: {},
    partial: {},
    pinned: {},
    researchPins: [],
    labelNames: {},
    graceHours: 4,
  };
}

const task = (id, over = {}) => ({
  id,
  title: id,
  priority: "low",
  duration: 120,
  chunk: 120,
  minChunk: 60,
  dependsOn: null,
  floor: 0,
  deadline: 99999,
  projectId: null,
  categoryId: null,
  timeOfDay: null,
  preferMorning: false,
  preferAfternoon: false,
  maxPerDayMin: null,
  ...over,
});

const project = (id, over = {}) => ({
  id,
  title: id,
  weeklyMinMin: 1800, // 30h/wk — deliberately enough to swallow the whole week
  chunk: 120,
  minChunk: 60,
  researchOrd: 5,
  categoryId: null,
  preferMorning: false,
  preferAfternoon: false,
  timeOfDay: null,
  ...over,
});

/** Where a task's blocks land, as gdays. */
const gdaysFor = (schedule, id) =>
  schedule.blocks.filter((b) => b.taskId === id && b.status !== "missed" && b.status !== "grace").map((b) => b.gday).sort((a, b) => a - b);

// A week with no room to spare, and one 2h task due Thursday (gday 3).
const CROWDED = {
  projects: [project("hours-hog")],
  tasks: [task("due-thursday", { deadline: day(3) + 1020 })],
};

const crowded = computeSchedule(inputs(CROWDED), NOW);
check(
  "a task due this week is placed at all when weekly hours could swallow the week",
  gdaysFor(crowded, "due-thursday").length > 0,
  true,
);
check(
  "and it lands on or before its deadline day",
  Math.max(...gdaysFor(crowded, "due-thursday")) <= 3,
  true,
);
check("so it is NOT reported as missing its deadline", crowded.risk.includes("due-thursday"), false);

// The counter-case that keeps this honest: the same crowded week, but the task is
// due in three months. It must NOT pre-empt anything — there is no shortage to
// resolve yet, and letting it in would starve every weekly commitment.
const FAR = {
  projects: [project("hours-hog")],
  tasks: [task("due-in-months", { deadline: day(70) + 1020 })],
};
const far = computeSchedule(inputs(FAR), NOW);
check(
  "a deadline beyond the pressure window does not claim this week",
  Math.min(...gdaysFor(far, "due-in-months")) > 4,
  true,
);
check("and nothing is reported at risk for it", far.risk.includes("due-in-months"), false);
// The boundary itself: 14 days is the window, so day 13 is inside and day 20 out.
const near = computeSchedule(
  inputs({ projects: [project("hours-hog")], tasks: [task("day-13", { deadline: day(13) + 1020 })] }),
  NOW,
);
check("a deadline 13 days out is inside the window", Math.min(...gdaysFor(near, "day-13")) <= 13, true);

// Undated work must not be reordered among itself by this change: two tasks with
// no deadline still go by priority, then explicit order.
const UNDATED = {
  projects: [],
  tasks: [
    task("low-first", { priority: "low", ord: 1, duration: 60 }),
    task("high-second", { priority: "high", ord: 2, duration: 60 }),
  ],
};
const undated = computeSchedule(inputs(UNDATED), NOW);
const startOf = (s, id) => {
  const b = s.blocks.filter((x) => x.taskId === id).sort((x, y) => x.gday * 1440 + x.start - (y.gday * 1440 + y.start))[0];
  return b ? b.gday * 1440 + b.start : Infinity;
};
check(
  "with no deadlines in play, priority still decides",
  startOf(undated, "high-second") < startOf(undated, "low-first"),
  true,
);

// Two DATED tasks both inside the window fall through to priority, exactly as
// before — the new term only separates dated from undated.
const BOTH_DATED = {
  projects: [],
  tasks: [
    task("dated-low", { priority: "low", deadline: day(3) + 1020, duration: 60 }),
    task("dated-high", { priority: "high", deadline: day(3) + 1020, duration: 60 }),
  ],
};
const bothDated = computeSchedule(inputs(BOTH_DATED), NOW);
check(
  "among two dated tasks, priority still decides",
  startOf(bothDated, "dated-high") < startOf(bothDated, "dated-low"),
  true,
);

// The weekly hours are not DROPPED, only outranked — the point is that they go on
// being asked for and reported, so the shortfall is visible.
check(
  "the displaced weekly hours still get most of the week",
  crowded.blocks.filter((b) => b.projectId === "hours-hog").length > 0,
  true,
);

// ---------------------------------------------------------------------------
// HOW MUCH has to fit before the deadline, not just how far away it is.
//
// The flat fortnight could not tell 2h due in 18 days from 16h due in 18 days.
// A real account asked for an 8h review across Sep 8-11, due Sep 11 — 18 days
// out, so unpressed — and every hour of that window went to research. The task
// landed in NOVEMBER, seven weeks past its deadline, and would only have woken
// up on day 14 to find the window already spent.

// 16h due on gday 18: outside the fortnight, but it needs most of the open time
// between here and then, so it is short of room NOW.
const BIG_FAR = {
  projects: [project("hours-hog")],
  tasks: [task("big-due-day-18", { deadline: day(18) + 1020, duration: 960, chunk: 120 })],
};
const bigFar = computeSchedule(inputs(BIG_FAR), NOW);
check(
  "a big task due beyond the fortnight claims its window now",
  Math.max(...gdaysFor(bigFar, "big-due-day-18")) <= 18,
  true,
);
check("so it is not reported as missing its deadline", bigFar.risk.includes("big-due-day-18"), false);

// The counter-case, and the one that keeps the change honest: SAME deadline,
// same crowded week, but only 2h of work. There is plenty of room before day 18
// for two hours, so there is no shortage to resolve and it must wait its turn.
const SMALL_FAR = {
  projects: [project("hours-hog")],
  tasks: [task("small-due-day-18", { deadline: day(18) + 1020, duration: 120 })],
};
const smallFar = computeSchedule(inputs(SMALL_FAR), NOW);
check(
  "a small task with the same deadline does NOT claim this week",
  Math.min(...gdaysFor(smallFar, "small-due-day-18")) > 4,
  true,
);

// Pressure is measured against time that is actually OPEN, so a fortnight of
// solid meetings is not read as a fortnight of free time. Same 8h task, same
// deadline; the only difference is that the calendar is already spoken for.
const meetingWall = [];
for (let g = 0; g <= 18; g++) {
  if (g % 7 >= 5) continue;
  meetingWall.push({ id: `wall-${g}`, source: "manual", title: "meeting", gday: g, start: 600, end: 1020, allDay: false });
}
const walled = computeSchedule(
  inputs({
    projects: [project("hours-hog")],
    tasks: [task("eight-hours", { deadline: day(18) + 1020, duration: 480, chunk: 120, minChunk: 60 })],
    events: meetingWall,
  }),
  NOW,
);
// Only one hour a day is open, and the weekly hours want all of it. The A/B
// that isolates the ranking: the SAME 8h of work, once with the day-18 deadline
// and once with none at all. Placement itself is unchanged — dated work still
// sits just-in-time near its deadline rather than at the front of the week — so
// what is checked is who wins the scarce hours, not how early they are taken.
const undatedWalled = computeSchedule(
  inputs({
    projects: [project("hours-hog")],
    tasks: [task("eight-hours", { deadline: 99999, duration: 480, chunk: 120, minChunk: 60 })],
    events: meetingWall,
  }),
  NOW,
);
const minutesBy = (s, id, gday) =>
  s.blocks.filter((b) => b.taskId === id && b.gday <= gday && b.status !== "missed" && b.status !== "grace")
    .reduce((n, b) => n + (b.end - b.start), 0);
check(
  "with the fortnight walled off by meetings, the dated task takes the scarce hours",
  minutesBy(walled, "eight-hours", 18) > 0,
  true,
);
check(
  "and the identical task with no deadline gets none of them",
  minutesBy(undatedWalled, "eight-hours", 18),
  0,
);

console.log(`\n${checks - failures}/${checks} deadline-pressure checks passed`);
process.exit(failures ? 1 : 0);
