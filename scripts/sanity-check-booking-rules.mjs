// Verifies a booking link's timing rules, including the "none" options
// (run: npx tsx scripts/sanity-check-booking-rules.mjs).
//
// max_per_day was NOT NULL, so "as many as fit" could only be approximated with
// a large number — a guess that silently becomes wrong. Null now means no
// maximum, and null must not be read as zero anywhere, which would close the day
// completely.

import { slotIsOffered } from "../src/lib/scheduling/free-slots.ts";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}
function checkThat(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`  ${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `  ${detail}`}`);
}

/** The shape computeFreeSlots/isSlotFree read, without touching a database. */
function ctx(bookingsToday, { minNoticeAbs = 0 } = {}) {
  return {
    busy: new Set(),
    timezone: "America/New_York",
    weeklyHours: Object.fromEntries(
      Array.from({ length: 7 }, (_, d) => [d, d < 5 ? { start: 9 * 60, end: 17 * 60 } : null]),
    ),
    dayOverrides: {},
    minNoticeAbs,
    bookingsPerGday: new Map([[0, bookingsToday]]),
    horizonWeeks: 2,
    allDayBlocks: {},
  };
}
const link = (over = {}) => ({
  durations: [30],
  day_windows: Object.fromEntries(
    Array.from({ length: 7 }, (_, d) => [String(d), d < 5 ? { start: 9 * 60, end: 17 * 60 } : null]),
  ),
  buffer_min: 0,
  min_notice_hours: 0,
  max_per_day: 3,
  blocking_category_ids: [],
  ...over,
});

const MON_10AM = 10 * 60; // gday 0

// --- daily cap --------------------------------------------------------------
checkThat("under the cap, a slot is offered", slotIsOffered(ctx(2), link({ max_per_day: 3 }), 0, MON_10AM, 30));
checkThat("at the cap, it is refused", !slotIsOffered(ctx(3), link({ max_per_day: 3 }), 0, MON_10AM, 30));
checkThat(
  "no maximum accepts a day already full of meetings",
  slotIsOffered(ctx(99), link({ max_per_day: null }), 0, MON_10AM, 30),
);
// The bug to guard against: null read as 0 would close every day.
checkThat("no maximum does not behave like zero", slotIsOffered(ctx(0), link({ max_per_day: null }), 0, MON_10AM, 30));

// --- notice -----------------------------------------------------------------
checkThat(
  "zero notice allows a slot starting right now",
  slotIsOffered(ctx(0, { minNoticeAbs: MON_10AM }), link({ min_notice_hours: 0 }), 0, MON_10AM, 30),
);
checkThat(
  "notice refuses a slot before the cutoff",
  !slotIsOffered(ctx(0, { minNoticeAbs: MON_10AM + 60 }), link(), 0, MON_10AM, 30),
);

// --- day windows ------------------------------------------------------------
checkThat(
  "a slot outside the link's window is refused",
  !slotIsOffered(ctx(0), link(), 0, 8 * 60, 30),
);
checkThat(
  "a closed day is refused",
  !slotIsOffered(ctx(0), link(), 5, MON_10AM, 30),
);
checkThat(
  "a slot running past the window's end is refused",
  !slotIsOffered(ctx(0), link(), 0, 16 * 60 + 45, 30),
);

// --- all-day blocks ---------------------------------------------------------
const away = { ...ctx(0), allDayBlocks: { 0: "no_meetings" } };
checkThat("a day claimed by an all-day entry is refused", !slotIsOffered(away, link(), 0, MON_10AM, 30));

console.log(failures ? `\n${failures} check(s) failed` : "\nall booking-rule checks passed");
process.exit(failures ? 1 : 0);
