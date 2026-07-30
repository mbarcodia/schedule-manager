// Verifies when a to-do list chases what's still unticked (run: npx tsx
// scripts/sanity-check-list-chase.mjs).
//
// A list can be chased at the end of each week, month or year. "End" means the
// user's own evening on the last day of that period, not UTC midnight — and the
// month case has to survive 30- vs 31-day months and leap February, which is
// otherwise the sort of thing you only discover in late February.

import { isPeriodEnd, periodStart, CHASE_MINUTE_OF_DAY } from "../src/lib/notifications/chase.ts";

/** ZonedNow for a given local civil moment. weekdayIdx is 0=Mon..6=Sun. */
function at(year, month, day, minuteOfDay) {
  const weekdayIdx = (new Date(year, month - 1, day).getDay() + 6) % 7;
  return { year, month, day, minuteOfDay, weekdayIdx };
}

const EVENING = CHASE_MINUTE_OF_DAY;
const MORNING = 9 * 60;

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "  OK" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

// --- weekly: Sunday evening only -------------------------------------------
// 2026-08-02 is a Sunday; 2026-08-01 a Saturday; 2026-08-03 a Monday.
check("Sunday evening", isPeriodEnd("week", at(2026, 8, 2, EVENING)), true);
check("Sunday morning (too early)", isPeriodEnd("week", at(2026, 8, 2, MORNING)), false);
check("Saturday evening", isPeriodEnd("week", at(2026, 8, 1, EVENING)), false);
check("Monday evening", isPeriodEnd("week", at(2026, 8, 3, EVENING)), false);

// --- monthly: the actual last day, whatever length the month is ------------
check("31 Aug (31-day month)", isPeriodEnd("month", at(2026, 8, 31, EVENING)), true);
check("30 Aug", isPeriodEnd("month", at(2026, 8, 30, EVENING)), false);
check("30 Sep (30-day month)", isPeriodEnd("month", at(2026, 9, 30, EVENING)), true);
check("31 Oct", isPeriodEnd("month", at(2026, 10, 31, EVENING)), true);
// February is the case that catches a hardcoded table.
check("28 Feb 2026 (common year)", isPeriodEnd("month", at(2026, 2, 28, EVENING)), true);
check("28 Feb 2028 (leap year)", isPeriodEnd("month", at(2028, 2, 28, EVENING)), false);
check("29 Feb 2028 (leap year)", isPeriodEnd("month", at(2028, 2, 29, EVENING)), true);
check("last day but morning", isPeriodEnd("month", at(2026, 8, 31, MORNING)), false);

// --- yearly: 31 December only ----------------------------------------------
check("31 Dec", isPeriodEnd("year", at(2026, 12, 31, EVENING)), true);
check("30 Dec", isPeriodEnd("year", at(2026, 12, 30, EVENING)), false);
check("31 Jan", isPeriodEnd("year", at(2026, 1, 31, EVENING)), false);

// --- one chase per period ---------------------------------------------------
// last_chased_at is compared against the start of the current period: a chase
// from within this period suppresses another, one from before it does not.
const now = new Date(2026, 7, 2, 17, 30); // Sunday evening
const hoursAgo = (h) => new Date(now.getTime() - h * 3600_000).getTime();
check("chased an hour ago suppresses", hoursAgo(1) > periodStart("week", now), true);
check("chased 8 days ago does not", hoursAgo(24 * 8) > periodStart("week", now), false);
check("chased 40 days ago does not (monthly)", hoursAgo(24 * 40) > periodStart("month", now), false);
check("chased 10 days ago still does (monthly)", hoursAgo(24 * 10) > periodStart("month", now), true);

console.log(failures ? `\n${failures} check(s) failed` : "\nall list-chase checks passed");
process.exit(failures ? 1 : 0);
