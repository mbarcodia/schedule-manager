// The two guards that stop work from being scheduled into a silent hole
// (run: npx tsx scripts/sanity-check-undated-task-guard.mjs).
//
// Both come from one real incident. "AIES Lessons Learned" was a review due
// Aug 26, recorded as a dated to-do on the Reviews list — and separately as a
// bare, undated task, which is the object the engine actually schedules. Two
// failures compounded:
//
//   AN UNDATED TASK IS DANGEROUS, NOT NEUTRAL. With no deadline it counts down
//   to nothing, so in a full week it loses every slot to dated work and is
//   never placed. It is not deleted and does not error — and having no due
//   date, it cannot appear on the will-miss-deadline list either. The drop is
//   invisible. Absence from that list is therefore NOT evidence of safety; an
//   undated task is missing from it precisely because it is undated.
//
//   A DATE ON A TO-DO DOES NOT PROTECT A SAME-NAMED TASK. They are separate
//   rows. The engine reads only the task's own due field. So the date existed,
//   just not on the object doing the scheduling.
//
// Neither guard blocks the write — both append a warning the model is
// instructed to act on (see system-prompt.ts). What must hold is that they
// fire exactly when the work is unprotected and stay SILENT when it is, since
// a warning on every task would be trained away within a week.
//
// This runs against a throwaway account and deletes it afterwards, the same
// way e2e-test.mjs does; it never touches real data.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { queryScheduleRows } from "../src/lib/scheduling/query-rows.ts";
import { buildScheduleInputs } from "../src/lib/scheduling/from-db.ts";
import { buildPlannerTools } from "../src/lib/planner/tools.ts";
import { zonedNow } from "../src/lib/scheduling/time.ts";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TZ = "America/New_York";
let failures = 0;
let checks = 0;
function check(label, actual, expected) {
  checks++;
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${actual}, want ${expected}`}`);
}

const UNDATED = "UNDATED:";
const TWIN = "TWO OBJECTS, ONE NAME:";

let userId;
try {
  const email = `guard-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password: `pw-${Math.random().toString(36).slice(2)}A1!`,
    email_confirm: true,
  });
  if (error) throw new Error(`could not create the test account: ${error.message}`);
  userId = created.user.id;

  await admin
    .from("profiles")
    .update({
      timezone: TZ,
      weekly_hours: Object.fromEntries(
        Array.from({ length: 7 }, (_, d) => [d, d < 5 ? { start: 540, end: 1020 } : null]),
      ),
    })
    .eq("id", userId);

  // The incident's exact shape: a dated to-do with no task attached to it.
  const { data: list } = await admin
    .from("todo_lists")
    .insert({ user_id: userId, name: "Reviews", sort_order: 0 })
    .select("id")
    .single();
  await admin.from("todo_items").insert({
    user_id: userId,
    list_id: list.id,
    text: "AIES Lessons Learned",
    sort_order: 0,
    due_at: "2026-08-27T03:59:00+00:00",
    due_all_day: true,
  });

  /** Tools rebuilt per call, since each write changes what the next one sees. */
  async function tool(name) {
    const rows = await queryScheduleRows(admin, userId);
    const { inputs } = buildScheduleInputs(rows);
    const z = zonedNow(TZ);
    const tools = buildPlannerTools({
      supabase: admin,
      userId,
      timezone: TZ,
      weeklyHours: inputs.weeklyHours,
      horizonWeeks: inputs.horizonWeeks,
      today: new Date(z.year, z.month - 1, z.day),
      rows,
      inputs,
      mutationTracker: { mutated: false },
    });
    return tools.find((t) => t.name === name);
  }

  console.log("== add_task ==");
  // The incident itself: undated AND a twin of a dated to-do. Both fire.
  const incident = await (await tool("add_task")).run({
    title: "AIES Lessons Learned",
    duration_min: 120,
    priority: "low",
  });
  check("the incident's own case warns that it's undated", incident.includes(UNDATED), true);
  check("...and names the dated to-do it would silently shadow", incident.includes(TWIN), true);
  check("...quoting that to-do's real date", incident.includes("2026-08-27"), true);

  const floating = await (await tool("add_task")).run({ title: "Some floating task", duration_min: 60 });
  check("an undated task with no twin still warns", floating.includes(UNDATED), true);
  check("...without inventing a twin", floating.includes(TWIN), false);

  // The silence half. A guard that fires on protected work is a guard that
  // gets ignored, so these matter as much as the ones above.
  const dated = await (await tool("add_task")).run({ title: "Dated task", duration_min: 60, due: "august 26" });
  check("a task with a due date is silent", dated.includes(UNDATED), false);

  const pinned = await (await tool("add_task")).run({
    title: "Pinned task",
    duration_min: 60,
    pin_date: "august 25",
    pin_time: "10am",
  });
  check("a pinned task is silent — a pin protects it as well as a date", pinned.includes(UNDATED), false);

  console.log("\n== schedule_todo ==");
  // Booking hours onto the dated to-do is the CORRECT fix for the incident:
  // the task inherits the item's date and stays linked to it.
  const booked = await (await tool("schedule_todo")).run({ text: "AIES Lessons Learned", hours: 2 });
  check("booking hours on a dated to-do inherits its date, so it's silent", booked.includes(UNDATED), false);
  check("...and says the date came from the item itself", booked.includes("its own due date"), true);

  await admin.from("todo_items").insert({ user_id: userId, list_id: list.id, text: "Undated item", sort_order: 1 });
  const bookedUndated = await (await tool("schedule_todo")).run({ text: "Undated item", hours: 1 });
  check("booking hours on an undated to-do warns", bookedUndated.includes(UNDATED), true);
} finally {
  if (userId) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) console.log(`  WARNING: could not delete the test account: ${error.message}`);
  }
}

console.log(`\n${checks - failures}/${checks} undated-guard checks passed`);
process.exit(failures ? 1 : 0);
