// Quick manual sanity check for the ported scheduling engine — not a full
// test suite, just enough to confirm the port behaves like the prototype
// before wiring it into the UI. Run with: npx tsx scripts/sanity-check-engine.mjs
import { computeSchedule } from "../src/lib/scheduling/engine.ts";

const timezone = "America/New_York";

const inputs = {
  timezone,
  horizonWeeks: 12,
  // Mon-Fri 9-17, weekends off. (This fixture used to carry the prototype's
  // single workStartHour/workEndHour pair, which the engine stopped reading
  // when per-weekday hours landed — hence the crash this replaces.)
  weeklyHours: Object.fromEntries(
    Array.from({ length: 7 }, (_, d) => [d, d < 5 ? { start: 9 * 60, end: 17 * 60 } : null]),
  ),
  tasks: [
    {
      id: "t1",
      title: "Write report",
      priority: "high",
      duration: 120,
      chunk: 60,
      deadline: 99999,
      floor: 0,
    },
    {
      id: "t2",
      title: "Weekend catch-up",
      priority: "medium",
      duration: 60,
      chunk: 60,
      deadline: 99999,
      floor: 0,
    },
  ],
  projects: [
    {
      id: "proj-a",
      title: "Ocean model study",
      weeklyMinMin: 480,
      researchOrd: 1,
      preferMorning: true,
      chunk: 120,
    },
    {
      id: "proj-b",
      title: "Threshold analysis",
      weeklyMinMin: 360,
      researchOrd: 2,
      preferMorning: true,
      chunk: 120,
    },
  ],
  events: [{ id: "ev1", title: "Standup", gday: 0, start: 600, end: 630 }],
  recurringRules: [
    { id: "r-email-am", title: "Email", tag: "email", days: [0, 1, 2, 3, 4], length: 15, winStart: 540, winEnd: 555 },
    { id: "r-lunch", title: "Lunch", tag: "lunch", days: [0, 1, 2, 3, 4], length: 45, winStart: 720, winEnd: 810 },
  ],
  dayOverrides: {
    // Explicitly allow this week's Saturday (gday 5)
    5: { allowWeekend: true, start: 10 * 60, end: 14 * 60 },
  },
  researchPins: [],
  graceHours: 4,
  tagLabels: { task: "Task", research: "Research", deepFocus: "Deep focus", block: "Block" },
  completed: {},
  partial: {},
  pinned: {},
};

// A fixed Monday morning, so nothing in the fixture's week has already passed —
// with a real `new Date()` the output changes shape depending on the hour it's
// run, which makes the printed schedule impossible to compare against.
const result = computeSchedule(inputs, new Date(2026, 6, 27, 8, 0));

console.log("=== Blocks (first 20) ===");
for (const b of result.blocks.slice(0, 20)) {
  console.log(
    `gday=${b.gday} (${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][b.gday % 7]}, wk${Math.floor(b.gday/7)}) ${b.start}-${b.end}  [${b.type}] ${b.title}`,
  );
}
console.log("\nTotal blocks:", result.blocks.length);
console.log("Overflow:", result.overflow);
console.log("Risk:", result.risk);
console.log("Missed:", result.missed);

const weekendBlocks = result.blocks.filter((b) => b.gday % 7 === 5 || b.gday % 7 === 6);
console.log("\nWeekend blocks (should only be gday=5, week 0, since that's the only opted-in day):");
for (const b of weekendBlocks) {
  console.log(`  gday=${b.gday} ${b.start}-${b.end} ${b.title}`);
}

const researchWk0 = result.blocks.filter(
  (b) => b.projectId === "proj-a" && Math.floor(b.gday / 7) === 0,
);
const researchMin = researchWk0.reduce((s, b) => s + (b.end - b.start), 0);
console.log(`\nOcean model study research minutes scheduled in week 0: ${researchMin} (target 480)`);

const problems = [];
const strayWeekend = weekendBlocks.filter((b) => !(b.gday === 5));
if (strayWeekend.length) problems.push(`${strayWeekend.length} block(s) on a day that was never opted in`);
if (researchMin !== 480) problems.push(`Ocean model study got ${researchMin}m of research in week 0, not its 480m floor`);
for (const p of problems) console.log(`FAIL ${p}`);
console.log(problems.length ? "" : "\nall engine sanity checks passed");
process.exit(problems.length ? 1 : 0);
