// Sanity check for "why isn't this scheduled"
// (run: npx tsx scripts/sanity-check-why-not.mjs).
//
// Every reason this module gives is a claim about the user's settings, so a
// confident wrong one sends them to change the wrong thing — worse than the
// silence it replaces. So each case here sets up exactly one real cause and
// checks that the reason names THAT and not something else, and the ordering
// cases check that a benign cause (it starts later) never gets reported as a
// capacity problem.
//
// Runs the real engine, because the input is what the engine actually failed to
// place, not a hand-written claim about it.

import { computeSchedule } from "../src/lib/scheduling/engine.ts";
import { whyNotTask, whyNotCommitment } from "../src/lib/scheduling/why-not.ts";

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
function checkThat(label, condition, detail = "") {
  checks++;
  if (!condition) failures++;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : `  ${detail}`}`);
}

const MONDAY = new Date(2026, 7, 3, 8, 0);
const RESEARCH = "research-label";
const DEEP = "deep-label";

const CATEGORIES = [
  { id: RESEARCH, name: "Research", color: "#d9748f", sortOrder: 0, minChunkMin: 60 },
  { id: DEEP, name: "Deep focus", color: "#d99a5e", sortOrder: 1, minChunkMin: 90, timePref: "morning_only" },
];

const WEEKLY_HOURS = {
  0: { start: 540, end: 1020 },
  1: { start: 540, end: 1020 },
  2: { start: 540, end: 1020 },
  3: { start: 540, end: 1020 },
  4: { start: 540, end: 1020 },
  5: null,
  6: null,
};

function build(over = {}) {
  const inputs = {
    timezone: "UTC",
    horizonWeeks: 2,
    weeklyHours: over.weeklyHours ?? WEEKLY_HOURS,
    tasks: over.tasks ?? [],
    projects: over.projects ?? [],
    events: over.events ?? [],
    recurringRules: [],
    dayOverrides: {},
    graceHours: 4,
    allDayBlocks: over.allDayBlocks ?? {},
    researchPins: [],
    completed: {},
    partial: {},
    pinned: {},
    labelNames: { [RESEARCH]: "Research", [DEEP]: "Deep focus" },
    historyBlocks: [],
    labelTargetPct: over.labelTargetPct ?? {},
    labelTargetBasis: {},
  };
  // The engine's clock and the explanation's clock MUST agree: with the engine
  // running from Monday it fills Monday, and an explanation that thinks it is
  // Thursday then has nothing to explain. Both come from `now` here.
  const now = over.now ?? MONDAY;
  const schedule = computeSchedule(inputs, now);
  const dow = (now.getDay() + 6) % 7;
  return {
    inputs,
    schedule,
    categories: CATEGORIES,
    weekStart: new Date(2026, 7, 3),
    nowAbs: dow * 1440 + now.getHours() * 60 + now.getMinutes(),
  };
}

const task = (over = {}) => ({
  id: "t1",
  title: "Analysis",
  priority: "medium",
  duration: 120,
  chunk: 60,
  minChunk: 60,
  deadline: 99999,
  floor: 0,
  categoryId: RESEARCH,
  ...over,
});

// ----------------------------------------------------- nothing wrong at all

{
  const t = task();
  const ctx = build({ tasks: [t] });
  check("a task that fits gets no explanation", whyNotTask(t, ctx), null);
}

// -------------------------------------------------------- it starts later

{
  // floor two weeks out, horizon two weeks: nothing to decide yet.
  const t = task({ floor: 20 * 1440 });
  const ctx = build({ tasks: [t] });
  const r = whyNotTask(t, ctx);
  checkThat("work that can't start yet is explained", r != null);
  check("and marked benign rather than as a capacity problem", r?.benign, true);
  check("with no setting to change", r?.fix, null);
  checkThat("naming the date it can start", r?.text.includes("Aug 23"), r?.text);
}

// ------------------------------------------------------ impossible window

// The engine places such work LATE rather than not at all, so it never shows up
// as unplaced — the reason has to be checked independently of that, or the one
// contradiction guaranteed to be reported at risk forever goes unexplained.
{
  const t = task({ floor: 5 * 1440, deadline: 2 * 1440 });
  const ctx = build({ tasks: [t] });
  const r = whyNotTask(t, ctx);
  checkThat("a deadline before the earliest start is named as impossible", r?.text.includes("impossible"), r?.text);
  check("and is not benign", r?.benign, false);
  checkThat("both dates are given", r?.text.includes("Aug 5") && r?.text.includes("Aug 8"), r?.text);
  checkThat("and it says the work was placed late rather than dropped", r?.text.includes("late"), r?.text);
  checkThat("the task IS scheduled, which is why this can't come from unplaced", ctx.schedule.unplaced.length === 0, JSON.stringify(ctx.schedule.unplaced));
}

// ------------------------------------- shorter than the label's minimum chunk
// Documents that this is NOT a reason. A minimum chunk governs shrinking a block
// to fit a gap — `floor = Math.min(floorMin, remaining)` — so it never exceeds
// what is left and a 20-minute task under a 60-minute floor schedules normally.
// A reason claiming otherwise was written, failed here, and was deleted.

{
  const t = task({ duration: 20, chunk: 20 });
  const ctx = build({ tasks: [t] });
  check("a task shorter than its label's minimum chunk still schedules", whyNotTask(t, ctx), null);
}

// ------------------------------------------------ locked to half a day
// A morning-only task in a horizon whose mornings are entirely taken: the
// afternoons are free and unusable, which is the confusing part worth naming.

{
  const wall = [];
  for (let gday = 0; gday < 14; gday++) {
    if (gday % 7 > 4) continue;
    wall.push({ id: `m${gday}`, title: "All morning", gday, start: 540, end: 720 });
  }
  const t = task({ duration: 180, chunk: 90, minChunk: 90, timeOfDay: "morning", categoryId: DEEP });
  const ctx = build({ tasks: [t], events: wall });
  const r = whyNotTask(t, ctx);
  checkThat("a half-day restriction with no room says which half", r?.text.includes("morning"), r?.text);
  checkThat(
    "and says the other half is free but unusable",
    r?.text.includes("afternoons may be free"),
    r?.text,
  );
  checkThat("pointing at the label's own setting", r?.fix?.includes("Deep focus"), r?.fix);
}

// ----------------------------------------------------- the week really is full

{
  const wall = [];
  for (let gday = 0; gday < 14; gday++) {
    if (gday % 7 > 4) continue;
    wall.push({ id: `f${gday}`, title: "Booked", gday, start: 540, end: 1020 });
  }
  const t = task({ duration: 180 });
  const ctx = build({ tasks: [t], events: wall });
  const r = whyNotTask(t, ctx);
  checkThat("a genuinely full horizon says so", r?.text.includes("nowhere to go"), r?.text);
  checkThat("with the amount that didn't fit", r?.text.includes("3h"), r?.text);
  check("and is not benign", r?.benign, false);
}

// ------------------------------------------------------------- commitments

const project = (over = {}) => ({
  id: "p1",
  title: "ACE2",
  weeklyMinMin: 240,
  chunk: 120,
  minChunk: 60,
  categoryId: RESEARCH,
  ...over,
});

{
  const p = project();
  const ctx = build({ projects: [p] });
  check("a commitment whose hours all land gets no explanation", whyNotCommitment(p, ctx), null);
}

check(
  "a commitment with no weekly hours has nothing to explain",
  whyNotCommitment(project({ weeklyMinMin: null }), build({ projects: [project({ weeklyMinMin: null })] })),
  null,
);

{
  const p = project({ activeFromAbs: 20 * 1440 });
  const ctx = build({ projects: [p] });
  const r = whyNotCommitment(p, ctx);
  checkThat("an active window that hasn't started is the whole answer", r?.text.includes("don't start until"), r?.text);
  check("and is benign", r?.benign, true);
}

{
  const p = project({ activeUntilAbs: 0 });
  const ctx = build({ projects: [p] });
  const r = whyNotCommitment(p, ctx);
  checkThat("an expired window says when it stopped", r?.text.includes("stopped applying"), r?.text);
  check("and is benign too", r?.benign, true);
}

{
  const wall = [];
  for (let gday = 0; gday < 14; gday++) {
    if (gday % 7 > 4) continue;
    wall.push({ id: `w${gday}`, title: "Booked", gday, start: 540, end: 1020 });
  }
  const p = project();
  // Monday 8am, so the week is genuinely ahead and genuinely full.
  const ctx = build({ projects: [p], events: wall });
  const r = whyNotCommitment(p, ctx);
  checkThat("a full week reports the shortfall in hours", r?.text.includes("didn't fit"), r?.text);
  checkThat("against what it was actually asked for", r?.text.includes("of its 4h"), r?.text);
  checkThat("and says how little is left ahead", r?.text.includes("still ahead"), r?.text);
}

// A WEEK THAT IS OVER, NOT FULL. The distinction this check exists for: a
// conference week whose one working day was Monday has hours of unbooked
// capacity and nothing can be put in it on Thursday. Calling that "already
// taken" is false and sends you looking for something to cancel.
{
  const p = project();
  const ctx = build({
    projects: [p],
    // Only Monday open; the rest of the week is away.
    allDayBlocks: { 1: "away", 2: "away", 3: "away", 4: "away" },
    // Thursday: the only open day was Monday, and it has gone.
    now: new Date(2026, 7, 6, 8, 0),
  });
  const r = whyNotCommitment(p, ctx);
  checkThat("a week whose working days have passed says exactly that", r?.text.includes("already passed"), r?.text);
  check("and is benign — there is nothing to fix", r?.benign, true);
  checkThat("never claiming the hours were taken", !r?.text.includes("already taken"), r?.text);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
