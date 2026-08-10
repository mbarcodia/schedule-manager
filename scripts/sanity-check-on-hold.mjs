// A commitment on hold (run: npx tsx scripts/sanity-check-on-hold.mjs).
//
// Three things have to be true at once, and the first two pull against each
// other, which is why this exists:
//
//   NOTHING IS SCHEDULED for it — not its weekly hours, not its tasks, and it
//   takes no part of its label's weekly share.
//
//   ITS RATE IS REMEMBERED. Pausing by clearing weekly_min_min would schedule
//   nothing too, and would throw away the decision "this deserves 4h of a normal
//   week" — so resuming would mean making that decision again.
//
//   ITS DATES STILL APPROACH. The risk of putting something down is forgetting
//   to pick it up, so pace stays quiet only while resuming at the old rate would
//   still make the date, and speaks the moment it wouldn't.

import { computePace, paceSentence } from "../src/lib/scheduling/pace.ts";
import { computeSchedule } from "../src/lib/scheduling/engine.ts";
import { computeStreaks } from "../src/lib/scheduling/streaks.ts";
import { computeTrackableChips } from "../src/lib/scheduling/trackables.ts";
import { weeklyHoursValue } from "../src/lib/planner/commitment-form.ts";

const H = 60;
const NOW = new Date(2026, 7, 7, 10, 0);
let failures = 0;
let checks = 0;
function check(label, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

// ---------------------------------------------------------------- the engine
//
// from-db is what strips the hours, so what the engine receives for a held
// commitment is one carrying none. These two cases pin down that the stripping
// is the whole mechanism: same project, hours vs no hours.
const MONDAY = new Date(2026, 6, 27, 8, 0);
const engineInputs = (weeklyMinMin) => ({
  timezone: "America/New_York",
  horizonWeeks: 2,
  weeklyHours: Object.fromEntries(
    Array.from({ length: 7 }, (_, d) => [d, d > 4 ? null : { start: 9 * H, end: 17 * H }]),
  ),
  tasks: [],
  projects: [{ id: "p1", title: "Paused work", weeklyMinMin, chunk: 120, categoryId: null }],
  events: [],
  recurringRules: [],
  dayOverrides: {},
  graceHours: 4,
  allDayBlocks: {},
  researchPins: [],
  completed: {},
  partial: {},
  pinned: {},
  labelNames: {},
  historyBlocks: [],
  labelTargetPct: {},
  labelTargetBasis: {},
});

const running = computeSchedule(engineInputs(4 * H), MONDAY).blocks.filter((b) => b.projectId === "p1");
const held = computeSchedule(engineInputs(null), MONDAY).blocks.filter((b) => b.projectId === "p1");
check("with hours, the engine books it", running.length > 0, true);
check("with the hours stripped, it books nothing", held.length, 0);
check("and reports no shortfall — it wasn't asked for anything", computeSchedule(engineInputs(null), MONDAY).overflow, []);

// ------------------------------------------------------------------- pace
const base = {
  id: "p1",
  title: "AgenticAI BAMS",
  effortEstimateMin: 26 * H,
  deadlineKind: "hard",
  important: false,
  onHold: true,
  weeklyMinMin: null, // as from-db hands it over
  weeklyMinMinOnHold: 2 * H,
};
const paceOf = (over = {}, logged = 0, bookableWeekMin = null) =>
  computePace({
    projects: [{ ...base, ...over }],
    targets: [],
    loggedByProject: { p1: logged },
    weeklyHours: {},
    now: NOW,
    bookableWeekMin,
  })[0];

console.log("\n== a hold is a state, not a missing field ==");
const far = paceOf({ deadlineDate: new Date(2026, 10, 30) }); // 16 weeks out
check("its status says so", far.status, "on_hold");
check("nothing is reported as missing", far.missing, []);
check("the remembered rate is what it reports", far.weeklyRateMin, 2 * H);
check("quiet while there is time", far.holdRateNeededMin, null);
check(
  "and the sentence still says what picking it up costs",
  paceSentence(far),
  "On hold — 26h left, due Nov 30. It resumes at 2h/wk.",
);

console.log("\n== it speaks once the date gets tight ==");
// 26h left with 3.94 weeks to go (Aug 7 10:00 -> Sep 4 midnight, NOT a round
// four weeks) needs 6.6h/wk; it was paused at 2h/wk.
const tight = paceOf({ deadlineDate: new Date(2026, 8, 4) });
check("the needed rate is set once it exceeds the paused rate", tight.holdRateNeededMin, 396);
check(
  "the sentence names the rate and the weeks",
  paceSentence(tight),
  "On hold, and the date is getting tight — 26h left before Sep 4, 4 weeks away. Starting now would take 6.6h/wk.",
);
check(
  "and says when even that won't fit a week",
  paceSentence(paceOf({ deadlineDate: new Date(2026, 8, 4) }, 0, 4 * H)).includes(
    "more than a normal week's 4h of free time",
  ),
  true,
);

// The threshold is the rate it was paused at, so work already done buys silence.
check(
  "logged hours can put it back under the line",
  paceOf({ deadlineDate: new Date(2026, 8, 4) }, 20 * H).holdRateNeededMin,
  null,
);

console.log("\n== the edges ==");
check(
  "no date: nothing to be late for, so nothing is said",
  paceSentence(paceOf({ deadlineDate: null })),
  "On hold — 26h left, no date. It resumes at 2h/wk.",
);
check("no date means no warning either", paceOf({ deadlineDate: null }).holdRateNeededMin, null);
check(
  "never given a rate: a normal week stands in as the bar",
  paceOf({ deadlineDate: new Date(2026, 8, 4), weeklyMinMinOnHold: null }, 0, 4 * H).holdRateNeededMin,
  396,
);
check(
  "and with neither a rate nor a bookable week, it stays quiet rather than inventing a threshold",
  paceOf({ deadlineDate: new Date(2026, 8, 4), weeklyMinMinOnHold: null }).holdRateNeededMin,
  null,
);
check(
  "no estimate: still a hold, still not 'unmeasurable'",
  paceOf({ effortEstimateMin: null, deadlineDate: new Date(2026, 10, 30) }).status,
  "on_hold",
);

// ------------------------------------------------- what the panel shows (BUG)
//
// The hold NULLS weeklyMinMin — that is the pause mechanism — so a panel reading
// only that field showed an EMPTY hours box, and saving it wrote the empty box
// back over the remembered rate. Editing the title of a paused commitment
// silently un-set its hours, destroying the one thing a hold promises to keep.
console.log("\n== the panel shows the rate it will resume at ==");
check("a paused commitment shows its remembered rate", weeklyHoursValue({ weeklyMinMin: null, weeklyMinMinOnHold: 2 * H }), "2");
check("a running one shows its live rate", weeklyHoursValue({ weeklyMinMin: 4 * H, weeklyMinMinOnHold: null }), "4");
check("one with neither shows empty", weeklyHoursValue({ weeklyMinMin: null, weeklyMinMinOnHold: null }), "");
check("and a missing project is empty, not a crash", weeklyHoursValue(null), "");

// -------------------------------------------------------- the chips (BUG)
console.log("\n== the chips say 'on hold', not 'on pace' ==");
const HOURS = Object.fromEntries(
  Array.from({ length: 7 }, (_, d) => [d, d > 4 ? null : { start: 9 * H, end: 17 * H }]),
);
const chipsFor = (over = {}) => {
  const project = { ...base, deadlineDate: new Date(2026, 10, 30), ...over };
  const pace = computePace({ projects: [project], targets: [], loggedByProject: {}, weeklyHours: HOURS, now: NOW });
  return computeTrackableChips([project], [], { blocks: [], weeklyTargetMinByProject: {} }, NOW, HOURS, pace);
};

const deadlineChipOf = (over) => chipsFor(over).find((c) => c.facet === "deadline");
// Far from its date: a hold is not an alarm, and it must not read "On pace".
const calm = deadlineChipOf({});
check("a far-off hold says so", calm?.statusText?.startsWith("On hold ·"), true);
check("and does not claim to be on pace", calm?.statusText?.includes("On pace"), false);
check("and is not counted as needing attention", calm?.needsAttention ?? false, false);

// Tight: 26h left, weeks away, paused at 2h/wk.
const urgent = deadlineChipOf({ deadlineDate: new Date(2026, 8, 4) });
check("a hold whose date got tight says that too", urgent?.statusText?.includes("getting tight"), true);
check("and does count as needing attention", urgent?.needsAttention, true);

// No deadline and no live hours: the cadence chip used to read "no dates set".
const cadence = chipsFor({ deadlineDate: null }).find((c) => c.facet === "cadence");
check("an undated hold says 'On hold', not 'no dates set'", cadence?.statusText, "On hold");
check("and its tooltip names the resume rate", cadence?.tooltip?.includes("resumes at 2h/wk"), true);
check("a paused commitment gets no weekly-hours chip", chipsFor({}).some((c) => c.facet === "weekly"), false);

// ------------------------------------------------------ the streak row (BUG)
//
// Putting something on hold used to blank its whole eight-week history, because
// the nulled rate made every week "nothing to measure against". The hold's DATE
// is what separates the two halves: real marks before it, time off after.
console.log("\n== a hold pauses the record, it doesn't rewrite it ==");
const weekAgo = (n) => new Date(NOW.getTime() - n * 7 * 86400000);
const streakOf = (heldSince) =>
  computeStreaks({
    logged: [0, 1, 2, 3].map((n) => ({ occurredDate: weekAgo(n), projectId: "p1", minutes: 3 * H })),
    commitments: [{ id: "p1", weeklyMinMin: 2 * H, heldSince }],
    now: NOW,
    weeks: 5,
  })[0];

check("with no hold, the met weeks are marks", streakOf(null).marks.slice(-4), ["hit", "hit", "hit", "hit"]);
const paused = streakOf(weekAgo(1));
check("weeks before the hold keep their real marks", paused.marks.slice(-5, -2), ["skipped", "hit", "hit"]);
check("weeks from the hold onward are time off, not misses", paused.marks.slice(-2), ["skipped", "skipped"]);
check("so the run that was built is still visible", paused.best >= 2, true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
