// Verifies which calendar days a multi-day all-day event actually covers
// (run: npx tsx scripts/sanity-check-all-day-days.mjs).
//
// The bug this pins: day boundaries were built with the process's local
// midnight. Sync runs on Vercel in UTC, so a 3-7 August conference was stored as
// five 8pm-to-8pm spans in a UTC-4 account — every day landed on the evening
// before, and the final day fell off the end entirely, leaving it bookable while
// the owner was away. The account's timezone is the only correct anchor.

import { expandAllDayForTest } from "../src/lib/calendar-sync/ics.ts";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${ok ? "" : `\n       got  ${JSON.stringify(actual)}\n       want ${JSON.stringify(expected)}`}`);
}

/** Which local calendar dates a span lands on, as the app would read them. */
const localDates = (events, tz) =>
  events.map((e) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      e.startsAt,
    ),
  );

// A date-valued DTSTART/DTEND as node-ical yields it: UTC midnight, end exclusive.
const start = new Date(Date.UTC(2026, 7, 3));
const end = new Date(Date.UTC(2026, 7, 8));

for (const tz of ["America/New_York", "America/Los_Angeles", "UTC", "Australia/Sydney", "Asia/Kolkata"]) {
  const days = expandAllDayForTest("uid-1", "Conference", start, end, tz);
  check(`${tz} covers Mon 3 to Fri 7`, localDates(days, tz), [
    "2026-08-03",
    "2026-08-04",
    "2026-08-05",
    "2026-08-06",
    "2026-08-07",
  ]);
  // Each entry must be exactly one local day long, or it bleeds into the next.
  const spans = days.map((d) => (d.endsAt.getTime() - d.startsAt.getTime()) / 3600000);
  check(`${tz} each entry is one day`, spans, [24, 24, 24, 24, 24]);
}

// A single-day event stays one day.
const one = expandAllDayForTest("uid-2", "Holiday", new Date(Date.UTC(2026, 7, 3)), new Date(Date.UTC(2026, 7, 4)), "America/New_York");
check("a one-day event yields one entry", localDates(one, "America/New_York"), ["2026-08-03"]);

// A feed with end <= start must still produce the day rather than nothing.
const malformed = expandAllDayForTest("uid-3", "Odd", new Date(Date.UTC(2026, 7, 3)), new Date(Date.UTC(2026, 7, 3)), "America/New_York");
check("a malformed span still yields its day", localDates(malformed, "America/New_York"), ["2026-08-03"]);

// Spanning a DST change: the clocks shift, the dates must not.
const dst = expandAllDayForTest("uid-4", "Trip", new Date(Date.UTC(2026, 10, 1)), new Date(Date.UTC(2026, 10, 4)), "America/New_York");
check("a span across a DST change keeps its dates", localDates(dst, "America/New_York"), [
  "2026-11-01",
  "2026-11-02",
  "2026-11-03",
]);

console.log(failures ? `\n${failures} check(s) failed` : "\nall all-day date checks passed");
process.exit(failures ? 1 : 0);
