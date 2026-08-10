// The task panel's arithmetic (run: npx tsx scripts/sanity-check-task-form.mjs).
//
// Every other form in lib/planner has had one of these since the parity pass;
// this one didn't, which is how three placement levers stayed panel-invisible
// long enough to be noticed only by auditing the chat tools against the panels.
//
// The cases worth pinning down are the DERIVED ones. A field the user never
// filled in must not come back looking like a choice they made — the same rule
// floor_at already follows ("a floor at or before now is the default add_task
// writes, not a decision"), now applying to the block length too.

import {
  blankTaskDraft,
  chunkFor,
  describeChunking,
  labelMinChunkClash,
  taskDraft,
  taskRowFields,
  validateTask,
} from "../src/lib/planner/task-form.ts";

const NOW = new Date(2026, 7, 7, 10, 0);
let failures = 0;
let checks = 0;
function check(label, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

const draft = (over = {}) => ({ ...blankTaskDraft(), title: "Read the reviews", ...over });

console.log("== the derived block length ==");
check("over 90 minutes goes in hour-long pieces", chunkFor(240), 60);
check("90 minutes exactly stays in one sitting", chunkFor(90), 90);
check("a short task is one block", chunkFor(45), 45);
check("an empty block field uses the derivation", taskRowFields(draft({ hoursText: "4" }), NOW).chunk_min, 60);
check("an explicit block length wins", taskRowFields(draft({ hoursText: "4", chunkText: "90" }), NOW).chunk_min, 90);

console.log("\n== the three placement levers ==");
check("no restriction is null, not a string", taskRowFields(draft(), NOW).time_of_day, null);
check("a restriction is stored as given", taskRowFields(draft({ timeOfDay: "morning" }), NOW).time_of_day, "morning");
check("an empty daily cap is null", taskRowFields(draft(), NOW).max_per_day_min, null);
check("a daily cap is minutes", taskRowFields(draft({ maxPerDayText: "45" }), NOW).max_per_day_min, 45);
check("a fractional cap is rounded, not rejected", taskRowFields(draft({ maxPerDayText: "44.6" }), NOW).max_per_day_min, 45);

console.log("\n== what won't schedule is refused up front ==");
check("a zero cap is refused", validateTask(draft({ maxPerDayText: "0" })).length, 1);
check("a negative block length is refused", validateTask(draft({ chunkText: "-30" })).length, 1);
check("words in a numeric field are refused", validateTask(draft({ maxPerDayText: "an hour" })).length, 1);
// Both of these were REFUSED here until the engine was read properly, which
// would have blocked saves the scheduler handles correctly. chunkLengthsToTry
// walks down from the preferred size and folds maxPerDayMin into the floor, so
// a cap below the block simply shortens the blocks; a block longer than the task
// is clamped to the task. They are described, not rejected.
check(
  "a daily cap smaller than the block is allowed",
  validateTask(draft({ hoursText: "4", chunkText: "90", maxPerDayText: "60" })),
  [],
);
check(
  "...and the panel says which one wins",
  describeChunking(draft({ hoursText: "4", chunkText: "90", maxPerDayText: "60" })),
  "The daily cap is shorter than the block, so blocks will be cut to 60 minutes — one a day.",
);
check("a block longer than the whole task is allowed", validateTask(draft({ hoursText: "1", chunkText: "90" })), []);
check(
  "...and is described as the one block it becomes",
  describeChunking(draft({ hoursText: "1", chunkText: "90" })),
  "That's longer than the whole task, so it will simply be booked in one 60-minute block.",
);
check(
  "a cap still applies to a block clamped to the task's length",
  describeChunking(draft({ hoursText: "1", chunkText: "90", maxPerDayText: "30" })),
  "That's longer than the whole task, so it's clamped to 60 minutes — and the daily cap cuts it further, to 30 minutes a day.",
);
check(
  "a cap under the DERIVED block length is described too",
  describeChunking(draft({ hoursText: "4", maxPerDayText: "30" })),
  "Shorter than this task's 60-minute default block, so blocks will be cut to 30 minutes.",
);
check("nothing surprising, nothing said", describeChunking(draft({ hoursText: "4", maxPerDayText: "120" })), null);
check("all three empty is the ordinary case", validateTask(draft()), []);
check("a draft that doesn't validate writes nothing", taskRowFields(draft({ maxPerDayText: "0" }), NOW), null);

console.log("\n== the round trip ==");
// Both dates are deliberately FAR future. taskDraft only shows a floor as a
// "not before" the user chose when it is still ahead of now (a floor at or
// before now is add_task's default, not a decision) — so a fixture dated a few
// days out silently changes meaning the moment the calendar passes it, which is
// exactly what happened to an earlier version of this check.
const row = {
  title: "Read the reviews",
  duration_min: 240,
  chunk_min: 90,
  priority: "high",
  deadline_at: new Date(2099, 1, 20, 23, 59).toISOString(),
  deadline_all_day: true,
  floor_at: new Date(2099, 0, 10, 0, 0).toISOString(),
  project_id: null,
  category_id: null,
  important: true,
  time_of_day: "afternoon",
  max_per_day_min: 60,
  // "free" here on purpose: this row carries a 60-minute daily cap on 4 hours of
  // work, which either hard split mode would contradict (and validateTask now
  // refuses). The modes get their own round trip below.
  split_mode: "free",
  min_chunk_min: 45,
};
const back = taskDraft(row);
check("the levers survive the trip", [back.timeOfDay, back.maxPerDayText, back.chunkText], ["afternoon", "60", "90"]);
check("and so does the minimum block", back.minChunkText, "45");
check("and write back to the same columns", taskRowFields(back, NOW), {
  ...row,
  // The panel stores a date-only deadline at the end of that day, which is what
  // the row already held.
  deadline_at: row.deadline_at,
});

// The important one: a block length nobody chose must not come back as though
// they had, or every edit silently freezes today's derivation into the row.
const derived = taskDraft({ ...row, chunk_min: chunkFor(240), time_of_day: null, max_per_day_min: null });
check("a derived block length reads as empty", derived.chunkText, "");
check("an unset lever reads as unset", [derived.timeOfDay, derived.maxPerDayText], ["", ""]);
check(
  "and re-saving it leaves the derivation in place",
  taskRowFields(derived, NOW).chunk_min,
  chunkFor(240),
);

// ---------------------------------------------------------- split modes (0042)

console.log("\n== how it's split ==");

const splitRow = { ...row, max_per_day_min: null, split_mode: "one_block", min_chunk_min: null };
const splitBack = taskDraft(splitRow);
check("a split mode survives the trip", splitBack.splitMode, "one_block");
check("an unset minimum reads as empty", splitBack.minChunkText, "");
check("and writes back unchanged", taskRowFields(splitBack, NOW).split_mode, "one_block");

// A row that predates the column reads as the default rather than as undefined,
// so an old task edited today doesn't acquire a constraint nobody asked for.
check("a row with no split_mode defaults to free", taskDraft({ ...row, split_mode: undefined }).splitMode, "free");

// The one genuinely impossible pair. Refused rather than described, because the
// engine's answer to it is to schedule nothing at all — silently.
const capped = { ...draft(), hoursText: "4", splitMode: "one_block", maxPerDayText: "60" };
check("one block under a smaller daily cap is refused", validateTask(capped).length > 0, true);
check("...and writes nothing", taskRowFields(capped, NOW), null);
const cappedDay = { ...draft(), hoursText: "4", splitMode: "one_day", maxPerDayText: "60" };
check("one day under a smaller daily cap is refused", validateTask(cappedDay).length > 0, true);
// The same cap that FITS is fine — the check is against the duration, not the
// mere presence of a cap, which is the easy way to get this wrong.
const roomy = { ...draft(), hoursText: "1", splitMode: "one_block", maxPerDayText: "120" };
check("a cap bigger than the task is allowed", validateTask(roomy).length, 0);

// The block length is moot in one sitting, and saying so is the whole job of
// describeChunking — leaving a stale 60 next to "all in one block" reads as a
// contradiction the user has to resolve.
check(
  "one block explains that the block length is ignored",
  /ignored/.test(describeChunking({ ...draft(), hoursText: "2", splitMode: "one_block", chunkText: "60" }) ?? ""),
  true,
);
check(
  "and says nothing when there's no block length to ignore",
  describeChunking({ ...draft(), hoursText: "2", splitMode: "one_block" }),
  null,
);

// ------------------------------------------------- the label override warning

console.log("\n== overriding a label's minimum ==");

const research = { id: "cat-1", name: "Research", minChunkMin: 60 };
const withLabel = (minChunkText) => ({ ...draft(), categoryId: "cat-1", minChunkText });

check("no minimum set, nothing to say", labelMinChunkClash(withLabel(""), research), null);
check("the same minimum is not a clash", labelMinChunkClash(withLabel("60"), research), null);
check("no label, nothing to clash with", labelMinChunkClash({ ...draft(), minChunkText: "30" }, null), null);
check(
  "a label with no minimum has nothing to override",
  labelMinChunkClash(withLabel("30"), { id: "cat-2", name: "Teaching", minChunkMin: null }),
  null,
);

const loosened = labelMinChunkClash(withLabel("45"), research);
check("going below the label's floor is flagged", loosened?.loosens, true);
check("...and names both figures", /Research.*60.*45/s.test(loosened?.text ?? ""), true);

const tightened = labelMinChunkClash(withLabel("90"), research);
check("going above it is reported too", tightened?.loosens, false);
check("...but as raising, not overriding", /raises/.test(tightened?.text ?? ""), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
