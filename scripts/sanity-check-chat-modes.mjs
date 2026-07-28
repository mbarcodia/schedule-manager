// Verifies the two chat modes (npx tsx scripts/sanity-check-chat-modes.mjs).
// The risk being guarded: a planning turn silently downgraded to a small model,
// or the two modes shipping the same behavioural contract.

import { CHAT_MODES, DEFAULT_CHAT_MODE, isChatMode, modeInstruction } from "../src/lib/planner/modes.ts";
import { pickTurnModel } from "../src/lib/planner/model-routing.ts";

const BIG = "claude-opus-4-8";
const quick = modeInstruction("quick");
const planning = modeInstruction("planning");

const checks = [
  ["default mode is quick", DEFAULT_CHAT_MODE === "quick", DEFAULT_CHAT_MODE],
  ["mode guard accepts both", isChatMode("quick") && isChatMode("planning"), "ok"],
  ["mode guard rejects junk", !isChatMode("PLANNING") && !isChatMode(undefined), "ok"],
  ["planning offers starter prompts", CHAT_MODES.planning.starters.length >= 4, String(CHAT_MODES.planning.starters.length)],
  ["quick offers none (a one-liner needs no scaffolding)", CHAT_MODES.quick.starters.length === 0, String(CHAT_MODES.quick.starters.length)],
  ["the two contracts genuinely differ", quick !== planning, "identical!"],
  ["quick forbids interviews", /do not open an interview/i.test(quick), quick.slice(0, 40)],
  ["planning mandates asking first", /ask/i.test(planning) && /wait for answers/i.test(planning), planning.slice(0, 40)],
  ["planning names the board-filling tools", /add_trackable/.test(planning) && /remember_rule/.test(planning), "missing tools"],
  // The load-bearing one: planning must keep the user's chosen model.
  ["planning never downgrades a short imperative", pickTurnModel("add a task for grading", BIG, "planning") === BIG, pickTurnModel("add a task for grading", BIG, "planning")],
  ["quick still downgrades that same message", pickTurnModel("add a task for grading", BIG, "quick") === "claude-sonnet-5", pickTurnModel("add a task for grading", BIG, "quick")],
  ["omitting mode behaves as quick (back-compat)", pickTurnModel("add a task for grading", BIG) === "claude-sonnet-5", pickTurnModel("add a task for grading", BIG)],
];

let failed = 0;
for (const [label, ok, got] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` — got ${got}`}`);
}
process.exit(failed ? 1 : 0);
