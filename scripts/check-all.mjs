// Runs every sanity check, and fails if any of them do
// (run: npm run check).
//
// Written after finding seven of them had been crashing for two days: each is a
// separate `npx tsx` invocation, so a broken one is invisible unless somebody
// happens to run that file. A whole class of checks going quiet is exactly the
// failure this repo can't afford, since they are the only thing standing behind
// the scheduling engine.
//
// Exit codes are the contract — every check script already ends in
// `process.exit(failures ? 1 : 0)`.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const scripts = readdirSync(new URL(".", import.meta.url))
  .filter((f) => f.startsWith("sanity-check-") && f.endsWith(".mjs"))
  .sort();

let failed = 0;
for (const file of scripts) {
  const run = spawnSync("npx", ["tsx", `scripts/${file}`], { encoding: "utf8" });
  const ok = run.status === 0;
  if (!ok) failed++;
  const lastLine = (run.stdout || run.stderr || "").trim().split("\n").pop() ?? "";
  console.log(`${ok ? "ok  " : "FAIL"}  ${file.padEnd(42)} ${ok ? lastLine : ""}`);
  if (!ok) {
    // The whole point is that a crash is loud, so print enough to act on.
    console.log((run.stdout || "").trim().split("\n").slice(-6).join("\n"));
    console.log((run.stderr || "").trim().split("\n").slice(0, 8).join("\n"));
  }
}

console.log(`\n${scripts.length - failed}/${scripts.length} check scripts passed`);
process.exit(failed ? 1 : 0);
