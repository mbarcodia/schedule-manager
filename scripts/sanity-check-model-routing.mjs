// Verifies the simple-turn model router (npx tsx scripts/sanity-check-model-routing.mjs).
// The asymmetry that matters: downgrading a turn that needed judgement costs
// answer quality, while missing a downgrade only costs tokens. So every
// ambiguous case must fall through to the user's chosen model.

import { pickTurnModel } from "../src/lib/planner/model-routing.ts";

const BIG = "claude-opus-4-8";
const SMALL = "claude-sonnet-5";

const downgrade = [
  "log 45 minutes on grading",
  "mark AgenAI BAMS done",
  "add a 2h task for syllabus prep",
  "move ACE2 to 3pm",
  "archive the dev app task",
  "delete the lunch block",
  "Set temp_thresh to 5h/week",
  "pin ACE2-S2S right now for an hour",
];

const keepBig = [
  // questions and judgement
  "what should I work on today?",
  "is this week realistic",
  "why is temp_thresh slipping",
  "compare the two proposal deadlines",
  "help me plan the fall semester",
  "review my week",
  "time to plan",
  "should I drop the ROSES proposal",
  "explain how the research hours work",
  "add a task — actually, what do you think I should prioritize first?",
  // multi-sentence / long
  "add a task for grading. Also move my emails block to the afternoon.",
  "add a 3h task for the ACE2 revision due next Friday, then rebalance the rest of the week around it so nothing else slips past its deadline",
  // not an imperative edit at all
  "I'm going to work on ACE2-S2S now",
  "thanks!",
];

let failed = 0;
for (const msg of downgrade) {
  const got = pickTurnModel(msg, BIG);
  const ok = got === SMALL;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} downgrades: ${JSON.stringify(msg)}${ok ? "" : ` → ${got}`}`);
}
for (const msg of keepBig) {
  const got = pickTurnModel(msg, BIG);
  const ok = got === BIG;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} keeps big model: ${JSON.stringify(msg)}${ok ? "" : ` → ${got}`}`);
}

// Never upgrade someone who deliberately chose a cheaper model.
for (const preferred of [SMALL, "claude-haiku-4-5"]) {
  const got = pickTurnModel("what should I work on today?", preferred);
  const ok = got === preferred;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} never upgrades ${preferred}${ok ? "" : ` → ${got}`}`);
}

process.exit(failed ? 1 : 0);
