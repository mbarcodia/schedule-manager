import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { queryScheduleRows } from "@/lib/scheduling/query-rows";
import { buildScheduleInputs } from "@/lib/scheduling/from-db";
import { computeSchedule } from "@/lib/scheduling/engine";

const env = Object.fromEntries(
  readFileSync(new URL("./.env.local", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SECRET_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const USER = "e595b66f-5244-4fb1-9ce3-d15dea306806";

const rows = await queryScheduleRows(admin as never, USER);
const { inputs } = buildScheduleInputs(rows as never);
const s = computeSchedule(inputs);

console.log("=== engine's own label targets, week 1 (next week) ===");
console.log(JSON.stringify(s.labelTargetsByWeek[1], null, 1));

console.log("\n=== blocks next week (gday 7-13) ===");
const next = s.blocks.filter((b) => b.gday >= 7 && b.gday < 14 && !b.allDay);
const byType: Record<string, number> = {};
for (const b of next) byType[b.type] = (byType[b.type] ?? 0) + (b.end - b.start);
console.log("minutes by type:", byType);
console.log("task blocks:", next.filter((b) => b.type === "task").map((b) => `${b.title} g${b.gday} ${b.start}-${b.end} cat=${b.categoryId ?? "—"}`));

console.log("\n=== commitments and their labels ===");
for (const p of inputs.projects) {
  console.log(`${p.title.padEnd(38)} weekly=${p.weeklyMinMin ?? "—"} cat=${p.categoryId ?? "—"} activeFrom=${p.activeFromAbs ?? "—"} activeUntil=${p.activeUntilAbs ?? "—"} timeOfDay=${p.timeOfDay ?? "—"} minChunk=${p.minChunk}`);
}
console.log("\noverflow:", s.overflow);
console.log("beyondHorizon:", s.beyondHorizon);
process.exit(0);
