// Sanity check for what a label's "% of week" means now that it is a
// BENCHMARK, not an input to scheduling (run: npx tsx scripts/sanity-check-label-share.mjs).
//
// This runs the real engine over synthetic inputs, because the thing being
// checked is what gets PLACED, not a formatting rule. Three behaviours it pins:
//
//   PLACEMENT IS NEVER SCALED. A commitment always books its own declared
//   weeklyMinMin, in a normal week and in a week with almost no room — a
//   label's weekly_target_pct does not reshape it, even proportionally
//   between commitments sharing the label (migration 0053). Before this, a
//   travel week silently shrank every commitment under a label in lockstep;
//   now a week too small to hold what's declared reports exactly that.
//
//   THE TARGET STILL TRACKS CAPACITY. targetMin = capacityMin * pct / 100,
//   computed on one of two readings the user picks per label
//   (categories.target_basis) — "week" keeps meetings in the denominator,
//   "after_meetings" takes them out first. Both are legitimate; the user
//   picks per label.
//
//   ROUTINES STILL COUNT TOWARD askedMin. A weekly literature scan wearing
//   the label is real research time, so it's added into what the label
//   actually got asked for — askedMin is now simply declared-commitment-
//   minutes-plus-routine-minutes, with no scaling in either direction.

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

const WEEKLY_HOURS = {
  0: { start: 540, end: 1020 },
  1: { start: 540, end: 1020 },
  2: { start: 540, end: 1020 },
  3: { start: 540, end: 1020 },
  4: { start: 540, end: 1020 },
  5: null,
  6: null,
};

const RESEARCH = "research-label";

function buildInputs(over = {}) {
  return {
    timezone: "UTC",
    horizonWeeks: 2,
    weeklyHours: WEEKLY_HOURS,
    tasks: [],
    projects: over.projects ?? [
      { id: "p1", title: "Alpha", weeklyMinMin: 600, chunk: 120, minChunk: 60, categoryId: RESEARCH },
    ],
    events: over.events ?? [],
    recurringRules: over.recurringRules ?? [],
    dayOverrides: {},
    graceHours: 4,
    allDayBlocks: {},
    researchPins: [],
    completed: {},
    partial: {},
    pinned: {},
    labelNames: { [RESEARCH]: "Research" },
    historyBlocks: [],
    labelTargetPct: { [RESEARCH]: 40 },
    labelTargetBasis: { [RESEARCH]: over.basis ?? "week" },
    ...over.inputs,
  };
}

function run(over = {}) {
  const s = computeSchedule(buildInputs(over), new Date(Date.UTC(2026, 7, 3, 8, 0)));
  return s.labelTargetsByWeek[0][0];
}

/** Minutes actually placed for one project, week 0. */
function placedFor(schedule, projectId) {
  return schedule.blocks
    .filter((b) => b.projectId === projectId && Math.floor(b.gday / 7) === 0 && b.status !== "missed")
    .reduce((sum, b) => sum + (b.end - b.start), 0);
}

// A 40h week: five 8-hour days.
check("a whole-week basis takes the full window", run().capacityMin, 2400);
check("40% of it is 16h", run().targetMin, 960);

// Six hours of meetings on the Tuesday.
const MEETINGS = [{ id: "e1", title: "Workshop", gday: 1, start: 540, end: 900 }];

check(
  "MEETINGS DO NOT REDUCE A WHOLE-WEEK TARGET — 40% of 40h is still 16h",
  (() => {
    const r = run({ events: MEETINGS });
    return [r.capacityMin, r.targetMin];
  })(),
  [2400, 960],
);

check(
  "the other basis takes them out first, so the goal shrinks to fit",
  (() => {
    const r = run({ events: MEETINGS, basis: "after_meetings" });
    return [r.capacityMin, r.targetMin];
  })(),
  [2040, 816],
);

check("with no meetings the two bases agree", run({ basis: "after_meetings" }).targetMin, run().targetMin);

// ---------------------------------------------------- placement is not scaled

// Two commitments under Research, declared 6h and 4h — a 3:2 relationship
// that a scaling engine would have preserved under a target. There is no
// scaling anymore, so each should simply place its own declared minutes.
const TWO = [
  { id: "p1", title: "Alpha", weeklyMinMin: 360, chunk: 120, minChunk: 60, categoryId: RESEARCH },
  { id: "p2", title: "Beta", weeklyMinMin: 240, chunk: 120, minChunk: 60, categoryId: RESEARCH },
];

check(
  "in a normal week, each commitment books exactly its own declared minutes",
  (() => {
    const inputs = buildInputs({ projects: TWO });
    const s = computeSchedule(inputs, new Date(Date.UTC(2026, 7, 3, 8, 0)));
    return [placedFor(s, "p1"), placedFor(s, "p2")];
  })(),
  [360, 240],
);

// A week almost entirely eaten by meetings (9:00-16:30 every weekday) leaves
// only 30 minutes a day, 150 minutes for the week — nowhere near the 600
// declared minutes between the two commitments. A scaling engine would have
// shrunk both proportionally to fit; without scaling, the engine places what
// it can and reports the rest as unplaced/owed, rather than inventing a
// smaller "true" ask.
const NEAR_FULL_WEEK = Array.from({ length: 5 }, (_, d) => ({
  id: `busy${d}`,
  title: "Meetings",
  gday: d,
  start: 540,
  end: 990,
}));

check(
  "a week with almost no room still asks each commitment for its own declared minutes",
  run({ projects: TWO, events: NEAR_FULL_WEEK }).askedMin,
  600, // 360 + 240, unscaled
);

check(
  "and nothing invents a smaller 'fitted' target for that week",
  run({ projects: TWO, events: NEAR_FULL_WEEK }).targetMin,
  960, // still 40% of the 40h window — the week reports the shortfall instead of moving the goal
);

// ------------------------------------------------------------------ routines

const LIT_SCAN = [
  { id: "r1", title: "Lit scan", days: [0, 2], length: 60, winStart: null, winEnd: null, categoryId: RESEARCH },
];
const EMAILS = [{ id: "r2", title: "Emails", days: [0, 1, 2, 3, 4], length: 30, winStart: null, winEnd: null }];

check(
  "a labelled routine's minutes count toward the share",
  run({ recurringRules: LIT_SCAN }).routineMin,
  120,
);
check(
  "an unlabelled routine counts toward no share",
  run({ recurringRules: EMAILS }).routineMin,
  0,
);
check(
  "and an unlabelled routine does not reduce the target either",
  run({ recurringRules: EMAILS }).targetMin,
  960,
);

check(
  "ASKED IS DECLARED-PLUS-ROUTINE, not a remainder — no scaling happens either side",
  (() => {
    const bare = run();
    const withScan = run({ recurringRules: LIT_SCAN });
    // Same commitments declare the same minutes either way; the routine adds
    // on top rather than the commitments giving up what the routine covers.
    return [bare.askedMin, withScan.askedMin - withScan.routineMin];
  })(),
  [600, 600],
);

check(
  "a routine on a day the week doesn't open contributes nothing",
  run({
    recurringRules: [
      { id: "r3", title: "Weekend scan", days: [5, 6], length: 60, winStart: null, winEnd: null, categoryId: RESEARCH },
    ],
  }).routineMin,
  0,
);

// ------------------------------------------------------------- what's reported

check("the basis is reported so the view can explain itself", run().basis, "week");
check("and the other one too", run({ basis: "after_meetings" }).basis, "after_meetings");

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
