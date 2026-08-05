// End-to-end test against a THROWAWAY account (run: npx tsx scripts/e2e-test.mjs).
//
// Everything the sanity-check scripts do is pure-function testing over synthetic
// inputs. That leaves a gap: whether the real database round-trip, the row-level
// security, and the settings columns actually line up with what the code expects.
// This closes it by creating a temporary account, driving it the way the app
// does, asserting on the results, and deleting the account afterwards.
//
// It never touches the owner's data — every row it creates belongs to the
// throwaway user, and deleting that user cascades all of it. Cleanup is verified,
// and runs even when an assertion fails.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { queryScheduleRows } from "../src/lib/scheduling/query-rows.ts";
import { buildScheduleInputs } from "../src/lib/scheduling/from-db.ts";
import { computeSchedule } from "../src/lib/scheduling/engine.ts";
import { buildPlannerDynamicContext } from "../src/lib/planner/system-prompt.ts";
import { computePace, loggedMinutesByCommitment, paceSentence } from "../src/lib/scheduling/pace.ts";
import { toTargets } from "../src/lib/scheduling/from-db.ts";

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
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}
function checkThat(label, condition, detail = "") {
  checks++;
  if (!condition) failures++;
  console.log(`  ${condition ? "OK  " : "FAIL"} ${label}${condition ? "" : `  ${detail}`}`);
}

/** Next Monday, so every test week is entirely in the future and no block is
 * already "missed" before the run starts. */
function nextMonday() {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  d.setHours(8, 0, 0, 0);
  return d;
}
const MONDAY = nextMonday();
const at = (dayOffset, hour, min = 0) => {
  const d = new Date(MONDAY);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, min, 0, 0);
  return d.toISOString();
};
const dateOnly = (dayOffset) => {
  const d = new Date(MONDAY);
  d.setDate(d.getDate() + dayOffset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const show = (b) => `${DAY[b.gday % 7]}w${Math.floor(b.gday / 7)} ${fmt(b.start)}-${fmt(b.end)} ${b.title}`;

let userId = null;

async function recompute() {
  const rows = await queryScheduleRows(admin, userId, MONDAY);
  const { inputs, projects, targets } = buildScheduleInputs(rows, MONDAY);
  return { rows, inputs, projects, targets, schedule: computeSchedule(inputs, MONDAY) };
}

try {
  // ---------------------------------------------------------------- account
  console.log("\n== account ==");
  const email = `e2e-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: `pw-${Math.random().toString(36).slice(2)}`,
    email_confirm: true,
  });
  if (createErr) throw new Error(`could not create the test account: ${createErr.message}`);
  userId = created.user.id;
  console.log(`  created ${email}`);

  const { data: profile } = await admin.from("profiles").select("*").eq("id", userId).maybeSingle();
  checkThat("signup trigger created a profile", profile != null);

  // ------------------------------------------------------------- settings
  // Every Settings control writes one of these. If a column were renamed or a
  // control wired to the wrong one, this is where it shows.
  console.log("\n== settings write/read ==");
  const settings = {
    timezone: TZ,
    weekly_hours: {
      0: { start: 540, end: 1020 },
      1: { start: 540, end: 1020 },
      2: { start: 540, end: 1020 },
      3: { start: 540, end: 1020 },
      4: { start: 540, end: 1020 },
      5: null,
      6: null,
    },
    grace_hours: 8,
    eod_checkin_enabled: true,
    eod_checkin_time: 17 * 60,
    weekly_summary_enabled: true,
    weekly_summary_dow: 4,
    weekly_summary_time: 16 * 60,
    planner_model: "claude-sonnet-5",
    booking_meeting_url: "https://example.com/meet",
    display_name: "Test Owner",
    office_location: "Room 1",
  };
  // One at a time, the way the Settings page writes them: a single rejected
  // value then can't mask whether the others are wired correctly.
  for (const [k, v] of Object.entries(settings)) {
    const { error } = await admin
      .from("profiles")
      .update({ [k]: v })
      .eq("id", userId);
    if (error) {
      checkThat(`  ${k} accepts a write`, false, error.message);
      continue;
    }
    const { data: row } = await admin.from("profiles").select(k).eq("id", userId).single();
    if (k === "weekly_hours") {
      // Key order in returned JSON is not meaningful, inside the day object
      // either — compare the fields themselves.
      const same = Object.keys(v).every((d) => {
        const got = row[k][d] ?? null;
        const want = v[d] ?? null;
        if (got === null || want === null) return got === want;
        return got.start === want.start && got.end === want.end;
      });
      checkThat(`  ${k} round-trips`, same, JSON.stringify(row[k]));
      continue;
    }
    check(`  ${k} round-trips`, row[k], v);
  }
  check("grace_hours reaches the engine", (await recompute()).inputs.graceHours, 8);

  // --------------------------------------------------------------- seeding
  console.log("\n== seeding a realistic week ==");
  // Signup creates no labels (migration 0027) — Settings offers suggestions
  // instead, so nobody inherits a set that doesn't fit their work.
  const { data: seeded } = await admin.from("categories").select("id,name").eq("user_id", userId);
  checkThat(
    "signup creates no labels",
    (seeded ?? []).length === 0,
    `${seeded?.length ?? 0} seeded — migration 0027 not applied yet`,
  );
  // Works either side of that migration, so one pending migration can't block
  // the rest of the suite.
  let label = seeded?.[0] ?? null;
  if (!label) {
    const { data: made, error: labelErr } = await admin
      .from("categories")
      .insert({ user_id: userId, name: "Research", color: "#d9748f", sort_order: 0 })
      .select("id")
      .single();
    checkThat("a label can be added", made != null, labelErr?.message ?? "");
    if (!made) throw new Error("label insert failed");
    label = made;
  }
  await admin.from("categories").update({ min_chunk_min: 30 }).eq("id", label.id);

  await admin.from("recurring_rules").insert({
    user_id: userId,
    title: "Email",
    days: [0, 1, 2, 3, 4],
    length_min: 15,
    win_start_min: 540,
    win_end_min: 555,
  });

  // A project carrying weekly hours, active only from week 1 — so week 0 must
  // generate nothing for it and week 1 must generate the full allowance.
  const { data: proj } = await admin
    .from("projects")
    .insert({
      user_id: userId,
      title: "Modelling study",
      weekly_min_min: 240,
      prefer_morning: true,
      chunk_min: 120,
      research_ord: 1,
      category_id: label.id,
      active_from: dateOnly(7),
    })
    .select("id")
    .single();
  checkThat("project with weekly hours created", proj != null);

  // A second project with a deadline and no weekly hours.
  const { data: proj2 } = await admin
    .from("projects")
    .insert({ user_id: userId, title: "Grant application", deadline_date: dateOnly(11) })
    .select("id")
    .single();

  // A target: a date that must consume no calendar time.
  await admin
    .from("targets")
    .insert({ user_id: userId, commitment_id: proj2.id, title: "Draft complete", target_date: dateOnly(9) });

  // Work: three pieces with different priorities, deadlines and pacing.
  const work = [
    { title: "High priority analysis", priority: "high", duration_min: 180, chunk_min: 60, deadline_at: at(2, 17) },
    { title: "Medium priority writing", priority: "medium", duration_min: 120, chunk_min: 60, deadline_at: at(4, 17) },
    { title: "Low priority admin", priority: "low", duration_min: 60, chunk_min: 30, deadline_at: null },
    { title: "Paced reading", priority: "medium", duration_min: 240, chunk_min: 120, max_per_day_min: 60, deadline_at: at(4, 17) },
  ];
  for (const w of work) {
    await admin.from("tasks").insert({
      user_id: userId,
      project_id: proj2.id,
      category_id: label.id,
      floor_at: at(0, 9),
      ...w,
    });
  }
  // Deliberately more hours than one week holds, linked to the same project and
  // low priority with no deadline, so it spills into later weeks. Without this
  // the snapshot's "this week" figure would equal the horizon-wide one and the
  // check below couldn't tell a correct implementation from the old broken one.
  await admin.from("tasks").insert({
    user_id: userId,
    project_id: proj2.id,
    title: "Long background reading",
    priority: "low",
    duration_min: 1800,
    chunk_min: 120,
    floor_at: at(0, 9),
  });
  console.log(`  seeded 2 projects, 1 target, ${work.length + 1} pieces of work, 1 routine`);

  // ------------------------------------------------------- initial schedule
  console.log("\n== scheduling ==");
  let s = await recompute();
  const taskBlocks = (title) => s.schedule.blocks.filter((b) => b.title === title);
  const minutesOf = (title) => taskBlocks(title).reduce((a, b) => a + (b.end - b.start), 0);

  for (const w of work) check(`all hours placed: ${w.title}`, minutesOf(w.title), w.duration_min);

  checkThat(
    "nothing is scheduled outside working hours",
    s.schedule.blocks.every((b) => b.gday % 7 < 5 && b.start >= 540 && b.end <= 1020),
    s.schedule.blocks.filter((b) => b.gday % 7 >= 5 || b.start < 540 || b.end > 1020).map(show).join(" | "),
  );

  const deadlineAbs = (iso) => {
    const d = new Date(iso);
    const dayOffset = Math.round((d - MONDAY) / 86400000);
    return dayOffset * 1440 + d.getHours() * 60 + d.getMinutes();
  };
  for (const w of work.filter((x) => x.deadline_at)) {
    const latest = Math.max(...taskBlocks(w.title).map((b) => b.gday * 1440 + b.end));
    checkThat(`${w.title} finishes by its deadline`, latest <= deadlineAbs(w.deadline_at), `ends ${latest}`);
  }

  const firstStart = (title) => Math.min(...taskBlocks(title).map((b) => b.gday * 1440 + b.start));
  checkThat(
    "high priority starts before low priority",
    firstStart("High priority analysis") < firstStart("Low priority admin"),
  );

  const perDay = {};
  for (const b of taskBlocks("Paced reading")) perDay[b.gday] = (perDay[b.gday] || 0) + (b.end - b.start);
  checkThat(
    "per-day cap respected",
    Object.values(perDay).every((m) => m <= 60),
    JSON.stringify(perDay),
  );

  const weeklyIn = (wk) =>
    s.schedule.blocks
      .filter((b) => b.projectId === proj.id && Math.floor(b.gday / 7) === wk && b.status !== "missed")
      .reduce((a, b) => a + (b.end - b.start), 0);
  check("weekly hours suppressed before the active window", weeklyIn(0), 0);
  check("weekly hours generated inside the window", weeklyIn(1), 240);

  checkThat(
    "weekly hours claim mornings",
    s.schedule.blocks.filter((b) => b.projectId === proj.id).every((b) => b.end <= 12 * 60),
  );

  check("the target consumes no calendar time", s.schedule.blocks.filter((b) => b.title === "Draft complete").length, 0);
  check("the target is loaded for display", s.targets.length, 1);

  const routine = s.schedule.blocks.filter((b) => b.title === "Email");
  const routineWeek0 = routine.filter((b) => b.gday < 7).map((b) => b.gday).sort();
  check("routine appears on each working day of the week", routineWeek0, [0, 1, 2, 3, 4]);
  check("routine repeats across the whole horizon", routine.length, 5 * s.inputs.horizonWeeks);
  checkThat("routine sits in its window", routine.every((b) => b.start === 540 && b.end === 555));

  // ------------------------------------------------------------- disruption
  console.log("\n== disruption: a meeting lands on booked time ==");
  const busyDay = 1;
  const beforeAll = s.schedule.blocks.filter((b) => b.type === "task").map(show);
  const displaced = [...new Set(s.schedule.blocks.filter((b) => b.type === "task" && b.gday === busyDay).map((b) => b.title))];
  console.log(`  (work booked on the day about to be blocked: ${displaced.join(", ") || "none"})`);
  await admin.from("events").insert({
    user_id: userId,
    title: "Surprise meeting",
    starts_at: at(busyDay, 9),
    ends_at: at(busyDay, 17),
    source: "manual",
  });
  s = await recompute();
  const afterAll = s.schedule.blocks.filter((b) => b.type === "task").map(show);

  checkThat(
    "no work is left on the blocked day",
    s.schedule.blocks.filter((b) => b.gday === busyDay && b.type === "task").length === 0,
    s.schedule.blocks.filter((b) => b.gday === busyDay).map(show).join(" | "),
  );
  checkThat("displaced work was actually there to displace", displaced.length > 0);
  checkThat(
    "the schedule reflowed",
    JSON.stringify(beforeAll) !== JSON.stringify(afterAll),
    "identical before and after",
  );
  for (const title of displaced) {
    const expected = work.find((w) => w.title === title)?.duration_min;
    if (expected) check(`displaced work fully re-placed: ${title}`, minutesOf(title), expected);
  }
  const latestAfter = Math.max(...taskBlocks("High priority analysis").map((b) => b.gday * 1440 + b.end));
  checkThat("still meets its deadline after the disruption", latestAfter <= deadlineAbs(work[0].deadline_at));
  for (const w of work) check(`still fully placed: ${w.title}`, minutesOf(w.title), w.duration_min);

  // ------------------------------------------------------------------ to-do
  console.log("\n== to-dos, reminders, bookings ==");
  const { data: list } = await admin
    .from("todo_lists")
    .insert({ user_id: userId, name: "This week", chase: "week" })
    .select("id")
    .single();
  const { data: item } = await admin
    .from("todo_items")
    .insert({
      user_id: userId,
      list_id: list.id,
      text: "Give the seminar",
      due_at: at(3, 15),
      lead_minutes: [10080, 1440],
    })
    .select("id")
    .single();
  checkThat("to-do with a date and two leads created", item != null);

  // Booking hours for it, finishing before it happens — i.e. preparation.
  const { data: prep } = await admin
    .from("tasks")
    .insert({
      user_id: userId,
      title: "Prep: Give the seminar",
      priority: "high",
      duration_min: 120,
      chunk_min: 60,
      floor_at: at(2, 9),
      deadline_at: at(3, 13),
      category_id: label.id,
    })
    .select("id")
    .single();
  await admin.from("todo_items").update({ task_id: prep.id }).eq("id", item.id);

  // And the seminar itself as an event holding its slot.
  const { data: ev } = await admin
    .from("events")
    .insert({ user_id: userId, title: "Give the seminar", starts_at: at(3, 15), ends_at: at(3, 16), source: "manual" })
    .select("id")
    .single();
  await admin.from("todo_items").update({ event_id: ev.id }).eq("id", item.id);

  s = await recompute();
  check("prep hours placed", minutesOf("Prep: Give the seminar"), 120);
  const prepLatest = Math.max(...taskBlocks("Prep: Give the seminar").map((b) => b.gday * 1440 + b.end));
  checkThat("prep finishes before the event", prepLatest <= deadlineAbs(at(3, 13)), `ends ${prepLatest}`);
  checkThat(
    "the event holds its slot",
    s.schedule.blocks.some((b) => b.title === "Give the seminar" && b.type === "synced" && b.start === 900),
  );
  checkThat(
    "no work overlaps the event",
    !s.schedule.blocks.some((b) => b.type === "task" && b.gday === 3 && b.start < 960 && b.end > 900),
  );

  // Reminder leads: the cron compares each lead against the clock.
  const { data: due } = await admin
    .from("todo_items")
    .select("due_at,lead_minutes,sent_leads,done")
    .eq("id", item.id)
    .single();
  check("leads stored newest-first", due.lead_minutes, [10080, 1440]);
  check("nothing marked sent yet", due.sent_leads, []);

  // -------------------------------------------------- what the chat is told
  // The chat can only judge capacity honestly if the snapshot's numbers are
  // right. This one summed the whole 12-week horizon and called it "this week".
  console.log("\n== the state snapshot the chat reads ==");
  s = await recompute();
  const ctx = buildPlannerDynamicContext(s.rows, s.inputs, s.schedule, []);
  const snap = JSON.parse(ctx.match(/Current state: (\{.*\})\n/s)?.[1] ?? "{}");
  check(
    "snapshot reports the user's vocabulary",
    Object.keys(snap).filter((k) => ["tasks", "projects", "labels"].includes(k)).sort(),
    ["labels", "projects", "tasks"],
  );
  // Blocks carry the id of the project they belong to, but the TITLE of the work
  // item — so this has to match on the id, not the name.
  const idByTitle = new Map(s.rows.projects.map((r) => [r.title, r.id]));
  for (const p of snap.projects ?? []) {
    const id = idByTitle.get(p.title);
    const week0 = s.schedule.blocks
      .filter((b) => b.projectId === id && b.gday < 7 && b.status !== "missed")
      .reduce((a, b) => a + (b.end - b.start), 0);
    check(`scheduledThisWeekHrs counts only this week: ${p.title}`, p.scheduledThisWeekHrs, +(week0 / 60).toFixed(1));
  }
  // And prove the horizon-wide figure would have been different, so this test
  // would actually have caught the original bug.
  const grantId = idByTitle.get("Grant application");
  const allWeeks = s.schedule.blocks
    .filter((b) => b.projectId === grantId && b.status !== "missed")
    .reduce((a, b) => a + (b.end - b.start), 0);
  const thisWeek = s.schedule.blocks
    .filter((b) => b.projectId === grantId && b.gday < 7 && b.status !== "missed")
    .reduce((a, b) => a + (b.end - b.start), 0);
  checkThat(
    "the fixture distinguishes this week from the whole horizon",
    allWeeks !== thisWeek,
    `both ${allWeeks} — the check would pass even with the bug present`,
  );
  checkThat("at-risk fields are present for the chat to reason from", 
    ["willMissDeadline", "cuttingItClose", "didNotFit", "missedTimeBlocks"].every((k) => k in snap));

  // ------------------------------------------------------------------- pace
  // The sanity checks cover computePace as a pure function. What only a real
  // round trip can catch is a column that doesn't exist, or one whose value
  // doesn't survive the write and the read — which is exactly how a schema and
  // its code drift apart. Every figure here goes through Postgres first.
  console.log("\n== pace, through the database ==");

  const paceOf = (rows, projects, targets, logged, id) =>
    computePace({
      projects,
      targets: toTargets(targets),
      loggedByProject: logged,
      weeklyHours: {},
      now: MONDAY,
    }).find((p) => p.projectId === id);

  // A commitment with everything pace needs: a total, a rate, and its own date.
  const { data: paceProj, error: paceErr } = await admin
    .from("projects")
    .insert({
      user_id: userId,
      title: "Paced proposal",
      weekly_min_min: 180,
      effort_estimate_min: 80 * 60,
      deadline_date: dateOnly(70),
      deadline_kind: "hard",
    })
    .select("id")
    .single();
  checkThat("effort estimate and deadline kind round-trip", paceProj != null, paceErr?.message ?? "");

  {
    const r = await recompute();
    const p = paceOf(r.rows, r.projects, r.rows.targets, {}, paceProj.id);
    check("no targets: pace measures the whole estimate", [p.scopeMin, p.estimateMin], [4800, 4800]);
    check("nothing logged yet", p.status, "not_started");
  }

  // A costed phase two weeks out. Before targets carried hours this reported the
  // whole 80h as due by it — the bug the column exists to fix.
  const { error: phaseErr } = await admin.from("targets").insert({
    user_id: userId,
    commitment_id: paceProj.id,
    title: "Notice of intent",
    target_date: dateOnly(14),
    effort_estimate_min: 4 * 60,
  });
  checkThat("a target's own hours round-trip", phaseErr == null, phaseErr?.message ?? "");

  {
    const r = await recompute();
    const p = paceOf(r.rows, r.projects, r.rows.targets, {}, paceProj.id);
    check("a costed phase is what gets measured, not the project", p.scopeMin, 240);
    check("the total is still reported alongside it", p.estimateMin, 4800);
    check("the phase is the date in the sentence", p.nextDateLabel, "Notice of intent");
  }

  // Logged hours have to reach pace by the same route the app uses: progress_log
  // rows attributed through subject_type.
  await admin.from("progress_log").insert({
    user_id: userId,
    subject_type: "research",
    subject_id: paceProj.id,
    occurred_date: dateOnly(0),
    start_min: 540,
    end_min: 660,
    minutes_done: 120,
  });

  {
    const r = await recompute();
    const { data: log } = await admin.from("progress_log").select("subject_type,subject_id,start_min,end_min,minutes_done").eq("user_id", userId);
    const logged = loggedMinutesByCommitment(log ?? [], r.rows.tasks);
    const p = paceOf(r.rows, r.projects, r.rows.targets, logged, paceProj.id);
    check("logged research hours are attributed to the commitment", p.loggedMin, 120);
    check("remaining is measured against the phase, not the project", p.remainingMin, 120);
    // 2h left at 3h/wk against 2 weeks — comfortable. Against the whole 80h it
    // would have been 26 weeks of work and reported as slipping.
    check("and so the near checkpoint is not a crisis", p.status, "ahead");
    checkThat(
      "the sentence names the phase's hours",
      paceSentence(p).includes("of the 4h due by"),
      paceSentence(p),
    );
  }

  // ------------------------------------------------------- archiving a commitment
  console.log("\n== archiving keeps the record ==");
  await admin.from("projects").update({ archived_at: new Date().toISOString() }).eq("id", paceProj.id);
  {
    const r = await recompute();
    checkThat(
      "an archived commitment leaves the schedule",
      !r.rows.projects.some((p) => p.id === paceProj.id),
      "still returned by queryScheduleRows",
    );
    const { data: log } = await admin.from("progress_log").select("id").eq("subject_id", paceProj.id);
    check("but its logged hours survive", log?.length, 1);
    const { data: kept } = await admin.from("targets").select("id,effort_estimate_min").eq("commitment_id", paceProj.id);
    check("and so do its dates, with their hours", kept?.map((t) => t.effort_estimate_min), [240]);
  }
  await admin.from("projects").update({ archived_at: null }).eq("id", paceProj.id);
  {
    const r = await recompute();
    checkThat(
      "restoring brings it back",
      r.rows.projects.some((p) => p.id === paceProj.id),
      "not returned after un-archiving",
    );
  }

  // ------------------------------------------------------- one day's hours
  // The `closed` column, and the thing it exists for: an override with no start
  // and no end is NOT a closed day — it falls through to the standard hours.
  console.log("\n== a day that is different ==");
  const { error: ovErr } = await admin
    .from("day_overrides")
    .insert({ user_id: userId, override_date: dateOnly(2), start_min: 540, end_min: 720, closed: false });
  checkThat("a shortened day round-trips", ovErr == null, ovErr?.message ?? "");
  {
    const r = await recompute();
    check("the engine sees the shortened window", r.inputs.dayOverrides[2]?.end, 720);
    const latest = Math.max(
      ...r.schedule.blocks.filter((b) => b.gday === 2 && !b.allDay).map((b) => b.end),
      0,
    );
    checkThat("and places nothing after it", latest <= 720, `something ends at ${latest}`);
  }

  await admin.from("day_overrides").update({ closed: true }).eq("override_date", dateOnly(2));
  {
    const r = await recompute();
    check("a closed day reaches the engine", r.inputs.dayOverrides[2]?.closed, true);
    const onClosedDay = r.schedule.blocks.filter((b) => b.gday === 2 && !b.allDay && b.type !== "synced");
    check("and nothing is scheduled on it", onClosedDay.length, 0);
  }

  // ---------------------------------------------------------------- cleanup
  console.log("\n== cleanup ==");
} catch (err) {
  failures++;
  console.log(`\n  FAIL threw: ${err.message}`);
} finally {
  if (userId) {
    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    console.log(`  account deleted${delErr ? ` — ERROR ${delErr.message}` : ""}`);
    // Deleting the user cascades every table via user_id; prove it.
    const tables = [
      "profiles",
      "projects",
      "targets",
      "tasks",
      "events",
      "categories",
      "recurring_rules",
      "todo_lists",
      "todo_items",
      "lists",
      "list_items",
    ];
    let leftovers = 0;
    for (const t of tables) {
      const col = t === "profiles" ? "id" : "user_id";
      const { data } = await admin.from(t).select("id").eq(col, userId);
      if (data?.length) {
        leftovers += data.length;
        console.log(`  FAIL ${data.length} leftover row(s) in ${t}`);
      }
    }
    checkThat("no rows left behind", leftovers === 0, `${leftovers} rows`);
  }
  console.log(`\n${failures ? `${failures} of ${checks} checks FAILED` : `all ${checks} checks passed`}`);
  process.exit(failures ? 1 : 0);
}
