// Sanity check for the routines form (run: npx tsx scripts/sanity-check-routine-form.mjs).
//
// The interesting parts are the round trip through the two window columns — a
// fixed time and a one-length-wide window are the SAME row, so reading one back
// has to infer the same shape the chat tool would write — and the length-vs-window
// arithmetic, which is the only way to store a routine that can never be placed.

import {
  parseTimeOfDay,
  timeOfDayValue,
  describeDays,
  describeRoutine,
  validateRoutine,
  routineRow,
  routineDraft,
} from "../src/lib/planner/routine-form.ts";

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

// ------------------------------------------------------------------ time input

check("a time input becomes minutes", parseTimeOfDay("13:00"), 780);
check("leading zeros and single digits both parse", [parseTimeOfDay("09:05"), parseTimeOfDay("9:05")], [545, 545]);
check("empty is not a time", parseTimeOfDay(""), null);
check("a 25th hour is refused", parseTimeOfDay("25:00"), null);
check("a 60th minute is refused", parseTimeOfDay("10:60"), null);
check("minutes back to an input value", [timeOfDayValue(780), timeOfDayValue(545), timeOfDayValue(null)], [
  "13:00",
  "09:05",
  "",
]);

// ----------------------------------------------------------------- day wording

check("all five weekdays read as a range", describeDays([0, 1, 2, 3, 4]), "Mon–Fri");
check("three consecutive days read as a range", describeDays([1, 2, 3]), "Tue–Thu");
check("two days are just listed", describeDays([0, 4]), "Mon, Fri");
check("gaps are listed", describeDays([0, 2, 4]), "Mon, Wed, Fri");
check("out of order is sorted", describeDays([4, 0, 2]), "Mon, Wed, Fri");
check("weekend days are dropped — the engine never places them", describeDays([0, 5, 6]), "Mon");
check("no days says so rather than showing blank", describeDays([]), "no days");

// -------------------------------------------------------------- line the list shows

check(
  "wherever it fits",
  describeRoutine({ days: [0, 1, 2, 3, 4], length_min: 30, win_start_min: null, win_end_min: null }),
  "30m · Mon–Fri · wherever it fits",
);
check(
  "a fixed time — window exactly one length wide",
  describeRoutine({ days: [0, 1, 2, 3, 4], length_min: 60, win_start_min: 720, win_end_min: 780 }),
  "1h · Mon–Fri · at 12pm",
);
check(
  "a real window says both ends",
  describeRoutine({ days: [0], length_min: 30, win_start_min: 780, win_end_min: 1020 }),
  "30m · Mon · between 1pm and 5pm",
);
check(
  "a length that isn't whole hours stays in minutes",
  describeRoutine({ days: [2], length_min: 90, win_start_min: null, win_end_min: null }),
  "90m · Wed · wherever it fits",
);
check(
  "half past reads as half past",
  describeRoutine({ days: [2], length_min: 30, win_start_min: 570, win_end_min: 600 }),
  "30m · Wed · at 9:30am",
);

// -------------------------------------------------------------------- validation

const draft = (over = {}) => ({
  title: "Emails",
  days: [0, 1, 2, 3, 4],
  lengthText: "30",
  placement: "anywhere",
  startText: "",
  endText: "",
  categoryId: "",
  ...over,
});

check("a clean routine has nothing to say", validateRoutine(draft()), { errors: [], warnings: [] });
check("a nameless routine is blocked", validateRoutine(draft({ title: " " })).errors.length, 1);
check("no days is blocked — it would never appear", validateRoutine(draft({ days: [] })).errors, [
  "“Emails” happens on no days, so it would never appear.",
]);
check("no length is blocked", validateRoutine(draft({ lengthText: "" })).errors.length, 1);
check("a nonsense length is blocked", validateRoutine(draft({ lengthText: "a while" })).errors.length, 1);
check("zero minutes is blocked", validateRoutine(draft({ lengthText: "0" })).errors.length, 1);
check("longer than a day is blocked", validateRoutine(draft({ lengthText: "2000" })).errors.length, 1);

check(
  "a set time with no time is blocked, and says the alternative",
  validateRoutine(draft({ placement: "fixed" })).errors[0],
  "“Emails” needs a start time, or set it to go wherever it fits.",
);
check(
  "a window with no end is blocked",
  validateRoutine(draft({ placement: "window", startText: "13:00" })).errors.length,
  1,
);
check(
  "a window that ends before it starts is blocked",
  validateRoutine(draft({ placement: "window", startText: "13:00", endText: "12:00" })).errors[0],
  "“Emails” ends before it starts.",
);
check(
  "a window too narrow for the length is blocked, with both figures",
  validateRoutine(draft({ placement: "window", lengthText: "90", startText: "13:00", endText: "14:00" })).errors[0],
  "“Emails” is 90 minutes long but its window is only 60 — widen the window or shorten it.",
);
check(
  "a window exactly the length is fine",
  validateRoutine(draft({ placement: "window", lengthText: "60", startText: "13:00", endText: "14:00" })).errors,
  [],
);
check(
  "running past midnight is a warning, not a block",
  validateRoutine(draft({ placement: "fixed", lengthText: "120", startText: "23:00" })),
  {
    errors: [],
    warnings: ["“Emails” would run past midnight, so it will be dropped for want of room in the day."],
  },
);

// ------------------------------------------------------------------- the row

check("anywhere writes both columns null", routineRow(draft()), {
  title: "Emails",
  days: [0, 1, 2, 3, 4],
  length_min: 30,
  win_start_min: null,
  win_end_min: null,
  anchor: null,
  category_id: null,
});

// A label is optional and NO LABEL is the common answer — a standing email slot
// belongs to no weekly share. An empty string must become null rather than "".
check("no label is stored as null, not an empty string", routineRow(draft()).category_id, null);
check("a label is stored as given", routineRow(draft({ categoryId: "research-id" })).category_id, "research-id");
check(
  "a fixed time is stored as a window one length wide, as update_recurring does",
  routineRow(draft({ placement: "fixed", lengthText: "60", startText: "12:00" })),
  { title: "Emails", days: [0, 1, 2, 3, 4], length_min: 60, win_start_min: 720, win_end_min: 780, anchor: null, category_id: null },
);
check(
  "a window keeps both ends",
  routineRow(draft({ days: [0], placement: "window", startText: "13:00", endText: "17:00" })),
  { title: "Emails", days: [0], length_min: 30, win_start_min: 780, win_end_min: 1020, anchor: null, category_id: null },
);
check("a draft that doesn't validate writes nothing at all", routineRow(draft({ title: "" })), null);
check("the title is trimmed on the way in", routineRow(draft({ title: "  Emails  " }))?.title, "Emails");

// --------------------------------------------------------------- the round trip

const rows = [
  { id: "a", title: "Emails", days: [0, 1, 2, 3, 4], length_min: 30, win_start_min: null, win_end_min: null, anchor: null, category_id: null },
  { id: "b", title: "Lunch", days: [0, 1, 2, 3, 4], length_min: 60, win_start_min: 720, win_end_min: 780, anchor: null, category_id: null },
  { id: "c", title: "Lit scan", days: [0], length_min: 30, win_start_min: 780, win_end_min: 1020, anchor: null, category_id: "research-id" },
  { id: "d", title: "First thing", days: [0, 1, 2, 3, 4], length_min: 15, win_start_min: null, win_end_min: null, anchor: "day_start", category_id: null },
  { id: "e", title: "Wrap up", days: [4], length_min: 30, win_start_min: null, win_end_min: null, anchor: "day_end", category_id: null },
];
for (const row of rows) {
  const columns = { ...row };
  delete columns.id;
  check(`${row.title}: row -> draft -> row is identity`, routineRow(routineDraft(row)), columns);
}
check(
  "the shape is inferred, not stored",
  rows.map((r) => routineDraft(r).placement),
  ["anywhere", "fixed", "window", "day_start", "day_end"],
);
check(
  "a row the engine would ignore loses its weekend days on the way in",
  routineDraft({ id: "d", title: "x", days: [0, 6], length_min: 30, win_start_min: null, win_end_min: null }).days,
  [0],
);
check(
  "a row with no label round-trips to no label",
  routineDraft({ id: "e", title: "x", days: [0], length_min: 30, win_start_min: null, win_end_min: null }).categoryId,
  "",
);

// ------------------------------------------------------- anchored to a day end
//
// The invariant migration 0039 enforces in the database, checked here too: an
// anchored routine carries NO clock time. A row with both would be two answers
// to one question, and the insert would simply fail.

for (const anchor of ["day_start", "day_end"]) {
  const row = routineRow(draft({ placement: anchor, startText: "09:00", endText: "17:00" }));
  check(`${anchor}: stores the anchor`, row.anchor, anchor);
  check(`${anchor}: writes no window, even with times typed in`, [row.win_start_min, row.win_end_min], [null, null]);
  check(`${anchor}: needs no start time to validate`, validateRoutine(draft({ placement: anchor, startText: "" })).errors, []);
}

check(
  "an anchored routine longer than half a day is warned about, not rejected",
  validateRoutine(draft({ placement: "day_start", lengthText: "300" })).warnings.length,
  1,
);

check(
  "a day_start routine describes itself without naming a time",
  describeRoutine({ days: [0, 1, 2, 3, 4], length_min: 15, win_start_min: null, win_end_min: null, anchor: "day_start" }),
  "15m · Mon–Fri · first thing, when the day starts",
);
check(
  "a day_end routine says which end it holds",
  describeRoutine({ days: [4], length_min: 30, win_start_min: null, win_end_min: null, anchor: "day_end" }),
  "30m · Fri · last thing, before the day ends",
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
