import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { queryScheduleRows } from "@/lib/scheduling/query-rows";
import { buildScheduleInputs } from "@/lib/scheduling/from-db";
import { computeSchedule } from "@/lib/scheduling/engine";
import { zonedNow } from "@/lib/scheduling/time";
import { targetUtcHour } from "@/lib/notifications/time-match";
import { sendPushToUser } from "@/lib/notifications/send";

/** Vercel Cron hits this hourly (24 entries in vercel.json, one per UTC hour,
 * see time-match.ts) with ?hour=N. Each invocation only acts on users whose
 * configured local check-in time falls in that hour, so each user still gets
 * at most one check-in per day despite the route firing 24x. */
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
    .select("id, timezone, eod_checkin_time")
    .eq("eod_checkin_enabled", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const matched = (profiles ?? []).filter(
    (p) => targetUtcHour(p.timezone, p.eod_checkin_time, now) === hour,
  );

  let sent = 0;
  for (const p of matched) {
    // Reuses the same pipeline fetch-schedule-data.ts runs client-side —
    // "what was scheduled today" isn't recoverable from progress_log alone.
    const rows = await queryScheduleRows(supabase, p.id, now);
    const { inputs } = buildScheduleInputs(rows, now);
    const schedule = computeSchedule(inputs, now);
    const today = zonedNow(p.timezone, now).weekdayIdx;
    const todaysBlocks = schedule.blocks.filter((b) => b.type === "task" && b.gday === today);
    if (todaysBlocks.length === 0) continue; // nothing scheduled today — skip, don't nag

    const done = todaysBlocks.filter((b) => b.status === "done").length;
    const missed = todaysBlocks.filter((b) => b.status === "missed").length;
    const body =
      missed > 0
        ? `${done} of ${todaysBlocks.length} done today, ${missed} missed — they'll reschedule.`
        : `${done} of ${todaysBlocks.length} done today. Nice work.`;

    const ok = await sendPushToUser(supabase, p.id, { title: "How'd today go?", body, url: "/" });
    if (ok) sent++;
  }

  return NextResponse.json({ matched: matched.length, sent });
}
