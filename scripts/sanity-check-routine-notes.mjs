// Sanity check for routine notes and hand-ordering
// (run: npx tsx scripts/sanity-check-routine-notes.mjs).
//
// Two features, one file, because they share the property that makes them worth
// checking without a browser: both are pure arithmetic over dates and indices,
// and both fail SILENTLY when they fail. A note with a window that never covers
// a day the routine runs simply never appears, and a reorder that assigns
// colliding indices looks fine until the next reload — neither throws, so nothing
// but a check like this notices.
//
// The date cases are all pinned to a known Wednesday so "next week" has one
// correct answer. 2026-08-12 is a Wednesday.

import {
  parseDateWindow,
} from "../src/lib/assistant/nlp-dates.ts";
import {
  describeWindow,
  hasExpired,
  isActiveOn,
  nextWeekWindow,
  validateNote,
  windowFromText,
  activeNotesForPrompt,
} from "../src/lib/planner/routine-notes.ts";
import {
  moveWithin,
  changedSortOrders,
  nextSortOrder,
  dragId,
  parseDragId,
} from "../src/lib/planner/reorder.ts";

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

/** Wednesday 12 August 2026. Its week is Mon 10 – Sun 16. */
const WED = new Date(2026, 7, 12);
const key = (w) => (w ? [w.startsOn, w.endsOn] : null);

// ------------------------------------------------------------------- the window

check("next week is Mon-Sun of the following week", key(windowFromText("next week", WED)), ["2026-08-17", "2026-08-23"]);
check("the phrasings of next week agree", [
  key(windowFromText("the coming week", WED)),
  key(windowFromText("the following week", WED)),
], [
  ["2026-08-17", "2026-08-23"],
  ["2026-08-17", "2026-08-23"],
]);
// Starts TODAY, not on the Monday already gone: a window is about days still to
// come, and back-dating it to Monday would make the note look overdue.
check("this week starts today and ends Sunday", key(windowFromText("this week", WED)), ["2026-08-12", "2026-08-16"]);
check("rest of the week is the same window", key(windowFromText("the rest of the week", WED)), ["2026-08-12", "2026-08-16"]);
check("a bare weekday is one day", key(windowFromText("friday", WED)), ["2026-08-14", "2026-08-14"]);
check("next friday is the week after", key(windowFromText("next friday", WED)), ["2026-08-21", "2026-08-21"]);
check("tomorrow is one day", key(windowFromText("tomorrow", WED)), ["2026-08-13", "2026-08-13"]);
check("a month and day is one day", key(windowFromText("August 20", WED)), ["2026-08-20", "2026-08-20"]);
check("week of a date widens to that whole week", key(windowFromText("the week of Aug 17", WED)), ["2026-08-17", "2026-08-23"]);
check("week beginning is the same phrase", key(windowFromText("week beginning august 24", WED)), ["2026-08-24", "2026-08-30"]);
// Inclusive of today, so 3 weeks is 21 days and not 22.
check("the next 3 weeks is 21 days from today", key(windowFromText("the next 3 weeks", WED)), ["2026-08-12", "2026-09-01"]);
check("the next 2 days is 2 days", key(windowFromText("the next 2 days", WED)), ["2026-08-12", "2026-08-13"]);
check("next month is the whole of it", key(windowFromText("next month", WED)), ["2026-09-01", "2026-09-30"]);
check("rest of the month runs to month end", key(windowFromText("the rest of the month", WED)), ["2026-08-12", "2026-08-31"]);
check("gibberish parses to nothing", windowFromText("whenever I get round to it", WED), null);
check("nextWeekWindow agrees with the parser", key(nextWeekWindow(WED)), key(windowFromText("next week", WED)));
// A Sunday is the END of its week here, not the start of the next one — the
// off-by-one that would make every Sunday-written note land a week early.
check("asked on a Sunday, next week is still the next Mon-Sun", key(windowFromText("next week", new Date(2026, 7, 16))), [
  "2026-08-17",
  "2026-08-23",
]);
check("asked on a Monday, this week starts that same Monday", key(windowFromText("this week", new Date(2026, 7, 10))), [
  "2026-08-10",
  "2026-08-16",
]);
check("the range parser also handles a bare ISO date", key(windowFromText("2026-09-03", WED)), ["2026-09-03", "2026-09-03"]);
check("parseDateWindow returns Dates, not keys", [
  parseDateWindow("tomorrow", WED).start instanceof Date,
  parseDateWindow("tomorrow", WED).end instanceof Date,
], [true, true]);

// -------------------------------------------------------------- speaking or not

const nextWeek = { starts_on: "2026-08-17", ends_on: "2026-08-23" };
check("a next-week note is silent today", isActiveOn(nextWeek, "2026-08-12"), false);
check("it speaks on its first day", isActiveOn(nextWeek, "2026-08-17"), true);
check("it speaks on its last day", isActiveOn(nextWeek, "2026-08-23"), true);
check("it is not expired before it starts", hasExpired(nextWeek, "2026-08-12"), false);
check("it is not expired on its last day", hasExpired(nextWeek, "2026-08-23"), false);
check("it is expired the day after", hasExpired(nextWeek, "2026-08-24"), true);

// ------------------------------------------------------------------ reading back

check("a next-week window reads as next week", describeWindow(nextWeek, WED), "next week (Aug 17–Aug 23)");
check("today reads as today", describeWindow({ starts_on: "2026-08-12", ends_on: "2026-08-12" }, WED), "today");
check("tomorrow reads as tomorrow", describeWindow({ starts_on: "2026-08-13", ends_on: "2026-08-13" }, WED), "tomorrow");
check("another single day reads as its date", describeWindow({ starts_on: "2026-08-20", ends_on: "2026-08-20" }, WED), "Aug 20");
check(
  "a this-week window reads as this week",
  describeWindow({ starts_on: "2026-08-12", ends_on: "2026-08-16" }, WED),
  "this week (through Aug 16)",
);
check(
  "a long running window says where it ends",
  describeWindow({ starts_on: "2026-08-10", ends_on: "2026-09-30" }, WED),
  "through Sep 30",
);
check(
  "a future multi-day window gives both ends",
  describeWindow({ starts_on: "2026-09-07", ends_on: "2026-09-11" }, WED),
  "Sep 7–Sep 11",
);

// -------------------------------------------------------------------- validation

const win = { startsOn: "2026-08-17", endsOn: "2026-08-23" };
check("a good note has no problems", validateNote({ body: "search foundation MHW grants", window: win }, WED), {
  errors: [],
  warnings: [],
});
check(
  "empty text is an error",
  validateNote({ body: "   ", window: win }, WED).errors.length,
  1,
);
check(
  "no window is an error, and the only one reported",
  validateNote({ body: "something", window: null }, WED).errors.length,
  1,
);
check(
  "a backwards window is an error",
  validateNote({ body: "x", window: { startsOn: "2026-08-23", endsOn: "2026-08-17" } }, WED).errors.length,
  1,
);
check(
  "a past window is a warning, not an error",
  (() => {
    const p = validateNote({ body: "x", window: { startsOn: "2026-08-01", endsOn: "2026-08-05" } }, WED);
    return [p.errors.length, p.warnings.length];
  })(),
  [0, 1],
);
check(
  "a window of months warns that it never goes quiet",
  validateNote({ body: "x", window: { startsOn: "2026-08-17", endsOn: "2027-08-17" } }, WED).warnings.length,
  1,
);

// -------------------------------------------------------- what reaches the prompt

const notes = [
  { id: "1", routine_id: "r1", body: "grants", starts_on: "2026-08-10", ends_on: "2026-08-16", done_at: null, created_at: "2026-08-01T00:00:00Z" },
  { id: "2", routine_id: "r1", body: "later", starts_on: "2026-08-17", ends_on: "2026-08-23", done_at: null, created_at: "2026-08-01T00:00:00Z" },
  { id: "3", routine_id: "r1", body: "ticked", starts_on: "2026-08-10", ends_on: "2026-08-16", done_at: "2026-08-11T00:00:00Z", created_at: "2026-08-01T00:00:00Z" },
  { id: "4", routine_id: "r2", body: "other routine", starts_on: "2026-08-10", ends_on: "2026-08-16", done_at: null, created_at: "2026-08-01T00:00:00Z" },
];
check("only the current, un-ticked note for that routine goes to the prompt", activeNotesForPrompt(notes, "r1", "2026-08-12"), ["grants"]);
check("the other routine gets its own", activeNotesForPrompt(notes, "r2", "2026-08-12"), ["other routine"]);
check("next week, the current one has dropped out and the next is in", activeNotesForPrompt(notes, "r1", "2026-08-18"), ["later"]);
check("a routine with nothing noted contributes nothing", activeNotesForPrompt(notes, "r3", "2026-08-12"), []);
check("after both windows close, nothing is sent", activeNotesForPrompt(notes, "r1", "2026-09-01"), []);

// ------------------------------------------------------------------- hand-ordering

const rows = [
  { id: "a", sort_order: 0 },
  { id: "b", sort_order: 1 },
  { id: "c", sort_order: 2 },
  { id: "d", sort_order: 3 },
];
check("dragging down lands at the target's index", moveWithin(rows, "a", "c").map((r) => r.id), ["b", "c", "a", "d"]);
check("dragging up lands at the target's index", moveWithin(rows, "d", "b").map((r) => r.id), ["a", "d", "b", "c"]);
check("dropping on itself is a no-op", moveWithin(rows, "a", "a"), null);
check("an id from another group is refused", moveWithin(rows, "a", "zz"), null);
check("moving to the top works", moveWithin(rows, "c", "a").map((r) => r.id), ["c", "a", "b", "d"]);
check("moving to the bottom works", moveWithin(rows, "a", "d").map((r) => r.id), ["b", "c", "d", "a"]);

check(
  "only the rows that actually shifted are written",
  changedSortOrders(moveWithin(rows, "a", "c")),
  [
    { id: "b", sort_order: 0 },
    { id: "c", sort_order: 1 },
    { id: "a", sort_order: 2 },
  ],
);
// The state every existing row is in today: all zero, so the first reorder has to
// write the whole group rather than deciding nothing changed.
const allZero = [
  { id: "a", sort_order: 0 },
  { id: "b", sort_order: 0 },
  { id: "c", sort_order: 0 },
];
check("a never-ordered group gets every row written on the first drag", changedSortOrders(allZero).length, 2);
check("an already-correct order writes nothing", changedSortOrders(rows), []);

check("a new row goes after everything", nextSortOrder(rows), 4);
check("the first row in an empty group is 0", nextSortOrder([]), 0);
check("gaps don't produce a collision", nextSortOrder([{ sort_order: 0 }, { sort_order: 9 }]), 10);

check("ids round-trip through the kind prefix", parseDragId(dragId("item", "abc-123")), { kind: "item", id: "abc-123" });
check("a list id round-trips", parseDragId(dragId("list", "abc-123")), { kind: "list", id: "abc-123" });
// UUIDs contain no colon, but the id is sliced at the FIRST one regardless, so a
// colon in an id could never split the wrong way.
check("only the first colon splits", parseDragId("item:a:b"), { kind: "item", id: "a:b" });
check("an unprefixed id is rejected", parseDragId("abc-123"), null);
check("an unknown kind is rejected", parseDragId("task:abc"), null);

console.log(`\n${checks - failures}/${checks} routine-note and ordering checks passed`);
process.exit(failures ? 1 : 0);
