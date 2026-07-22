import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { zonedNow } from "@/lib/scheduling/time";
import { targetUtcHour } from "@/lib/notifications/time-match";
import { sendPushToUser } from "@/lib/notifications/send";

const DAY_MS = 86400000;

/** Vercel Cron hits this hourly (24 entries in vercel.json, see
 * time-match.ts) with ?hour=N. Unlike eod-checkin, this is purely backward-
 * looking accounting of hours already logged (progress_log) against each
 * research project's weekly target — no need to run the scheduling engine,
 * which would recompute a forward schedule for no benefit here. */
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
  for (const p of matched) {
    const weekAgoDate = new Date(now.getTime() - 7 * DAY_MS).toISOString().slice(0, 10);
    const todayDate = now.toISOString().slice(0, 10);

    const [{ data: log }, { data: projects }] = await Promise.all([
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
        .not("weekly_min_min", "is", null),
    ]);
    if (!projects?.length) continue;

    const minutesByProject = new Map<string, number>();
    for (const row of log ?? []) {
      const done = row.minutes_done ?? row.end_min - row.start_min;
      minutesByProject.set(row.subject_id, (minutesByProject.get(row.subject_id) ?? 0) + done);
    }

    const lines = projects.map((pr) => {
      const done = minutesByProject.get(pr.id) ?? 0;
      const doneHrs = Math.round((done / 60) * 10) / 10;
      const targetHrs = Math.round(((pr.weekly_min_min ?? 0) / 60) * 10) / 10;
      return `${pr.title}: ${doneHrs}h / ${targetHrs}h`;
    });

    const ok = await sendPushToUser(supabase, p.id, {
      title: "This week's research hours",
      body: lines.join(" · "),
      url: "/",
    });
    if (ok) sent++;
  }

  return NextResponse.json({ matched: matched.length, sent });
}
