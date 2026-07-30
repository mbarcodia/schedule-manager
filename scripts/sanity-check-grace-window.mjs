// Verifies the grace window for un-ticked work (run: npx tsx
// scripts/sanity-check-grace-window.mjs). A task slot whose time has passed
// with nothing logged must go through three states as the clock moves:
//
//   still running          -> "active"  (nothing is owed yet)
//   passed, within grace   -> "grace"   (stays in place, still tickable)
//   passed, beyond grace   -> "missed"  (definitively gone)
//
// and in BOTH the grace and missed states its hours must be re-placed
// elsewhere, so a forgotten checkmark never quietly shrinks the week's work.

import { computeSchedule } from "../src/lib/scheduling/engine.ts";

const TZ = "America/New_York";
const TASK_ID = "22222222-2222-2222-2222-222222222222";
const DURATION = 60;

// A Wednesday, so there are weekdays either side to reschedule into. gday 0 is
// always the Monday of the current week, so Wednesday is gday 2.
const wednesday = (hour, minute = 0) => new Date(2026, 6, 29, hour, minute);
const WED_GDAY = 2;
// Earliest-start floor, so the engine can't place the hour on Monday or
// Tuesday — both already in the past from Wednesday, which would make every
// status below a foregone "missed".
const FLOOR = WED_GDAY * 1440 + 9 * 60;

function inputs(graceHours) {
  return {
    timezone: TZ,
    horizonWeeks: 2,
    weeklyHours: Object.fromEntries(
      Array.from({ length: 7 }, (_, d) => [d, d < 5 ? { start: 9 * 60, end: 17 * 60 } : null]),
    ),
    tasks: [
      {
        id: TASK_ID,
        title: "Write abstract",
        priority: "high",
        duration: DURATION,
        chunk: DURATION,
        deadline: 99999,
        floor: FLOOR,
        ord: 0,
      },
    ],
    projects: [],
    events: [],
    recurringRules: [],
    dayOverrides: {},
    graceHours,
    researchPins: [],
    completed: {},
    partial: {},
    pinned: {},
    tagLabels: { task: "Task", research: "Research", deepFocus: "Deep focus", block: "Block" },
  };
}

const chunks = (blocks) => blocks.filter((b) => b.taskId === TASK_ID);
/** Minutes the engine is still planning to spend — i.e. not written off. */
const liveMinutes = (blocks) =>
  chunks(blocks)
    .filter((b) => b.status !== "missed" && b.status !== "grace")
    .reduce((sum, b) => sum + (b.end - b.start), 0);

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "  OK" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

// The task lands in the first free morning slot: Wednesday 9:00-10:00.
const placed = chunks(computeSchedule(inputs(4), wednesday(8, 0)).blocks)[0];
check("placed on Wednesday", placed.gday, WED_GDAY);
check("placed at 9:00", placed.start, 9 * 60);
check("not yet started, so no status", placed.status ?? "none", "none");
console.log(`first slot: gday ${placed.gday}, ${placed.start}-${placed.end}, status ${placed.status ?? "none"}`);

// Mid-slot — the hour is in progress, nothing is owed.
const mid = computeSchedule(inputs(4), wednesday(9, 30)).blocks;
check(
  "mid-slot status",
  chunks(mid).find((b) => b.gday === placed.gday && b.start === placed.start)?.status,
  "active",
);

// One hour past the end, four-hour grace: greyed but still standing.
const inGrace = computeSchedule(inputs(4), wednesday(11, 0)).blocks;
const graced = chunks(inGrace).find((b) => b.gday === placed.gday && b.start === placed.start);
check("1h past, 4h grace", graced?.status, "grace");
check("grace keeps its original slot", graced?.start, placed.start);
check("grace re-places the hour", liveMinutes(inGrace), DURATION);

// The window's last minute is inclusive: exactly one hour past the end of the
// slot, with a one-hour window, is still the user's to tick.
const atBoundary = computeSchedule(inputs(1), wednesday(11, 0)).blocks;
check(
  "exactly 1h past, 1h grace",
  chunks(atBoundary).find((b) => b.gday === placed.gday && b.start === placed.start)?.status,
  "grace",
);

// A minute later, the same one-hour window has closed.
const shortWindow = computeSchedule(inputs(1), wednesday(11, 1)).blocks;
check(
  "1h01 past, 1h grace",
  chunks(shortWindow).find((b) => b.gday === placed.gday && b.start === placed.start)?.status,
  "missed",
);

// Five hours past the end: the four-hour window has closed too.
const lapsed = computeSchedule(inputs(4), wednesday(15, 0)).blocks;
check(
  "5h past, 4h grace",
  chunks(lapsed).find((b) => b.gday === placed.gday && b.start === placed.start)?.status,
  "missed",
);
check("missed re-places the hour", liveMinutes(lapsed), DURATION);

// Zero disables the window outright — the old behaviour.
const noGrace = computeSchedule(inputs(0), wednesday(10, 1)).blocks;
check(
  "1min past, 0h grace",
  chunks(noGrace).find((b) => b.gday === placed.gday && b.start === placed.start)?.status,
  "missed",
);

// Ticking it off inside the window credits the hour and drops the replacement.
const tickedInputs = inputs(4);
tickedInputs.completed[`${TASK_ID}@${placed.gday}-${placed.start}`] = true;
const ticked = computeSchedule(tickedInputs, wednesday(11, 0)).blocks;
const tickedChunk = chunks(ticked).find((b) => b.gday === placed.gday && b.start === placed.start);
check("ticked during grace", tickedChunk?.status, "done");
check("ticked leaves no replacement", chunks(ticked).length, 1);

// Choosing "Just now" instead pins the hour at the moment of ticking (see
// useScheduleData.pinDone). The task must then be fully credited — no leftover
// duration re-placed elsewhere, and no second copy of the original slot.
const pinnedInputs = inputs(4);
const pinStart = 10 * 60; // pinDone backdates the pin so it ends "now" (11:00)
pinnedInputs.pinned[`${TASK_ID}@${WED_GDAY}-${pinStart}`] = {
  taskId: TASK_ID,
  projectId: null,
  tagLabel: "Task",
  title: "Write abstract",
  gday: WED_GDAY,
  start: pinStart,
  end: pinStart + DURATION,
  priority: "high",
};
const justNow = computeSchedule(pinnedInputs, wednesday(11, 0)).blocks;
check("pinned 'just now' is done", chunks(justNow).find((b) => b.start === pinStart)?.status, "done");
check("pinned 'just now' leaves nothing owing", liveMinutes(justNow), DURATION);
check("pinned 'just now' leaves one block", chunks(justNow).length, 1);

console.log(failures ? `\n${failures} check(s) failed` : "\nall grace-window checks passed");
process.exit(failures ? 1 : 0);
