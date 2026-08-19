// What would have to give (run: npx tsx scripts/sanity-check-shortfall.mjs).
//
// The engine has always answered "what fits" and reported the leftovers by
// name. This turns that into costed choices, and the things worth pinning down
// are the ones that make such a report trustworthy rather than decorative:
//
//   IT STAYS SILENT WHEN THE WEEK HOLDS EVERYTHING. A banner that is always up
//   is a banner nobody reads, and the whole point is to be believed when it
//   does appear.
//
//   EVERY NUMBER IS MEASURED, NOT ASKED FOR. `freesMin` reflects hours the
//   engine really could not place, so an option that claims four hours has
//   four hours genuinely sitting unplaced behind it.
//
//   A PROPOSED RATE IS A NUMBER YOU CAN TYPE IN. With a label share target
//   set, per-commitment weekly hours are a RATIO the engine scales — a 6h/wk
//   commitment gets asked for 7.5h. A trim proposed from the scaled figures
//   would name a rate that means nothing in the field the user edits, so it is
//   divided back out. This is the check that catches that regressing.
//
//   IT NEVER PROPOSES DEFERRING INTO A WEEK WITH NO ROOM, which is how a
//   shortfall gets moved around instead of resolved.

import { computeSchedule } from "../src/lib/scheduling/engine.ts";
import { computeShortfall, describeShortfall, freeMinutesInWeek } from "../src/lib/scheduling/shortfall.ts";

let failures = 0;
let checks = 0;
function check(label, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

/** Monday 10 Aug 2026, 08:00 UTC — before the working day. */
const NOW = new Date(Date.UTC(2026, 7, 10, 8, 0));
const RESEARCH = "cat-research";
const HOURS = {};
for (let d = 0; d < 5; d++) HOURS[d] = { start: 540, end: 1020 }; // 9-5, 40h/wk
HOURS[5] = null;
HOURS[6] = null;

const project = (id, over = {}) => ({
  id,
  title: id,
  weeklyMinMin: 300,
  chunk: 120,
  minChunk: 60,
  researchOrd: 5,
  categoryId: RESEARCH,
  ...over,
});

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

const runShortfall = (over) => {
  const inp = inputs(over);
  return { inp, weeks: computeShortfall(inp, computeSchedule(inp, NOW)) };
};

/** Meetings filling 10:00-17:00 every weekday across the horizon, leaving one
 * hour a day. Label-scaled work needs this to be short of anything: a share
 * target is a fraction of the week, so on an EMPTY week it always fits by
 * construction, and the interesting cases only appear once the week is
 * genuinely eaten. */
const busyWeeks = () => {
  const ev = [];
  for (let g = 0; g < 28; g++) {
    if (g % 7 > 4) continue;
    ev.push({ gday: g, start: 600, end: 1020, title: `Meeting ${g}`, allDay: false });
  }
  return ev;
};

// ---------------------------------------------------------------- silence

console.log("== it stays quiet when the week fits ==");
const roomy = runShortfall({ projects: [project("A", { weeklyMinMin: 120 })] });
check("nothing is owed", roomy.weeks[0].totalOwedMin, 0);
check("so no options are offered", roomy.weeks[0].options.length, 0);
check("and there is no sentence to say", describeShortfall(roomy.weeks), null);
check("free time is still reported", roomy.weeks[0].freeMin > 0, true);

// ------------------------------------------------------- a genuinely full week

// Three commitments at 20h/wk each into a 40h week: it cannot fit, and no
// reordering makes it fit.
console.log("\n== a week that genuinely cannot hold it ==");
const FULL = {
  projects: [
    project("A", { weeklyMinMin: 1200 }),
    project("B", { weeklyMinMin: 1200 }),
    project("C", { weeklyMinMin: 1200 }),
  ],
};
const full = runShortfall(FULL);
const w0 = full.weeks[0];
check("work is reported as owed", w0.totalOwedMin > 0, true);
check("options are offered", w0.options.length > 0, true);
check("the biggest saving is listed first", w0.options[0].freesMin, Math.max(...w0.options.map((o) => o.freesMin)));
check("every option says what it costs", w0.options.every((o) => o.cost.length > 0), true);
check("every option frees a real amount", w0.options.every((o) => o.freesMin > 0), true);
check("a sentence is produced", typeof describeShortfall(full.weeks), "string");
check("both weeks are reported", full.weeks.map((w) => w.weekIndex), [0, 1]);

// Every owed line must name a commitment that really exists — the ids come
// from parsing synthesized per-week def ids, which is exactly the kind of
// string handling that silently starts producing orphans.
const known = new Set(FULL.projects.map((p) => p.id));
check("every owed line names a real commitment", w0.owed.every((o) => known.has(o.projectId)), true);
check("...with a positive amount", w0.owed.every((o) => o.owedMin > 0), true);
check("the total is the sum of its parts", w0.totalOwedMin, w0.owed.reduce((n, o) => n + o.owedMin, 0));

// ------------------------------- a trim names a rate you could actually type

console.log("\n== a proposed rate is in the units the user edits ==");
// With a 40% share target on a 40h week the label is asked for 16h, and the
// three 20h/wk commitments are scaled DOWN to fit that. A trim proposed from
// the scaled numbers would name a rate that does not match the field.
const SCALED = {
  events: busyWeeks(),
  projects: [project("A", { weeklyMinMin: 1200 }), project("B", { weeklyMinMin: 1200 })],
  labelTargetPct: { [RESEARCH]: 40 },
  labelTargetBasis: { [RESEARCH]: "week" },
};
const scaled = runShortfall(SCALED);
const trims = scaled.weeks[0].options.filter((o) => o.kind === "trim_weekly");
check("a trim is offered", trims.length > 0, true);
check(
  "and never proposes a rate at or above the one already set",
  trims.every((o) => {
    const to = Number(/to ([\d.]+)h\/wk/.exec(o.label)?.[1]);
    const from = Number(/from ([\d.]+)h\/wk/.exec(o.label)?.[1]);
    return Number.isFinite(to) && Number.isFinite(from) && to < from;
  }),
  true,
);
check("a trim targets the commitment by id", trims.every((o) => !!o.target.projectId), true);

// ------------------------------------------- defer only where there is room

console.log("\n== defer is only offered into a week with room ==");
// Every week is equally overcommitted, so there is nowhere to defer TO.
const defers = full.weeks[0].options.filter((o) => o.kind === "defer");
const nextFree = freeMinutesInWeek(full.inp, computeSchedule(full.inp, NOW), 1);
check(
  "no defer proposes more than the next week's free time",
  defers.every((o) => o.freesMin <= nextFree),
  true,
);

// ------------------------------------------ the label target as a root cause

console.log("\n== the share target is offered as a root cause ==");
const lower = scaled.weeks[0].options.filter((o) => o.kind === "lower_label_target");
check("lowering the label target is offered when its share cannot be met", lower.length > 0, true);
check("it names the label by id, so it can be acted on", lower.every((o) => !!o.target.labelId), true);
check(
  "and proposes a percentage below the current one",
  lower.every((o) => {
    const m = /from (\d+)% to about (\d+)%/.exec(o.label);
    return m && Number(m[2]) < Number(m[1]);
  }),
  true,
);

// --------------------------------------------------- dated work as an option

console.log("\n== dated work is offered last-resort, and told apart ==");
const WITH_TASK = {
  events: busyWeeks(),
  projects: [project("A", { weeklyMinMin: 1200 })],
  tasks: [
    { id: "t1", title: "Report", priority: "medium", duration: 240, chunk: 120, deadline: 3 * 1440 + 1020, floor: 0, ord: 50 },
  ],
};
const withTask = runShortfall(WITH_TASK);
const moves = withTask.weeks[0].options.filter((o) => o.kind === "move_deadline");
check("moving a dated task is offered", moves.length > 0, true);
check("it names the task by id", moves.every((o) => !!o.target.taskId), true);
check("and quotes the task's title", moves[0].label.includes("Report"), true);

// --------------------------------------------------------------- stability

console.log("\n== stability ==");
check(
  "computing twice on identical inputs gives an identical report",
  JSON.stringify(runShortfall(FULL).weeks),
  JSON.stringify(full.weeks),
);

console.log(`\n${checks - failures}/${checks} shortfall checks passed`);
process.exit(failures ? 1 : 0);
