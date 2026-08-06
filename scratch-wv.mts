import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { queryScheduleRows } from "@/lib/scheduling/query-rows";
import { buildScheduleInputs } from "@/lib/scheduling/from-db";
import { computeSchedule } from "@/lib/scheduling/engine";
import { fetchProgressFacts } from "@/lib/scheduling/logged-hours";
import { buildWeekReview } from "@/lib/scheduling/week-review";
import { startOfWeekMonday } from "@/lib/scheduling/time";

const env = Object.fromEntries(
  readFileSync(new URL("./.env.local", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SECRET_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const USER = "e595b66f-5244-4fb1-9ce3-d15dea306806";
const rows = await queryScheduleRows(admin as never, USER);
const { inputs, projects, categories } = buildScheduleInputs(rows as never);
const schedule = computeSchedule(inputs);
const facts = await fetchProgressFacts(admin as never, USER);

const h = (m: number) => `${+(m / 60).toFixed(1)}h`;
for (const offset of [0, 1]) {
  const r = buildWeekReview({ schedule, projects, categories, weeklyHours: inputs.weeklyHours, dayOverrides: inputs.dayOverrides, allDayBlocks: inputs.allDayBlocks, logged: facts.logged, weekStart: startOfWeekMonday(), offset });
  console.log(`\n--- offset ${offset} ---`);
  console.log(`capacity ${h(r.capacityMin)} (usual ${h(r.standardCapacityMin)})  meetings ${h(r.meetingsMin)} (+${h(r.outOfHoursMeetingsMin)} out)  routines ${h(r.routinesMin)}  work ${h(r.workBookedMin)}  UNBOOKED ${h(r.freeMin)}`);
  for (const l of r.byLabel) console.log(`   ${l.label.padEnd(14)} target ${l.targetMin == null ? "—" : h(l.targetMin)}  booked ${h(l.bookedMin)}  done ${h(l.doneMin)}`);
}
process.exit(0);
