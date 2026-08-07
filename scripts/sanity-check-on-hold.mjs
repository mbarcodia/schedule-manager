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

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
