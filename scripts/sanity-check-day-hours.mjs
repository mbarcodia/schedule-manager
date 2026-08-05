// Sanity check for one day's hours — the form's edges AND how the engine
// resolves what it writes (run: npx tsx scripts/sanity-check-day-hours.mjs).
//
// Both halves are here on purpose. The form's job is to produce a row that means
// what the user said, and the only way to know it does is to run the row back
// through resolveDayWindow, which is what the engine and the calendar both use.
// The bug this pairing exists to prevent: an all-null override reads as NO
// override and falls back to the weekday's standard hours, so the obvious way to
// close a day silently did nothing.

import { validateDayHours, dayHoursRow, timeValue, dateKey } from "../src/lib/calendar/day-hours.ts";
import { resolveDayWindow, defaultDayWindow } from "../src/lib/scheduling/day-window.ts";

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

const WEEKDAYS = { 0: { start: 540, end: 1020 }, 1: { start: 540, end: 1020 }, 2: { start: 540, end: 1020 }, 3: { start: 540, end: 1020 }, 4: { start: 540, end: 1020 }, 5: null, 6: null };
const draft = (over = {}) => ({ mode: "hours", startText: "09:00", endText: "17:00", allowWeekend: true, ...over });

// ------------------------------------------------------------------ time values

check("minutes to a time input", [timeValue(540), timeValue(0), timeValue(null)], ["09:00", "00:00", ""]);
check("a date key is built from local parts, never UTC", dateKey({ year: 2026, month: 8, day: 5 }), "2026-08-05");
check("single digits are padded", dateKey({ year: 2026, month: 1, day: 9 }), "2026-01-09");

// -------------------------------------------------------------------- validation

check("a normal shortened day is fine", validateDayHours(draft({ endText: "12:00" }), false), []);
check("a missing start is blocked", validateDayHours(draft({ startText: "" }), false).length, 1);
check("a missing end is blocked", validateDayHours(draft({ endText: "" }), false).length, 1);
check(
  "backwards hours are blocked",
  validateDayHours(draft({ startText: "17:00", endText: "09:00" }), false),
  ["This day would end before it starts."],
);
check(
  "hours on a day that's off by default need the opt-in, or nothing would be scheduled",
  validateDayHours(draft({ allowWeekend: false }), true),
  ["This weekday is off in your standard hours — tick “work this day anyway” or nothing will be scheduled."],
);
check("with the opt-in it's fine", validateDayHours(draft({ allowWeekend: true }), true), []);
check("closing a day needs no times at all", validateDayHours({ mode: "closed", startText: "", endText: "", allowWeekend: false }, false), []);
check("closing a day that's off by default is fine too", validateDayHours({ mode: "closed", startText: "", endText: "", allowWeekend: false }, true), []);

// -------------------------------------------------------------------- the row

check("a shortened day", dayHoursRow(draft({ endText: "12:00" }), false), {
  start_min: 540,
  end_min: 720,
  allow_weekend: true,
  closed: false,
});
check(
  "closing a day KEEPS its hours, so re-opening restores them",
  dayHoursRow({ mode: "closed", startText: "09:00", endText: "12:00", allowWeekend: false }, false),
  { start_min: 540, end_min: 720, allow_weekend: false, closed: true },
);
check("a draft that doesn't validate writes nothing", dayHoursRow(draft({ startText: "" }), false), null);

// ----------------------------------------------- what the engine does with it
// gday 2 = Wednesday of this week, a normal working day. gday 5 = Saturday, off.

const resolve = (gday, override) => resolveDayWindow(gday, WEEKDAYS, override ? { [gday]: override } : {});

const asOverride = (row) => ({
  start: row.start_min ?? undefined,
  end: row.end_min ?? undefined,
  allowWeekend: row.allow_weekend,
  closed: row.closed,
});

check("no override: the weekday's standard hours", resolve(2, null), { start: 540, end: 1020 });
check(
  "a shortened day actually shortens it",
  resolve(2, asOverride(dayHoursRow(draft({ endText: "12:00" }), false))),
  { start: 540, end: 720 },
);
check(
  "A CLOSED DAY HAS NO WINDOW — the whole point of the `closed` column",
  resolve(2, asOverride(dayHoursRow({ mode: "closed", startText: "09:00", endText: "17:00", allowWeekend: false }, false))),
  null,
);
check(
  "the pre-0036 guess at closing a day did nothing: all-null falls back to standard",
  resolve(2, { start: undefined, end: undefined, allowWeekend: false }),
  { start: 540, end: 1020 },
);
check("a Saturday is off by default", resolve(5, null), null);
check(
  "a Saturday with hours and the opt-in is open",
  resolve(5, asOverride(dayHoursRow(draft({ startText: "10:00", endText: "14:00" }), true))),
  { start: 600, end: 840 },
);
check(
  "a closed Saturday stays closed even with the opt-in stored",
  resolve(5, { start: 600, end: 840, allowWeekend: true, closed: true }),
  null,
);
check("removing the override returns the day to standard", resolve(2, null), { start: 540, end: 1020 });

// ------------------------------------------------------------ past days resolve
// Same class of bug as the one fixed in resolveDayWindow: `-5 % 7` is -5, so a
// past day looked up weeklyHours[-5], found nothing, and every day before this
// week reported as a day off.

check("a past weekday resolves to its standard hours", resolve(-5, null), { start: 540, end: 1020 });
check("a past weekday's DEFAULT also resolves", defaultDayWindow(-5, WEEKDAYS), { start: 540, end: 1020 });
check("a past Saturday is still off", defaultDayWindow(-2, WEEKDAYS), null);
check("today's default is unaffected", defaultDayWindow(2, WEEKDAYS), { start: 540, end: 1020 });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
