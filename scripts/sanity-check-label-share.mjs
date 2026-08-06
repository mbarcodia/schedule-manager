// Sanity check for what a label's "% of week" is a share OF, and for labelled
// routines counting toward it (run: npx tsx scripts/sanity-check-label-share.mjs).
//
// This runs the real engine over synthetic inputs, because the thing being
// checked is what gets PLACED, not a formatting rule. Two behaviours it pins:
//
//   BASIS. "week" reads 40% as a share of the whole working window with meetings
//   still in it — 16h of a 40h week however busy it is — so a week too full says
//   so instead of moving the goal. "after_meetings" takes them out first, which
//   shrinks the goal until it fits. Both are legitimate; the user picks per label.
//
//   ROUTINES. A weekly literature scan wearing the label is part of the share, so
//   the commitments are asked for the remainder. Without that, "projects,
//   proposals and literature reading combined should get 40%" overshoots.

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

function run(over = {}) {
  const inputs = {
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
  const s = computeSchedule(inputs, new Date(2026, 7, 3, 8, 0));
  return s.labelTargetsByWeek[0][0];
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
  "THE COMMITMENTS ARE ASKED FOR THE REMAINDER, so the combined total lands on the target",
  (() => {
    const bare = run();
    const withScan = run({ recurringRules: LIT_SCAN });
    // Same target either way; what the commitments supply drops by the routine.
    return [withScan.targetMin, bare.askedMin - withScan.askedMin + withScan.routineMin];
  })(),
  [960, 120],
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

check(
  "routines alone can meet a small target without asking for negative hours",
  (() => {
    const r = run({
      inputs: { labelTargetPct: { [RESEARCH]: 2 } },
      recurringRules: [
        { id: "r4", title: "Big scan", days: [0, 1, 2, 3, 4], length: 120, winStart: null, winEnd: null, categoryId: RESEARCH },
      ],
    });
    return [r.targetMin, r.routineMin, r.askedMin >= r.routineMin];
  })(),
  [48, 600, true],
);

// ------------------------------------------------------------- what's reported

check("the basis is reported so the view can explain itself", run().basis, "week");
check("and the other one too", run({ basis: "after_meetings" }).basis, "after_meetings");

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
