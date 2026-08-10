// The Priorities grid's urgency test (run: npx tsx scripts/sanity-check-quadrants.mjs).
//
// Urgency is the only derived half of that board — importance is a flag the user
// sets — and it is a question about DAYS, which is where this kind of code goes
// wrong. Two things have to be true at once and they pull in opposite directions:
//
//   "TODAY" IS A QUESTION ABOUT THE USER. It has to be read in the account's
//   timezone, or someone travelling gets yesterday's board.
//
//   A COMMITMENT'S DATE IS NOT AN INSTANT. from-db builds deadlines and targets
//   from local civil parts — the 30th means the 30th, not a moment. Converting
//   one to an ISO string and re-reading it in the account timezone (which is
//   what this did) asks what day that midnight falls on somewhere else, and
//   answers with the day before whenever the two zones disagree. They only ever
//   agreed because the app syncs the profile to the browser on load.

import { commitmentQuadrant, isUrgent } from "../src/lib/planner/eisenhower.ts";
import { URGENT_THRESHOLD_DAYS } from "../src/lib/planner/board-constants.ts";
import { zonedNow } from "../src/lib/scheduling/time.ts";

let failures = 0;
let checks = 0;
function check(label, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

/** A civil date, as from-db builds them: local midnight of that calendar day. */
const day = (y, m, d) => new Date(y, m - 1, d);
const NOW = new Date(2026, 7, 10, 9, 0); // Monday 10 August, 9am local

console.log("== the four quadrants ==");
const near = day(2026, 8, 12);
const far = day(2026, 12, 1);
check("important and soon is do", commitmentQuadrant({ important: true }, near, "America/New_York", NOW), "do");
check("important and distant is schedule", commitmentQuadrant({ important: true }, far, "America/New_York", NOW), "schedule");
check("unimportant and soon is delegate", commitmentQuadrant({ important: false }, near, "America/New_York", NOW), "delegate");
check("unimportant and distant is eliminate", commitmentQuadrant({ important: false }, far, "America/New_York", NOW), "eliminate");
check(
  "no date at all is never urgent",
  commitmentQuadrant({ important: true, deadlineDate: null }, null, "America/New_York", NOW),
  "schedule",
);
check(
  "the soonest of the two dates decides it",
  commitmentQuadrant({ important: true, deadlineDate: far }, near, "America/New_York", NOW),
  "do",
);

console.log("\n== the threshold is counted in whole days ==");
const inDays = (n) => day(2026, 8, 10 + n);
check(
  `${URGENT_THRESHOLD_DAYS} days out is still urgent`,
  commitmentQuadrant({ important: true }, inDays(URGENT_THRESHOLD_DAYS), "America/New_York", NOW),
  "do",
);
check(
  "one day past it is not",
  commitmentQuadrant({ important: true }, inDays(URGENT_THRESHOLD_DAYS + 1), "America/New_York", NOW),
  "schedule",
);
check("today counts as urgent", commitmentQuadrant({ important: true }, inDays(0), "America/New_York", NOW), "do");
check("and so does a date already past", commitmentQuadrant({ important: true }, inDays(-3), "America/New_York", NOW), "do");

console.log("\n== the threshold means the same thing in every zone ==");
// Measured from each zone's OWN today, which is the subtlety: at 9am in New
// York it is already tomorrow in Auckland, so "three days out" is a different
// calendar date there — and that part is correct. What must not vary is the
// COUNT. The bug made it vary, by turning the target's civil date into an
// instant and asking which day that midnight fell on elsewhere.
const zones = ["America/New_York", "Europe/Berlin", "Pacific/Auckland", "UTC"];
const todayIn = (tz) => {
  const z = zonedNow(tz, NOW);
  return day(z.year, z.month, z.day);
};
const plusDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
for (const tz of zones) {
  const today = todayIn(tz);
  check(
    `${tz}: ${URGENT_THRESHOLD_DAYS} days from its own today is urgent`,
    commitmentQuadrant({ important: true }, plusDays(today, URGENT_THRESHOLD_DAYS), tz, NOW),
    "do",
  );
  check(
    `${tz}: one further out is not`,
    commitmentQuadrant({ important: true }, plusDays(today, URGENT_THRESHOLD_DAYS + 1), tz, NOW),
    "schedule",
  );
  check(`${tz}: its own today is urgent`, commitmentQuadrant({ important: true }, today, tz, NOW), "do");
}

// A task's deadline_at IS a real timestamp, so it must still be read in the
// account's zone — the fix above must not have leaked into this path.
console.log("\n== a task's deadline is a real instant, and still read in the account's zone ==");
const lateNight = new Date("2026-08-11T03:30:00Z"); // 11:30pm Aug 10 in New York
check(
  "an instant is judged by the account's calendar day",
  isUrgent({ deadline_at: lateNight.toISOString(), important: true }, "America/New_York", NOW),
  true,
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
