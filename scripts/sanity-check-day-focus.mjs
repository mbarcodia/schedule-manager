// Sanity check: one day's label time given to one project
// (run: npx tsx scripts/sanity-check-day-focus.mjs).
//
// "I want my research blocks tomorrow to all be ACE2-S2S." Migration 0046 and
// lib/scheduling/day-focus.ts have the reasoning. What this file exists to hold is
// the ONE invariant everything rests on:
//
//   A displaced project's duration is never reduced. It only loses rank on that
//   day. So it either re-places elsewhere in its week, or its minutes survive as
//   remaining > 0 and surface through unplaced/overflow. There is no third
//   outcome, and nothing has to remember to report it.
//
// research_pins get this wrong (pinReduction shrinks the def's duration, so the
// missing minutes stop being asked for and are silently un-owed). Assertion
// "placed + shortfall === declared" below is what fails the moment anyone
// "optimises" this feature into doing the same thing.
//
// NOW is fixed. A real `new Date()` makes these fail on a Friday afternoon for
// reasons that say nothing about focus.

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

/** Monday 10 Aug 2026, 08:00 UTC — before the working day, so nothing is history
 * and gday 0 is that Monday. */
const NOW = new Date(Date.UTC(2026, 7, 10, 8, 0));
const RESEARCH = "cat-research";
const TEACHING = "cat-teaching";

const HOURS = {};
for (let d = 0; d < 5; d++) HOURS[d] = { start: 540, end: 1020 }; // 9-5
HOURS[5] = null;
HOURS[6] = null;

/** Each project's declared weekly minutes. Named because the accounting
 * assertions below compare against it, and a fixture change that left a
 * hardcoded copy behind is how they silently stop testing anything. */
const WEEKLY = 300;

const project = (id, over = {}) => ({
  id,
  title: id,
  weeklyMinMin: WEEKLY,
  chunk: 120,
  minChunk: 60,
  researchOrd: 5,
  categoryId: RESEARCH,
  preferMorning: false,
  preferAfternoon: false,
  timeOfDay: null,
  ...over,
});

function inputs(over = {}) {
  return {
    timezone: "UTC",
    weeklyHours: HOURS,
    horizonWeeks: 2,
    dayOverrides: {},
    allDayBlocks: {},
    events: [],
    recurringRules: [],
    tasks: [],
    projects: [project("A"), project("B"), project("C")],
    completed: {},
    partial: {},
    pinned: {},
    researchPins: [],
    labelNames: { [RESEARCH]: "Research", [TEACHING]: "Teaching" },
    graceHours: 4,
    ...over,
  };
}

const run = (over) => computeSchedule(inputs(over), NOW);

/** Weekly-hours blocks for a label on one day, excluding history. */
const labelOn = (s, gday, labelId = RESEARCH) =>
  s.blocks.filter(
    (b) => b.gday === gday && b.categoryId === labelId && b.projectId && b.status !== "missed" && b.status !== "grace",
  );
const minutes = (blocks) => blocks.reduce((n, b) => n + (b.end - b.start), 0);
/** Minutes placed for a project across week 0. */
const weekMinutes = (s, id) =>
  minutes(s.blocks.filter((b) => b.projectId === id && b.gday < 7 && b.status !== "missed" && b.status !== "grace"));
/** What the engine still says it owes for a project's week-0 hours. */
const owed = (s, id) => {
  const u = s.unplaced.find((x) => x.id === `research-${id}-w0`);
  return u ? u.remainingMin : 0;
};

// ---------------------------------------------------------------- the baseline

const base = run({});
const heldWed = minutes(labelOn(base, 1));
const aOnWedBefore = minutes(labelOn(base, 1).filter((b) => b.projectId === "A"));
check("baseline puts some research on the target day to reassign", heldWed > 0, true);
check("and that day holds MORE THAN ONE project, so there is really something to merge", new Set(labelOn(base, 1).map((b) => b.projectId)).size > 1, true);

// ------------------------------------------------------------------- the focus

/** gday 1 (Tuesday) holds a genuine MIX in the baseline — B and C — which is
 * the real case: her Thursday had one project in the morning and another after. */
const FOCUS_WED_A = [{ gday: 1, categoryId: RESEARCH, projectId: "A" }];
const focused = run({ dayFocus: FOCUS_WED_A });

check(
  "every research block on the focused day belongs to the focused project",
  [...new Set(labelOn(focused, 1).map((b) => b.projectId))],
  ["A"],
);
check("the day holds the same total research minutes as before", minutes(labelOn(focused, 1)), heldWed);
check("no other project keeps research time that day", labelOn(focused, 1).filter((b) => b.projectId !== "A").length, 0);
// The shared-id decision. If this breaks, the done-checkbox on a focused block
// writes a progress_log key nothing reads and the tick silently does nothing.
check(
  "focus blocks carry the project's normal weekly-hours id",
  [...new Set(labelOn(focused, 1).map((b) => b.taskId))],
  ["research-A-w0"],
);
check(
  "the focused project's week grows by exactly what was transferred",
  weekMinutes(focused, "A"),
  weekMinutes(base, "A") + (heldWed - aOnWedBefore),
);
check("an outcome is reported for it", focused.dayFocus.length, 1);
check("with no skip reason", focused.dayFocus[0].skipped, null);
check("naming the day, project and label", [focused.dayFocus[0].gday, focused.dayFocus[0].projectId, focused.dayFocus[0].labelName], [1, "A", "Research"]);
check("and the minutes it moved off other projects", focused.dayFocus[0].transferredMin, heldWed - aOnWedBefore);
check("placedMin reports what actually landed", focused.dayFocus[0].placedMin, minutes(labelOn(focused, 1)));

// ------------------------------------ THE INVARIANT: displaced hours stay owed

for (const id of ["B", "C"]) {
  check(
    `${id}'s hours are all still accounted for (placed + owed === asked)`,
    weekMinutes(focused, id) + owed(focused, id),
    WEEKLY,
  );
}
// The label's total ask GROWS by exactly the transfer, and that is correct rather
// than a leak: B and C still owe every minute they were asked for, and A has been
// asked for its quota PLUS what they gave up. This is the documented consequence
// that a label's planned minutes can now exceed its asked minutes for the first
// time — pinned here so nobody "fixes" it back into silently un-owing the hours.
check(
  "the label is asked for its old total plus exactly what was transferred",
  ["A", "B", "C"].reduce((n, id) => n + weekMinutes(focused, id) + owed(focused, id), 0),
  ["A", "B", "C"].reduce((n, id) => n + weekMinutes(base, id) + owed(base, id), 0) +
    focused.dayFocus[0].transferredMin,
);

// ---------------------------------------------- a week with genuinely no room

// Every other weekday closed, so the displaced hours have nowhere to go and MUST
// be reported rather than absorbed. This is where "never written off" can break.
const TIGHT = {
  dayFocus: FOCUS_WED_A,
  dayOverrides: { 0: { closed: true }, 2: { closed: true }, 3: { closed: true }, 4: { closed: true } },
};
const tight = run(TIGHT);
const tightBase = run({ dayOverrides: TIGHT.dayOverrides });
check("in a week with no room, the focused day is still all the focused project", [...new Set(labelOn(tight, 1).map((b) => b.projectId))], ["A"]);
for (const id of ["B", "C"]) {
  check(`${id} is reported as owing its hours rather than losing them`, owed(tight, id) > 0, true);
  check(`${id} appears in didNotFit`, tight.overflow.includes(id), true);
  check(`${id}'s accounting still closes exactly`, weekMinutes(tight, id) + owed(tight, id), WEEKLY);
}
check("the tight week without a focus already owed something too (so this is a fair test)", tightBase.overflow.length > 0, true);

// ------------------------------- the focused project's minimum already met

// The case the design turns on: A has done all 480 of its weekly minutes, so its
// weekly def has nothing left — and the day must STILL fill with A.
const aKeys = base.blocks
  .filter((b) => b.projectId === "A" && b.gday < 7 && b.key)
  .reduce((acc, b) => ({ ...acc, [b.key]: true }), {});
const metQuota = run({ dayFocus: FOCUS_WED_A, completed: aKeys });
check(
  "a focus still fills the day when the project's weekly minimum is already met",
  minutes(labelOn(metQuota, 1).filter((b) => b.projectId === "A")) > 0,
  true,
);
check("and no other project takes that day", labelOn(metQuota, 1).filter((b) => b.projectId !== "A").length, 0);

// --------------------------------- leftover goes to the next project (soft)

// A has only 60 minutes of work left against its estimate, so it cannot absorb the
// whole day and the rest must go to another project rather than sitting empty.
const capped = run({
  dayFocus: FOCUS_WED_A,
  projects: [project("A", { effortEstimateMin: 60 }), project("B"), project("C")],
  loggedMinByProject: { A: 0 },
});
check("a focus is capped by the work the project actually has left", capped.dayFocus[0].focusMin, 60);
check(
  "and the day is not left empty — the rest goes to another project",
  minutes(labelOn(capped, 1).filter((b) => b.projectId !== "A")) > 0,
  true,
);
check("which is reported as leftover rather than silently happening", capped.dayFocus[0].leftoverTo.length > 0, true);

// ------------------------------------------------- who loses, decided by pace

// B is four weeks ahead of its goal, C is two weeks behind. With no room to
// re-place, B should give up more than C.
const paced = run({
  ...TIGHT,
  paceSlackWeeksByProject: { B: 4, C: -2 },
});
check("the project furthest ahead of its goal gives up more", owed(paced, "B") >= owed(paced, "C"), true);
check("and the one behind pace keeps more of its time", weekMinutes(paced, "C") >= weekMinutes(paced, "B"), true);

// ------------------------------------------------------- pins outrank a focus

const pinned = run({
  dayFocus: FOCUS_WED_A,
  researchPins: [{ projectId: "B", gday: 1, start: 600, length: 60 }],
});
check(
  "an explicitly pinned slot survives a focus",
  pinned.blocks.some((b) => b.gday === 1 && b.projectId === "B"),
  true,
);
check("and the exception is named rather than hidden", pinned.dayFocus[0].pinnedOthers, ["B"]);

// ------------------------------------------------------------ the no-ops

const weekend = run({ dayFocus: [{ gday: 5, categoryId: RESEARCH, projectId: "A" }] });
check("a weekend focus does nothing and says why", weekend.dayFocus[0].skipped, "weekend");
check("and changes no blocks at all", JSON.stringify(weekend.blocks), JSON.stringify(base.blocks));

const unknown = run({ dayFocus: [{ gday: 1, categoryId: RESEARCH, projectId: "nope" }] });
check("an unknown project is skipped, not crashed", unknown.dayFocus[0].skipped, "unknown_project");

const mismatch = run({ dayFocus: [{ gday: 1, categoryId: TEACHING, projectId: "A" }] });
check("a project whose label isn't the focused one is refused", mismatch.dayFocus[0].skipped, "label_mismatch");

const held = run({
  dayFocus: FOCUS_WED_A,
  projects: [project("A", { onHold: true, weeklyMinMin: null }), project("B"), project("C")],
});
check("an on-hold project cannot be handed a day", held.dayFocus[0].skipped, "project_on_hold");

const dayOff = run({ dayFocus: FOCUS_WED_A, dayOverrides: { 1: { closed: true } } });
check("a closed day is skipped", dayOff.dayFocus[0].skipped, "day_off");

const noResearch = run({
  dayFocus: [{ gday: 1, categoryId: TEACHING, projectId: "T" }],
  projects: [project("T", { categoryId: TEACHING, weeklyMinMin: null })],
});
check("a label with no weekly hours that day has nothing to reassign", noResearch.dayFocus[0].skipped, "nothing_to_reassign");

// --------------------------------------------------------------- other checks

// Both days must hold research in the UNFOCUSED plan — see the note in
// day-focus.ts: a focus is measured against pass 1, so it cannot claim time that
// exists only because another focus displaced something onto that day.
const twoDays = run({
  dayFocus: [
    { gday: 0, categoryId: RESEARCH, projectId: "C" },
    { gday: 1, categoryId: RESEARCH, projectId: "A" },
  ],
});
check("two focuses on different days are both honoured", [
  [...new Set(labelOn(twoDays, 0).map((b) => b.projectId))],
  [...new Set(labelOn(twoDays, 1).map((b) => b.projectId))],
], [["C"], ["A"]]);
check("neither reports a skip", twoDays.dayFocus.map((o) => o.skipped), [null, null]);

// ------------------------ THE REGRESSION: same project, multiple days, one week
//
// A live bug: focusId is deliberately the SAME string on every day that focuses
// the same project (researchDefId is keyed by project+week, not by day — see its
// own comment on why). The "reduce the project's own weekly def by what it
// already held" step used to match on that shared id alone, so it also matched
// EARLIER days' own already-created (and already correctly-sized) focus chunks —
// each later day's focus silently drained the earlier days' placedMin toward
// zero. Three straight days focused on the same project reproduces it; two
// distinct days above did not, because distinct projects never shared an id.
const threeDaysSameProject = run({
  dayFocus: [
    { gday: 0, categoryId: RESEARCH, projectId: "A" },
    { gday: 1, categoryId: RESEARCH, projectId: "A" },
    { gday: 2, categoryId: RESEARCH, projectId: "A" },
  ],
  // A needs enough weekly minutes to spread across all three focused
  // days in the UNFOCUSED baseline (480/480/340) — the erosion only shows up
  // when a later day's pOwnMin is nonzero, which requires the project to
  // already own real time on that later day before any focus is applied.
  projects: [project("A", { weeklyMinMin: 1300 }), project("B"), project("C")],
});
for (const o of threeDaysSameProject.dayFocus) {
  check(`gday ${o.gday}: placedMin matches focusMin (nothing silently drained later)`, o.placedMin, o.focusMin);
}
check(
  "an earlier day keeps its own research minutes after a later day focuses the same project",
  minutes(labelOn(threeDaysSameProject, 0).filter((b) => b.projectId === "A")) > 0,
  true,
);

check(
  "computing twice on identical inputs gives an identical schedule",
  JSON.stringify(run({ dayFocus: FOCUS_WED_A }).blocks),
  JSON.stringify(focused.blocks),
);

// Work under a different label must be untouched by a Research focus.
const withTeaching = run({
  dayFocus: FOCUS_WED_A,
  projects: [project("A"), project("B"), project("C"), project("T", { categoryId: TEACHING, weeklyMinMin: 240 })],
});
check(
  "a focus on one label leaves another label's work alone",
  minutes(withTeaching.blocks.filter((b) => b.projectId === "T" && b.gday < 7)) > 0,
  true,
);

check("no focus set means no outcomes and no cost", run({}).dayFocus, []);

console.log(`\n${checks - failures}/${checks} day-focus checks passed`);
process.exit(failures ? 1 : 0);
