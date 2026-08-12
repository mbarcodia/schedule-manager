// Sanity check for collapsing the same meeting arriving down several feeds
// (run: npx tsx scripts/sanity-check-event-dedupe.mjs).
//
// The failure this guards against is not "a duplicate slipped through" — that is
// cosmetic. It is HIDING A MEETING THAT REALLY EXISTS, which is the one outcome
// worse than the bug being fixed. So most of what follows is negative cases:
// same title at a different time, one minute of difference, a shorter meeting
// inside a longer one. All must survive.

import { buildScheduleInputs } from "../src/lib/scheduling/from-db.ts";

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

const CONNS = [
  { id: "c1", label: "Work Gmail", color: "#4c8bf5", all_day_mode: null },
  { id: "c2", label: "Work Outlook", color: "#e0a94e", all_day_mode: null },
  { id: "c3", label: "Personal Life", color: "#2fb67c", all_day_mode: null },
];

let seq = 0;
const ev = (title, startsAt, endsAt, connectionId, source = "google") => ({
  id: `e${++seq}`,
  user_id: "u1",
  title,
  starts_at: startsAt,
  ends_at: endsAt,
  all_day: false,
  connection_id: connectionId,
  source,
  description: null,
  location: null,
  meeting_url: null,
  created_at: "2026-08-01T00:00:00Z",
  deleted_at: null,
});

/** Minimal rows: only what buildScheduleInputs needs to reach the event path. */
function rowsWith(events) {
  return {
    profile: {
      id: "u1",
      timezone: "America/New_York",
      weekly_hours: { 0: { start: 540, end: 1020 }, 1: { start: 540, end: 1020 }, 2: { start: 540, end: 1020 }, 3: { start: 540, end: 1020 }, 4: { start: 540, end: 1020 } },
    },
    categories: [],
    projects: [],
    targets: [],
    tasks: [],
    recurringRules: [],
    preferenceNotes: [],
    dayOverrides: [],
    events,
    progressLog: [],
    pinnedChunks: [],
    researchPins: [],
    calendarConnections: CONNS,
  };
}

const titles = (events) => {
  const { inputs } = buildScheduleInputs(rowsWith(events));
  return inputs.events.map((e) => `${e.title}@${e.start}-${e.end}${e.onCalendars ? `(x${e.onCalendars.length})` : ""}`);
};

// ---------------------------------------------------------------- the clone case

const A = "2026-08-19T16:00:00.000Z";
const AEnd = "2026-08-19T17:00:00.000Z";

check("one meeting on one calendar is untouched", titles([ev("Group meeting", A, AEnd, "c1")]), ["Group meeting@720-780"]);
check(
  "the identical meeting on two calendars collapses to one, marked x2",
  titles([ev("Group meeting", A, AEnd, "c1"), ev("Group meeting", A, AEnd, "c2")]),
  ["Group meeting@720-780(x2)"],
);
check(
  "four feeds collapse to one, marked x4",
  titles([
    ev("Group meeting", A, AEnd, "c1"),
    ev("Group meeting", A, AEnd, "c2"),
    ev("Group meeting", A, AEnd, "c3"),
    ev("Group meeting", A, AEnd, "c1"),
  ]),
  ["Group meeting@720-780(x4)"],
);
check(
  "casing and surrounding spaces don't defeat it",
  titles([ev("Group Meeting", A, AEnd, "c1"), ev("  group meeting ", A, AEnd, "c2")]),
  ["Group Meeting@720-780(x2)"],
);
check(
  "the labels of every calendar carrying it are kept",
  (() => {
    const { inputs } = buildScheduleInputs(rowsWith([ev("Group meeting", A, AEnd, "c1"), ev("Group meeting", A, AEnd, "c2")]));
    return inputs.events[0].onCalendars;
  })(),
  ["Work Gmail", "Work Outlook"],
);

// ------------------------------------------- MUST SURVIVE: really-different ones

check(
  "the same title at a different time is TWO meetings",
  titles([
    ev("Office hours", "2026-08-19T16:00:00.000Z", "2026-08-19T17:00:00.000Z", "c1"),
    ev("Office hours", "2026-08-19T18:00:00.000Z", "2026-08-19T19:00:00.000Z", "c1"),
  ]),
  ["Office hours@720-780", "Office hours@840-900"],
);
check(
  "back-to-back same-title slots both survive",
  titles([
    ev("1:1", "2026-08-19T16:00:00.000Z", "2026-08-19T16:30:00.000Z", "c1"),
    ev("1:1", "2026-08-19T16:30:00.000Z", "2026-08-19T17:00:00.000Z", "c1"),
  ]),
  ["1:1@720-750", "1:1@750-780"],
);
// One minute of disagreement between feeds is NOT collapsed, on purpose: the
// alternative is a rule that can silently drop a real meeting.
check(
  "a one-minute difference in start survives as two",
  titles([
    ev("Group meeting", "2026-08-19T16:00:00.000Z", AEnd, "c1"),
    ev("Group meeting", "2026-08-19T16:01:00.000Z", AEnd, "c2"),
  ]),
  ["Group meeting@720-780", "Group meeting@721-780"],
);
check(
  "a different END survives as two",
  titles([ev("Group meeting", A, AEnd, "c1"), ev("Group meeting", A, "2026-08-19T17:30:00.000Z", "c2")]),
  ["Group meeting@720-780", "Group meeting@720-810"],
);
check(
  "a shorter meeting inside a longer one survives",
  titles([
    ev("Workshop", "2026-08-19T16:00:00.000Z", "2026-08-19T20:00:00.000Z", "c1"),
    ev("Workshop", "2026-08-19T17:00:00.000Z", "2026-08-19T18:00:00.000Z", "c2"),
  ]),
  ["Workshop@720-960", "Workshop@780-840"],
);
check(
  "same time, different titles both survive",
  titles([ev("Standup", A, AEnd, "c1"), ev("Retro", A, AEnd, "c2")]),
  ["Standup@720-780", "Retro@720-780"],
);
check(
  "the same title on the same weekday a week apart survives",
  titles([
    ev("Group meeting", "2026-08-19T16:00:00.000Z", "2026-08-19T17:00:00.000Z", "c1"),
    ev("Group meeting", "2026-08-26T16:00:00.000Z", "2026-08-26T17:00:00.000Z", "c1"),
  ]).length,
  2,
);

// ------------------------------------------- the app's own copy wins the tie-break

check(
  "an event made in this app survives over a synced mirror, so it stays editable",
  (() => {
    const synced = ev("Thesis defence", A, AEnd, "c1");
    const mine = ev("Thesis defence", A, AEnd, null, "manual");
    const { inputs } = buildScheduleInputs(rowsWith([synced, mine]));
    return [inputs.events.length, inputs.events[0].id === mine.id, inputs.events[0].source];
  })(),
  [1, true, "manual"],
);
check(
  "the same holds when the app's copy came first",
  (() => {
    const mine = ev("Thesis defence", A, AEnd, null, "manual");
    const synced = ev("Thesis defence", A, AEnd, "c1");
    const { inputs } = buildScheduleInputs(rowsWith([mine, synced]));
    return [inputs.events.length, inputs.events[0].id === mine.id];
  })(),
  [1, true],
);
check(
  "and it still reports both calendars",
  (() => {
    const { inputs } = buildScheduleInputs(
      rowsWith([ev("Thesis defence", A, AEnd, "c1"), ev("Thesis defence", A, AEnd, null, "manual")]),
    );
    return inputs.events[0].onCalendars;
  })(),
  ["Work Gmail", "this app"],
);

// A single meeting must NOT carry the marker — it would appear on nearly every
// event and mean nothing.
check(
  "a lone meeting carries no marker at all",
  (() => {
    const { inputs } = buildScheduleInputs(rowsWith([ev("Group meeting", A, AEnd, "c1")]));
    return inputs.events[0].onCalendars ?? "absent";
  })(),
  "absent",
);

console.log(`\n${checks - failures}/${checks} event-dedupe checks passed`);
process.exit(failures ? 1 : 0);
