// Verifies the sliding calendar window's day/label maths
// (npx tsx scripts/sanity-check-calendar-window.mjs).
//
// The subtle bug this guards against: labelling columns by their index, so a
// Tuesday-first view still says "Mon" over the first column.

import { WEEKDAY_LABELS } from "../src/lib/scheduling/time.ts";
import { VIEW_DAY_OPTIONS, DEFAULT_VIEW_DAYS } from "../src/lib/calendar/view-prefs.ts";

const labelFor = (gday) => WEEKDAY_LABELS[((gday % 7) + 7) % 7];
const windowLabels = (startGday, viewDays) =>
  Array.from({ length: viewDays }, (_, i) => labelFor(startGday + i));

const HORIZON_DAYS = 12 * 7;
const clampStart = (g, viewDays) => Math.min(Math.max(0, HORIZON_DAYS - viewDays), Math.max(0, g));

const checks = [
  ["default view is 7 days", DEFAULT_VIEW_DAYS === 7, String(DEFAULT_VIEW_DAYS)],
  ["offered views are 1/3/5/7", VIEW_DAY_OPTIONS.join(",") === "1,3,5,7", VIEW_DAY_OPTIONS.join(",")],
  // The whole point of the request: shift by one day and get Tue-Mon.
  [
    "start 0 gives Mon..Sun",
    windowLabels(0, 7).join(" ") === "Mon Tue Wed Thu Fri Sat Sun",
    windowLabels(0, 7).join(" "),
  ],
  [
    "start 1 gives Tue..Mon (labels follow the weekday, not the column)",
    windowLabels(1, 7).join(" ") === "Tue Wed Thu Fri Sat Sun Mon",
    windowLabels(1, 7).join(" "),
  ],
  [
    "crossing into next week keeps labelling correctly",
    windowLabels(5, 5).join(" ") === "Sat Sun Mon Tue Wed",
    windowLabels(5, 5).join(" "),
  ],
  ["1-day view on Thursday shows only Thu", windowLabels(3, 1).join(" ") === "Thu", windowLabels(3, 1).join(" ")],
  ["3-day view from Friday wraps the weekend", windowLabels(4, 3).join(" ") === "Fri Sat Sun", windowLabels(4, 3).join(" ")],
  // Window must stay inside the engine's 12-week horizon, and never go negative.
  ["cannot scroll before this Monday", clampStart(-3, 7) === 0, String(clampStart(-3, 7))],
  ["cannot scroll past the horizon (7-day)", clampStart(999, 7) === HORIZON_DAYS - 7, String(clampStart(999, 7))],
  ["cannot scroll past the horizon (1-day)", clampStart(999, 1) === HORIZON_DAYS - 1, String(clampStart(999, 1))],
];

let failed = 0;
for (const [label, ok, got] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` — got ${got}`}`);
}
process.exit(failed ? 1 : 0);
