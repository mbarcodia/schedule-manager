// Verifies reminder lead-time parsing and the fire/stale window
// (npx tsx scripts/sanity-check-reminders.mjs).

import { parseLeadMinutes } from "../src/lib/planner/todo-reminder-tools.ts";

const WEEK = 7 * 24 * 60, DAY = 24 * 60, HOUR = 60;
const leadCases = [
  // The exact phrasing from the request:
  ["1 week before and 1 day before", [WEEK, DAY]],
  ["1 week before, 1 day before", [WEEK, DAY]],
  ["a day before", [DAY]],
  ["2 weeks before", [2 * WEEK]],
  ["3 hours before", [3 * HOUR]],
  ["on the day", [0]],
  ["1 week before, 1 day before, on the day", [WEEK, DAY, 0]],
  [undefined, [DAY]],           // sensible default
  ["gibberish", [DAY]],          // never silently produce zero leads
  ["1 day before and 1 day before", [DAY]], // de-duplicated
];

let failed = 0;
for (const [input, want] of leadCases) {
  const got = parseLeadMinutes(input);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} leads ${JSON.stringify(input)} -> [${got}]${ok ? "" : ` (want [${want}])`}`);
}

// The cron's fire window: due, but not more than a day stale.
const fires = (dueMs, lead, now) => {
  const lateBy = now - (dueMs - lead * 60_000);
  return lateBy >= 0 && lateBy < DAY * 60_000;
};
const due = Date.UTC(2026, 10, 10, 14, 0);
const winCases = [
  ["a week before, checked a week before", fires(due, WEEK, due - WEEK * 60_000), true],
  ["a week before, checked 8 days before (too early)", fires(due, WEEK, due - 8 * DAY * 60_000), false],
  ["a week before, checked 2h late (still fires)", fires(due, WEEK, due - WEEK * 60_000 + 2 * 3600_000), true],
  ["a week before, checked 3 days late (stale, dropped)", fires(due, WEEK, due - 4 * DAY * 60_000), false],
  ["day-before lead, checked at that moment", fires(due, DAY, due - DAY * 60_000), true],
];
for (const [label, got, want] of winCases) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label} -> ${got}`);
}
process.exit(failed ? 1 : 0);
