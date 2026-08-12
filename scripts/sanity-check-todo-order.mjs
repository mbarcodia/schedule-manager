// Sanity check for how a to-do list orders itself
// (run: npx tsx scripts/sanity-check-todo-order.mjs).
//
// Worth checking without a browser because the by-date rule is a MIXED one — a
// nulls-last date sort followed by a hand-arranged sort — and both halves fail
// quietly. Get the nulls wrong and dated items vanish below undated ones; get the
// group wrong and a drag renumbers rows whose order belongs to their dates.
//
// The other invariant here: sortTodoItems must not mutate its input. Callers hold
// these arrays in React state, and sorting in place is the kind of thing that
// works until a re-render.

import {
  sortTodoItems,
  canDragTodo,
  reorderableGroup,
  describeSortMode,
  TODO_SORT_MODES,
} from "../src/lib/planner/todo-order.ts";

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

const item = (text, due_at, sort_order = 0, created_at = "2026-08-01T00:00:00Z") => ({
  id: text,
  text,
  due_at,
  sort_order,
  created_at,
});
const names = (rows) => rows.map((r) => r.text);

// The real case this came from: npj climate is due Aug 14, AIES Aug 26, both with
// sort_order 0, and AIES was created first — so creation order put the LATER
// deadline on top.
const REVIEWS = [
  item("AIES Lessons Learned", "2026-08-27T03:59:00+00:00", 0, "2026-08-04T19:39:32Z"),
  item("npj climate", "2026-08-15T03:59:00+00:00", 0, "2026-08-04T22:47:07Z"),
];

check("manual order keeps creation order when sort_order ties", names(sortTodoItems(REVIEWS, "manual")), [
  "AIES Lessons Learned",
  "npj climate",
]);
check("by-date order puts the sooner deadline first", names(sortTodoItems(REVIEWS, "due")), [
  "npj climate",
  "AIES Lessons Learned",
]);

// ------------------------------------------------------------------ nulls go last

const MIXED = [
  item("no date A", null, 1),
  item("due late", "2026-09-01T00:00:00Z", 0),
  item("no date B", null, 0),
  item("due soon", "2026-08-14T00:00:00Z", 0),
];
check("dated first by date, then undated in their arranged order", names(sortTodoItems(MIXED, "due")), [
  "due soon",
  "due late",
  "no date B",
  "no date A",
]);
check("with no dates at all it is just the manual order", names(sortTodoItems([item("b", null, 1), item("a", null, 0)], "due")), [
  "a",
  "b",
]);
check(
  "every item dated means no undated tail",
  names(sortTodoItems([item("late", "2026-09-01T00:00:00Z"), item("soon", "2026-08-01T00:00:00Z")], "due")),
  ["soon", "late"],
);

// A timed item and an all-day item on the SAME date: all-day stores the end of
// the day, so it sorts second. "Any time on the 14th" really is a later
// commitment than "2pm on the 14th".
check(
  "same date, a timed item comes before an all-day one",
  names(
    sortTodoItems(
      [item("all day on the 14th", "2026-08-15T03:59:00+00:00"), item("2pm on the 14th", "2026-08-14T18:00:00+00:00")],
      "due",
    ),
  ),
  ["2pm on the 14th", "all day on the 14th"],
);
check(
  "identical dates fall back to the arranged order",
  names(
    sortTodoItems([item("second", "2026-08-14T00:00:00Z", 1), item("first", "2026-08-14T00:00:00Z", 0)], "due"),
  ),
  ["first", "second"],
);

// ------------------------------------------------------------- input is untouched

check(
  "sorting does not mutate the array it was given",
  (() => {
    const rows = [item("b", "2026-09-01T00:00:00Z"), item("a", "2026-08-01T00:00:00Z")];
    sortTodoItems(rows, "due");
    return names(rows);
  })(),
  ["b", "a"],
);

// ------------------------------------------------------------------ what can drag

check("everything drags on a manual list", [canDragTodo(item("x", null), "manual"), canDragTodo(item("y", "2026-08-14T00:00:00Z"), "manual")], [true, true]);
check("on a by-date list only the undated drag", [canDragTodo(item("x", null), "due"), canDragTodo(item("y", "2026-08-14T00:00:00Z"), "due")], [true, false]);

check(
  "a manual list's reorder group is the whole list",
  names(reorderableGroup(MIXED, "manual")),
  ["due late", "no date B", "due soon", "no date A"],
);
// The important one: a drag on a by-date list must not be able to touch a dated
// row, so they are not even in the group handed to the reorder.
check("a by-date list's reorder group is the undated tail only", names(reorderableGroup(MIXED, "due")), [
  "no date B",
  "no date A",
]);
check("an all-dated by-date list has nothing to reorder", reorderableGroup(REVIEWS, "due").length, 0);

// ----------------------------------------------------------------------- wording

check("both modes are offered", TODO_SORT_MODES.map((m) => m.id), ["manual", "due"]);
check("each mode reads as a sentence about order", [describeSortMode("manual"), describeSortMode("due")], [
  "in the order I arrange them",
  "by due date, soonest first",
]);

console.log(`\n${checks - failures}/${checks} to-do ordering checks passed`);
process.exit(failures ? 1 : 0);
