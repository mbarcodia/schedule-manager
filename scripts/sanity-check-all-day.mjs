// Verifies what all-day calendar events block (run: npx tsx
// scripts/sanity-check-all-day.mjs).
//
// All-day entries used to be discarded outright, for a defensible reason: a
// calendar full of birthday banners would otherwise erase the month. But that
// left a week-long "at a conference" event invisible, so the public booking page
// offered those days to strangers and the scheduler planned work as if the week
// were free.
//
// Now each connected calendar decides. The two modes differ in exactly one way:
//
//   no_meetings — unbookable by others, own work still scheduled (conference)
//   away        — nothing scheduled at all (leave)
//
// Both must be unbookable. Only "away" may touch the owner's own scheduling.

import { computeSchedule } from "../src/lib/scheduling/engine.ts";
import { resolveDayWindow } from "../src/lib/scheduling/day-window.ts";

const TZ = "America/New_York";
const TASK = "55555555-5555-5555-5555-555555555555";
const MONDAY = new Date(2026, 6, 27, 8, 0);

function inputs(allDayBlocks, { allDayEvents = [] } = {}) {
  return {
    timezone: TZ,
    horizonWeeks: 2,
    weeklyHours: Object.fromEntries(
      Array.from({ length: 7 }, (_, d) => [d, d < 5 ? { start: 9 * 60, end: 17 * 60 } : null]),
    ),
    tasks: [
      {
        id: TASK,
        title: "Analysis",
        priority: "high",
        duration: 300,
        chunk: 60,
        deadline: 99999,
        floor: 0,
        ord: 0,
      },
    ],
    projects: [],
    // An all-day entry spans midnight to midnight; if it were treated as busy
    // time it would erase the day.
    events: allDayEvents,
    recurringRules: [],
    dayOverrides: {},
    graceHours: 4,
    allDayBlocks,
    researchPins: [],
    completed: {},
    partial: {},
    pinned: {},
    tagLabels: { task: "Work", research: "Research", deepFocus: "Deep focus", block: "Routine" },
  };
}

const workOn = (blocks, gday) =>
  blocks.filter((b) => b.type === "task" && b.gday === gday).reduce((a, b) => a + (b.end - b.start), 0);

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

// --- no_meetings: a working day that others can't book -----------------------
const conference = computeSchedule(inputs({ 0: "no_meetings" }), MONDAY).blocks;
checkThat("no_meetings still schedules own work that day", workOn(conference, 0) > 0, `${workOn(conference, 0)}min`);
checkThat(
  "no_meetings leaves the day's hours open",
  resolveDayWindow(0, inputs({ 0: "no_meetings" }).weeklyHours, {}, { 0: "no_meetings" }) != null,
);

// --- away: nothing at all ---------------------------------------------------
const leave = computeSchedule(inputs({ 0: "away" }), MONDAY).blocks;
check("away schedules no work that day", workOn(leave, 0), 0);
check("away closes the day's hours", resolveDayWindow(0, inputs({}).weeklyHours, {}, { 0: "away" }), null);
// The hours have to go somewhere, not vanish.
const total = (blocks) => blocks.filter((b) => b.type === "task").reduce((a, b) => a + (b.end - b.start), 0);
check("away re-places those hours elsewhere", total(leave), 300);

// --- an unmarked day is untouched -------------------------------------------
const open = computeSchedule(inputs({}), MONDAY).blocks;
checkThat("with no all-day entry, Monday is a normal working day", workOn(open, 0) > 0);

// --- an all-day event must never consume hours itself ------------------------
// This is the failure the original code was avoiding: a banner marked busy from
// 00:00 to 24:00 wipes out the day even in "no_meetings" mode.
const banner = [
  { id: "ev-allday", title: "At a conference", gday: 0, start: 0, end: 1440, allDay: true },
];
const withBanner = computeSchedule(inputs({ 0: "no_meetings" }, { allDayEvents: banner }), MONDAY).blocks;
checkThat(
  "an all-day banner does not block the day it sits on",
  workOn(withBanner, 0) > 0,
  `${workOn(withBanner, 0)}min scheduled — the banner is being treated as busy time`,
);
checkThat(
  "the banner is still rendered, flagged as all-day",
  withBanner.some((b) => b.allDay && b.title === "At a conference"),
);
check("all hours still placed alongside the banner", total(withBanner), 300);

// A timed event on the same day must still block normally.
const timed = [
  { id: "ev-allday", title: "At a conference", gday: 0, start: 0, end: 1440, allDay: true },
  { id: "ev-timed", title: "Real meeting", gday: 0, start: 10 * 60, end: 11 * 60 },
];
const mixed = computeSchedule(inputs({ 0: "no_meetings" }, { allDayEvents: timed }), MONDAY).blocks;
checkThat(
  "a timed meeting on a banner day still blocks its hour",
  !mixed.some((b) => b.type === "task" && b.gday === 0 && b.start < 11 * 60 && b.end > 10 * 60),
);

console.log(failures ? `\n${failures} check(s) failed` : "\nall all-day checks passed");
process.exit(failures ? 1 : 0);
