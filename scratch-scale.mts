import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { queryScheduleRows } from "@/lib/scheduling/query-rows";
import { buildScheduleInputs } from "@/lib/scheduling/from-db";
import { scaledWeeklyMin } from "@/lib/scheduling/engine";

const env = Object.fromEntries(
  readFileSync(new URL("./.env.local", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SECRET_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const rows = await queryScheduleRows(admin as never, "e595b66f-5244-4fb1-9ce3-d15dea306806");
const { inputs } = buildScheduleInputs(rows as never);

const CAPACITY = 2220, PCT = 40;
const target = Math.round((CAPACITY * PCT) / 100);
const declared = inputs.projects.filter((p) => p.weeklyMinMin).reduce((s, p) => s + (p.weeklyMinMin ?? 0), 0);
const scale = target / declared;
console.log(`capacity ${CAPACITY}  target ${target}  declared total ${declared}  scale ${scale.toFixed(4)}\n`);

let sum = 0;
for (const p of inputs.projects) {
  if (!p.weeklyMinMin) continue;
  const raw = p.weeklyMinMin * scale;
  const got = scaledWeeklyMin(p.weeklyMinMin, scale, p.chunk || 120, p.minChunk ?? 30);
  sum += got;
  console.log(`${p.title.padEnd(38)} declared ${String(p.weeklyMinMin).padStart(4)}  raw ${raw.toFixed(1).padStart(7)}  -> ${String(got).padStart(4)}  (lost ${(raw - got).toFixed(1)})`);
}
console.log(`\nsum of scaled goals: ${sum}   label target: ${target}   shortfall: ${target - sum}`);
process.exit(0);
