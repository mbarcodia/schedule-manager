// Dated work sits near its deadline, not at the front of the week
// (run: npx tsx scripts/sanity-check-just-in-time.mjs).
//
// From a real complaint: a 2h session due NEXT Monday was scheduled on THIS
// Thursday, and the research minimum that wanted those hours lost them for a
// week it could never make up. Both halves of that were working as designed
// and the combination was still wrong:
//
//   deadlinePressure decides WHO PICKS FIRST, and dated work winning that is
//   correct — a deadline is irrecoverable, a weekly minimum is not.
//
//   findSlot decided WHERE they pick, and it took the earliest gap. So the
//   thing that outranked everything also sat at the front of the week.
//
// Those are separate questions. Dated work now takes the LATEST slot that
// still makes its deadline, which leaves the early slots to weekly minimums
// without ever trading a deadline away.
//
// THE BUFFER SCALES WITH PRIORITY, and that is not decoration. "Picks first"
// under a backwards search means "takes the latest free slot", which handed
// the most important work the LEAST recovery room. Buying more slack the more
// important the work is inverts that back.

import { computeSchedule } from "../src/lib/scheduling/engine.ts";

let failures = 0;
let checks = 0;
function check(label, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

/** Monday 10 Aug 2026, 08:00 UTC — before the working day, so gday 0 is that
 * Monday and nothing has elapsed. */
const NOW = new Date(Date.UTC(2026, 7, 10, 8, 0));
const RESEARCH = "cat-research";
const HOURS = {};
for (let d = 0; d < 5; d++) HOURS[d] = { start: 540, end: 1020 }; // 9-5 Mon-Fri
HOURS[5] = null;
HOURS[6] = null;

const day = (g) => g * 1440;

function inputs(over = {}) {
  return {
    timezone: "UTC",
    horizonWeeks: 4,
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

const task = (id, over = {}) => ({
  id,
  title: id,
  priority: "medium",
  duration: 120,
  chunk: 120,
  deadline: 99999,
  floor: 0,
  ord: 50,
  ...over,
});

const run = (over) => computeSchedule(inputs(over), NOW);
/** Absolute start minute of a task's first block. */
const startOf = (s, id) => {
  const b = s.blocks
    .filter((x) => x.taskId === id)
    .sort((x, y) => x.gday * 1440 + x.start - (y.gday * 1440 + y.start))[0];
  return b ? b.gday * 1440 + b.start : Infinity;
};
const dayOf = (s, id) => Math.floor(startOf(s, id) / 1440);

// ------------------------------------------------- the reported case itself

// A 2h session due Thursday next week (gday 10), against a research minimum
// that wants this week's hours. Before this change the session took Monday
// morning and the minimum went short.
const REPORTED = {
  tasks: [task("dated-session", { duration: 120, deadline: day(10) + 1020 })],
  projects: [
    { id: "weekly", title: "weekly", weeklyMinMin: 300, chunk: 120, minChunk: 60, categoryId: RESEARCH, researchOrd: 5 },
  ],
};
const reported = run(REPORTED);
check("the dated session lands in the week it is due, not this one", dayOf(reported, "dated-session") >= 7, true);
check("...and still comfortably before its deadline", startOf(reported, "dated-session") < day(10) + 1020, true);

const weeklyThisWeek = reported.blocks
  .filter((b) => b.projectId === "weekly" && b.gday < 7)
  .reduce((n, b) => n + (b.end - b.start), 0);
check("the weekly minimum gets its full 5h this week", weeklyThisWeek, 300);

// ------------------------------------------------------- a deadline is never traded

// The same session due THIS Wednesday has nowhere later to go — it must still
// be placed before its deadline, buffer or no buffer.
const TIGHT = { tasks: [task("due-wed", { duration: 120, deadline: day(2) + 1020 })] };
const tight = run(TIGHT);
check("work due this week is still placed before its deadline", startOf(tight, "due-wed") < day(2) + 1020, true);
check("...and is not reported at risk", tight.risk.includes("due-wed"), false);

// A deadline so tight the buffer cannot be honoured at all: it is dropped
// rather than pushing the work past its date.
const TODAY = { tasks: [task("due-today", { duration: 60, deadline: day(0) + 1020 })] };
const today = run(TODAY);
check("a same-day deadline still places, buffer abandoned", startOf(today, "due-today") < day(0) + 1020, true);

// ------------------------------------------- priority buys slack, not the reverse

// Two dated tasks, same deadline, same length. The higher-priority one must
// end up EARLIER — more recovery room, not less. This is the invariant the
// backwards search broke and the scaled buffer restores.
const BOTH_DATED = {
  tasks: [
    task("dated-low", { priority: "low", deadline: day(8) + 1020, duration: 60 }),
    task("dated-high", { priority: "high", deadline: day(8) + 1020, duration: 60 }),
  ],
};
const bothDated = run(BOTH_DATED);
check("among equally-dated work, higher priority sits earlier", startOf(bothDated, "dated-high") < startOf(bothDated, "dated-low"), true);
check("both still land before the shared deadline", Math.max(startOf(bothDated, "dated-high"), startOf(bothDated, "dated-low")) < day(8) + 1020, true);

// ------------------------------------------------------------ undated is untouched

// Nothing to sit near, so it still takes the earliest slot it can get.
const UNDATED = { tasks: [task("floating", { duration: 60 })] };
check("undated work still takes the earliest slot", dayOf(run(UNDATED), "floating"), 0);

// ------------------------------------------------------------- one_day mode

// splitMode one_day picks a DAY rather than a slot; it has to move late for
// the same reason, or a one-day task due next week takes this week's only
// open morning whole.
const ONE_DAY = {
  tasks: [task("one-day", { duration: 180, chunk: 60, splitMode: "one_day", deadline: day(10) + 1020 })],
};
check("a one-day task due next week takes a day next week", dayOf(run(ONE_DAY), "one-day") >= 7, true);

// ---------------------------------------------------------------- stability

check(
  "computing twice on identical inputs gives an identical schedule",
  JSON.stringify(run(REPORTED).blocks),
  JSON.stringify(reported.blocks),
);

console.log(`\n${checks - failures}/${checks} just-in-time checks passed`);
process.exit(failures ? 1 : 0);
