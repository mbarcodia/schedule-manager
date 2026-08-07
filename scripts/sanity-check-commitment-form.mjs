// Sanity check for the commitment panel's validation
// (run: npx tsx scripts/sanity-check-commitment-form.mjs).
//
// The panel writes the same columns the chat tools write, so its edges are the
// ones where typing a figure and saying it in a sentence could diverge: an empty
// field must stay "not known" rather than becoming zero, and two dates must not
// end up sharing a name, because chat finds a target BY name.

import { parseHours, hoursValue, normTargetTitle, validateCommitmentForm } from "../src/lib/planner/commitment-form.ts";

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

// ------------------------------------------------------------------ parseHours

check("empty means not known, NOT zero", parseHours("").minutes, null);
check("whitespace is empty too", parseHours("   ").minutes, null);
check("whole hours", parseHours("4").minutes, 240);
check("half hours survive the round trip", parseHours("1.5").minutes, 90);
check("a rounded minute, not a fraction of one", parseHours("0.33").minutes, 20);
check("zero is refused rather than written", parseHours("0").minutes, null);
check("and says leaving it empty is the way to say 'unknown'", parseHours("0").error?.includes("empty"), true);
check("negatives are refused", parseHours("-3").error != null, true);
check("nonsense is refused, and quotes what was typed", parseHours("soon").error, '"soon" isn\'t a number of hours.');

check("minutes back to a field value, no trailing zeros", [hoursValue(90), hoursValue(240), hoursValue(null)], [
  "1.5",
  "4",
  "",
]);
check("a 20-minute figure round-trips to something typeable", parseHours(hoursValue(20)).minutes, 20);

// -------------------------------------------------------------- title matching

check(
  "titles match the way chat matches them: case and inner spacing ignored",
  normTargetTitle("  First   Draft ") === normTargetTitle("first draft"),
  true,
);

// ----------------------------------------------------------------- form errors

const draft = (over = {}) => ({ title: "outline", date: "2026-09-01", dateKind: "goal", hoursText: "", ...over });

check("a clean form has nothing to say", validateCommitmentForm({
  estimateText: "80",
  weeklyText: "3",
  deadlineDate: "2026-10-30",
  targets: [],
}), { errors: [], warnings: [] });

check(
  "a date with no name is blocked — the pace line reads the name out loud",
  validateCommitmentForm({
    estimateText: "",
    weeklyText: "",
    deadlineDate: "",
    targets: [draft({ title: "  " })],
  }).errors,
  ["date 1 needs a name — it's what the pace line says out loud."],
);

check(
  "a name with no date is blocked",
  validateCommitmentForm({
    estimateText: "",
    weeklyText: "",
    deadlineDate: "",
    targets: [draft({ date: "" })],
  }).errors,
  ["“outline” needs a date."],
);

check(
  "two dates sharing a name is blocked, because chat picks one by name",
  validateCommitmentForm({
    estimateText: "",
    weeklyText: "",
    deadlineDate: "",
    targets: [draft(), draft({ title: "Outline" })],
  }).errors.length,
  1,
);

check(
  "a bad figure names the field it's in",
  validateCommitmentForm({
    estimateText: "lots",
    weeklyText: "0",
    deadlineDate: "",
    targets: [draft({ hoursText: "-2" })],
  }).errors.length,
  3,
);

// --------------------------------------------------------------- form warnings

check(
  "a checkpoint after the finish-by date is a warning, not a block",
  validateCommitmentForm({
    estimateText: "",
    weeklyText: "",
    deadlineDate: "2026-10-30",
    targets: [draft({ date: "2026-11-15" })],
  }),
  {
    errors: [],
    warnings: ["“outline” is after the finish-by date — a checkpoint past the end won't be measured against."],
  },
);

check(
  "phases adding up to more than the total says which figure to revise",
  validateCommitmentForm({
    estimateText: "10",
    weeklyText: "",
    deadlineDate: "",
    targets: [draft({ hoursText: "8" }), draft({ title: "draft", date: "2026-09-20", hoursText: "6" })],
  }).warnings,
  [
    "The dates add up to 14h, more than the 10h total — pace will use the phase figures, so the total is the one to revise.",
  ],
);

check(
  "phases adding up to less says where the remainder is measured",
  validateCommitmentForm({
    estimateText: "10",
    weeklyText: "",
    deadlineDate: "",
    targets: [draft({ hoursText: "4" })],
  }).warnings,
  ["The dates account for 4h of 10h — the rest is measured against the finish-by date."],
);

check(
  "a half-costed sequence claims nothing, so it's told nothing",
  validateCommitmentForm({
    estimateText: "10",
    weeklyText: "",
    deadlineDate: "",
    targets: [draft({ hoursText: "4" }), draft({ title: "draft", date: "2026-09-20", hoursText: "" })],
  }).warnings,
  [],
);

check(
  "phases matching the total exactly is not news",
  validateCommitmentForm({
    estimateText: "10",
    weeklyText: "",
    deadlineDate: "",
    targets: [draft({ hoursText: "10" })],
  }).warnings,
  [],
);

// ------------------------------------------------- the active window
//
// The one thing a commitment could say only through the chat: when its weekly
// hours apply. An inverted window is refused rather than warned about, because
// its symptom is a commitment that quietly generates nothing at all.

const win = (over) =>
  validateCommitmentForm({ estimateText: "", weeklyText: "4", deadlineDate: "", targets: [], ...over });

check("a window in the right order is fine", win({ activeFrom: "2026-09-01", activeUntil: "2026-12-15" }).errors, []);
check("one open end is fine", win({ activeFrom: "2026-09-01" }).errors, []);
check("no window at all is fine", win({}).errors, []);
check(
  "an inverted window is refused",
  win({ activeFrom: "2026-12-15", activeUntil: "2026-09-01" }).errors.length,
  1,
);
check(
  "the same day at both ends is a legal one-day window",
  win({ activeFrom: "2026-09-01", activeUntil: "2026-09-01" }).errors,
  [],
);
check(
  "hours running out before the finish-by date is a warning, not a refusal",
  win({ activeUntil: "2026-10-01", deadlineDate: "2026-12-01" }).warnings.length,
  1,
);
check(
  "a window on a commitment with no weekly hours says it does nothing",
  win({ weeklyText: "", activeFrom: "2026-09-01" }).warnings.length,
  1,
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
