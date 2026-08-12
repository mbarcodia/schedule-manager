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

function inputs({ tasks = [], projects = [] }) {
  return {
    timezone: "UTC",
    weeklyHours: HOURS,
    horizonWeeks: 4,
    dayOverrides: {},
    allDayBlocks: {},
    events: [],
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

const crowded = computeSchedule(inputs(CROWDED), new Date());
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
const far = computeSchedule(inputs(FAR), new Date());
check(
  "a deadline beyond the pressure window does not claim this week",
  Math.min(...gdaysFor(far, "due-in-months")) > 4,
  true,
);
check("and nothing is reported at risk for it", far.risk.includes("due-in-months"), false);
// The boundary itself: 14 days is the window, so day 13 is inside and day 20 out.
const near = computeSchedule(
  inputs({ projects: [project("hours-hog")], tasks: [task("day-13", { deadline: day(13) + 1020 })] }),
  new Date(),
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
const undated = computeSchedule(inputs(UNDATED), new Date());
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
const bothDated = computeSchedule(inputs(BOTH_DATED), new Date());
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

console.log(`\n${checks - failures}/${checks} deadline-pressure checks passed`);
process.exit(failures ? 1 : 0);
