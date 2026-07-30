// Verifies research pinning (run: npx tsx scripts/sanity-check-research-pin.mjs).
// A pinned research hour must (a) appear at the pinned slot carrying the
// Research tag label and the project's id, and (b) reduce that week's
// auto-placed chunk for the same project by exactly the pinned minutes —
// so weekly totals stay honest instead of double-counting.

import { computeSchedule } from "../src/lib/scheduling/engine.ts";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const WEEKLY_MIN = 360; // 6h weekly research floor

function inputs(researchPins) {
  return {
    timezone: "America/New_York",
    horizonWeeks: 2,
    weeklyHours: Object.fromEntries(
      Array.from({ length: 7 }, (_, d) => [d, d < 5 ? { start: 9 * 60, end: 17 * 60 } : null]),
    ),
    tasks: [],
    projects: [
      {
        id: PROJECT_ID,
        title: "Ocean model study",
        weeklyMinMin: WEEKLY_MIN,
        chunk: 120,
        preferMorning: true,
        researchOrd: 1,
        categoryId: null,
        deadlineDate: null,
      },
    ],
    events: [],
    recurringRules: [],
    dayOverrides: {},
    researchPins,
    completed: {},
    partial: {},
    pinned: {},
    tagLabels: { task: "Task", research: "Research", deepFocus: "Deep focus", block: "Block" },
  };
}

// Missed blocks stay in the output alongside the rescheduled replacement
// minutes they generated, so only live (non-missed) time reflects the real
// weekly commitment.
const researchMinutes = (blocks, week) =>
  blocks
    .filter(
      (b) =>
        b.taskId === `research-${PROJECT_ID}-w${week}` &&
        Math.floor(b.gday / 7) === week &&
        b.status !== "missed",
    )
    .reduce((sum, b) => sum + (b.end - b.start), 0);

// A fixed Monday morning. With a real `new Date()` the Wednesday-14:00 pin
// below is already in the past whenever this runs after 3pm midweek, so the
// pinned hour reads as missed and the weekly total looks 60m short — a failure
// that says nothing about pinning.
const NOW = new Date(2026, 6, 27, 8, 0);

// Baseline: no pins.
const base = computeSchedule(inputs([]), NOW);
const baseWeek0 = researchMinutes(base.blocks, 0);

// Pinned: 60 minutes fixed to Wednesday (gday 2) at 14:00 this week.
const PIN = { projectId: PROJECT_ID, gday: 2, start: 14 * 60, length: 60 };
const pinned = computeSchedule(inputs([PIN]), NOW);
const pinnedWeek0 = researchMinutes(pinned.blocks, 0);
const atSlot = pinned.blocks.filter((b) => b.gday === PIN.gday && b.start === PIN.start);

const checks = [
  ["baseline places the full weekly floor", baseWeek0 === WEEKLY_MIN, `${baseWeek0}m vs ${WEEKLY_MIN}m`],
  ["pinned run still totals the weekly floor (no double-count)", pinnedWeek0 === WEEKLY_MIN, `${pinnedWeek0}m vs ${WEEKLY_MIN}m`],
  ["a block exists exactly at the pinned slot", atSlot.length === 1, `${atSlot.length} blocks at Wed 14:00`],
  ["that block belongs to the research project", atSlot[0]?.projectId === PROJECT_ID, String(atSlot[0]?.projectId)],
  ["it carries the Research tag label (not a generic event)", atSlot[0]?.tagLabel === "Research", String(atSlot[0]?.tagLabel)],
  ["it is a task-type block, so it gets a done-checkbox", atSlot[0]?.type === "task", String(atSlot[0]?.type)],
  ["it is NOT flagged done-early", !atSlot[0]?.pinned, `pinned=${atSlot[0]?.pinned}`],
  ["pinned length is exactly as requested", atSlot[0] && atSlot[0].end - atSlot[0].start === PIN.length, `${atSlot[0]?.end - atSlot[0]?.start}m`],
];

let failed = 0;
for (const [label, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` — got ${detail}`}`);
}
process.exit(failed ? 1 : 0);
