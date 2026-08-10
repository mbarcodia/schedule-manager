import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { zonedDateKey, zonedNow } from "@/lib/scheduling/time";
import { targetUtcHour } from "@/lib/notifications/time-match";
import { sendPushToUser } from "@/lib/notifications/send";
import { queryScheduleRows } from "@/lib/scheduling/query-rows";
import { buildScheduleInputs } from "@/lib/scheduling/from-db";
import { computeSchedule } from "@/lib/scheduling/engine";
import { deriveBoardStatuses, boardStatusFor } from "@/lib/planner/board-status";
import { logWrite } from "@/lib/planner/write";

const DAY_MS = 86400000;

/** Vercel Cron hits this hourly (24 entries in vercel.json, see
 * time-match.ts) with ?hour=N. Two jobs at each user's weekly review moment:
 *
 * 1. Research-hours accounting (original behavior): hours already logged
 *    (progress_log) against each research project's weekly target.
 * 2. Weekly review over tasks: done/total/missed counts for the week, plus
 *    AUTO-ARCHIVE of finished tasks — derived status "done" with nothing
 *    scheduled in any later week. Archived rows keep their progress_log
 *    history forever (nothing is deleted); restore is on the board's
 *    Archive view. This runs the scheduling engine, which the original
 *    accounting deliberately avoided — the board derivation needs it. */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hour = Number(new URL(request.url).searchParams.get("hour"));
  const now = new Date();
  const supabase = createAdminClient();

  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id, timezone, weekly_summary_dow, weekly_summary_time")
    .eq("weekly_summary_enabled", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const matched = (profiles ?? []).filter(
    (p) =>
      zonedNow(p.timezone, now).weekdayIdx === p.weekly_summary_dow &&
      targetUtcHour(p.timezone, p.weekly_summary_time, now) === hour,
  );

  let sent = 0;
  let archived = 0;
  for (const p of matched) {
    // occurred_date is a CIVIL date in this user's timezone, so the window has
    // to be built in it. toISOString() is UTC: an 8pm New York digest runs after
    // midnight UTC, which moved both bounds a day forward and silently dropped
    // the oldest logged day from the total. localDateKey is the wrong helper
    // here too — it formats in the RUNTIME's zone, which on Vercel is UTC.
    const weekAgoDate = zonedDateKey(p.timezone, new Date(now.getTime() - 7 * DAY_MS));
    const todayDate = zonedDateKey(p.timezone, now);

    const [{ data: log }, { data: projects }, rows] = await Promise.all([
      supabase
        .from("progress_log")
        .select("subject_id, start_min, end_min, minutes_done")
        .eq("user_id", p.id)
        .eq("subject_type", "research")
        .gte("occurred_date", weekAgoDate)
        .lte("occurred_date", todayDate),
      supabase
        .from("projects")
        .select("id, title, weekly_min_min")
        .eq("user_id", p.id)
        .not("weekly_min_min", "is", null)
        // Nothing is scheduled for an archived commitment, so reporting it as
        // having missed its weekly hours would be a notification about a
        // commitment the user has finished with. The same is true of one on
        // hold, where a weekly "0h / 6h" is a reminder that the user is doing
        // exactly what they decided to do.
        .is("archived_at", null)
        .is("on_hold_at", null),
      queryScheduleRows(supabase, p.id, now),
    ]);

    // --- research hours (original) ---
    const minutesByProject = new Map<string, number>();
    for (const row of log ?? []) {
      const done = row.minutes_done ?? row.end_min - row.start_min;
      minutesByProject.set(row.subject_id, (minutesByProject.get(row.subject_id) ?? 0) + done);
    }
    const researchLines = (projects ?? []).map((pr) => {
      const done = minutesByProject.get(pr.id) ?? 0;
      const doneHrs = Math.round((done / 60) * 10) / 10;
      const targetHrs = Math.round(((pr.weekly_min_min ?? 0) / 60) * 10) / 10;
      return `${pr.title}: ${doneHrs}h / ${targetHrs}h`;
    });

    // --- weekly task review + auto-archive ---
    const { inputs } = buildScheduleInputs(rows, now);
    const schedule = computeSchedule(inputs, now);
    const index = deriveBoardStatuses(schedule);
    const hasLaterBlocks = new Set(
      schedule.blocks.filter((b) => b.type === "task" && b.taskId && b.gday >= 7).map((b) => b.taskId as string),
    );

    // Tasks under a paused commitment are withheld from the engine by design,
    // so counting them would report "2/9 done" against work that was never
    // going to be scheduled — and the denominator is the whole point of the line.
    const heldProjects = new Set((rows.projects ?? []).filter((p) => p.on_hold_at).map((p) => p.id));
    const liveTasks = rows.tasks.filter((t) => !(t.project_id && heldProjects.has(t.project_id)));
    const statuses = liveTasks.map((t) => boardStatusFor(index, t.id));
    const doneTasks = liveTasks.filter((t, i) => statuses[i] === "done");
    const finished = doneTasks.filter((t) => !hasLaterBlocks.has(t.id));
    if (finished.length) {
      // Counted only when it actually landed. `archived` is what the route
      // reports back, so incrementing regardless made the response state a
      // number of archived tasks that might all still be sitting on the board.
      const ok = await logWrite(
        `weekly-summary: archiving ${finished.length} finished task(s)`,
        supabase
          .from("tasks")
          .update({ archived_at: now.toISOString() })
          .in(
            "id",
            finished.map((t) => t.id),
          ),
      );
      if (ok) archived += finished.length;
    }

    const taskLine = liveTasks.length
      ? `Tasks: ${doneTasks.length}/${liveTasks.length} done this week, ${schedule.missed.length} missed${
          finished.length ? ` · ${finished.length} archived` : ""
        }`
      : null;

    const body = [...researchLines, ...(taskLine ? [taskLine] : [])].join(" · ");
    if (!body) continue;

    const ok = await sendPushToUser(supabase, p.id, {
      title: "Weekly review",
      body,
      url: "/planner",
    });
    if (ok) sent++;
  }

  return NextResponse.json({ matched: matched.length, sent, archived });
}
