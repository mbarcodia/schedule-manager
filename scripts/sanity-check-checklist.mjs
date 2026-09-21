// A project's step-by-step breakdown, as a markdown checklist inside one note
// (run: npx tsx scripts/sanity-check-checklist.mjs).
//
// This is the mechanism that replaces decomposing a large project into
// separate scheduled tasks: the calendar shows one block under the project's
// own name (already true of weekly_min_min — see sanity-check-label-share.mjs
// for that half), and the steps live as `- [ ]`/`- [x]` lines in one note.
// What has to hold here is narrower but just as load-bearing: toggling or
// appending one item must never disturb any other line — a checklist that
// occasionally reorders or renames its OTHER items when you check one box
// would be worse than not having one.

import {
  appendChecklistItem,
  findChecklistItem,
  parseChecklist,
  toggleChecklistLine,
} from "../src/lib/planner/checklist.ts";

let failures = 0;
let checks = 0;
function check(label, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

console.log("== parsing ==");
const CONTENT = "- [ ] identify stakeholders\n- [x] draft outline\n- [ ] circulate for comment";
check("every line is picked up, in order", parseChecklist(CONTENT).map((i) => i.text), [
  "identify stakeholders",
  "draft outline",
  "circulate for comment",
]);
check("checked state is read per line", parseChecklist(CONTENT).map((i) => i.checked), [false, true, false]);
check("line numbers are 0-indexed positions in the content", parseChecklist(CONTENT).map((i) => i.line), [0, 1, 2]);

check("a non-checklist line is skipped, not misread as an item", parseChecklist("Some preamble.\n- [ ] a step").length, 1);
check("blank lines are skipped", parseChecklist("- [ ] a\n\n- [ ] b").length, 2);
check("empty content is an empty list, not an error", parseChecklist(""), []);
check("uppercase X still counts as checked", parseChecklist("- [X] done").map((i) => i.checked), [true]);
check("indentation is preserved in the item, not stripped from the marker", parseChecklist("  - [ ] indented").length, 1);

console.log("\n== toggling one line leaves every other line untouched ==");
const toggled = toggleChecklistLine(CONTENT, 0, true);
check("the target line flips", parseChecklist(toggled)[0].checked, true);
check("the other lines are byte-identical", parseChecklist(toggled).slice(1), parseChecklist(CONTENT).slice(1));
check("unchecking works the same way", parseChecklist(toggleChecklistLine(CONTENT, 1, false))[1].checked, false);
check(
  "toggling to its own current state is a no-op, not an error",
  toggleChecklistLine(CONTENT, 1, true),
  CONTENT,
);
check("a line index past the end returns the content unchanged", toggleChecklistLine(CONTENT, 99, true), CONTENT);
check("a non-checklist line at that index is left alone", toggleChecklistLine("just text", 0, true), "just text");

console.log("\n== appending ==");
check(
  "a new item lands unchecked, after the existing ones",
  parseChecklist(appendChecklistItem(CONTENT, "send to co-PI")).map((i) => `${i.checked}:${i.text}`),
  ["false:identify stakeholders", "true:draft outline", "false:circulate for comment", "false:send to co-PI"],
);
check("appending to empty content starts clean, no leading blank line", appendChecklistItem("", "first step"), "- [ ] first step");
check(
  "appending never touches an existing item's checked state",
  parseChecklist(appendChecklistItem(CONTENT, "new")).slice(0, 3).map((i) => i.checked),
  [false, true, false],
);

console.log("\n== finding an item by fuzzy text ==");
const items = parseChecklist(CONTENT);
check("a substring match resolves", findChecklistItem(items, "outline").match?.text, "draft outline");
check("an exact match wins over a looser substring hit elsewhere", findChecklistItem(items, "draft outline").match?.text, "draft outline");
check("no match is null, not a guess", findChecklistItem(items, "something else entirely"), { match: null, ambiguous: [] });
check(
  "two items matching the same loose needle are reported as ambiguous, not guessed",
  findChecklistItem([{ line: 0, checked: false, text: "call the reviewer" }, { line: 1, checked: false, text: "email the reviewer" }], "reviewer")
    .ambiguous.length,
  2,
);

console.log(`\n${checks - failures}/${checks} checklist checks passed`);
if (failures) process.exit(1);
