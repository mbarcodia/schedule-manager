// "Not before next week" — the hard half of a backlog drop
// (run: npx tsx scripts/sanity-check-hold-until.mjs).
//
// A date computed from "today" is the kind that is quietly wrong by a day for
// months. The two cases that matter: on a MONDAY, "next week" must mean seven
// days out and not today; and on a SUNDAY it must mean tomorrow, not eight days
// away — Sunday is the end of the week here (0=Mon..6=Sun on the board's grid,
// but Date.getDay() has Sunday as 0, which is exactly where this goes wrong).

import { nextMondayISO } from "../src/lib/planner/board-actions.ts";

let failures = 0;
let checks = 0;
function check(label, actual, expected) {
  checks++;
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${actual}, want ${expected}`}`);
}

/** Local Y-M-D of the returned instant, which is what the user sees. */
const dayOf = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// The week of Monday 3 August 2026.
check("from Monday the 3rd -> Monday the 10th", dayOf(nextMondayISO(new Date(2026, 7, 3, 9, 0))), "2026-08-10");
check("from Tuesday the 4th -> Monday the 10th", dayOf(nextMondayISO(new Date(2026, 7, 4, 9, 0))), "2026-08-10");
check("from Friday the 7th -> Monday the 10th", dayOf(nextMondayISO(new Date(2026, 7, 7, 16, 0))), "2026-08-10");
check("from Saturday the 8th -> Monday the 10th", dayOf(nextMondayISO(new Date(2026, 7, 8, 12, 0))), "2026-08-10");
check("from Sunday the 9th -> Monday the 10th, not the 17th", dayOf(nextMondayISO(new Date(2026, 7, 9, 12, 0))), "2026-08-10");

// Late in the evening it is still the same day's answer — the floor is a date,
// and a task held back at 11pm Friday is held to the same Monday.
check("late on Friday is still the coming Monday", dayOf(nextMondayISO(new Date(2026, 7, 7, 23, 59))), "2026-08-10");

// Midnight local, so the whole of Monday is available rather than a stray
// afternoon floor cutting the first day in half.
const at = new Date(nextMondayISO(new Date(2026, 7, 5, 14, 30)));
check("it lands at local midnight", `${at.getHours()}:${at.getMinutes()}`, "0:0");

// Across a month and a year boundary, where date arithmetic done by hand fails.
check("across a month end", dayOf(nextMondayISO(new Date(2026, 7, 31, 9, 0))), "2026-09-07");
check("across a year end", dayOf(nextMondayISO(new Date(2026, 11, 28, 9, 0))), "2027-01-04");

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
