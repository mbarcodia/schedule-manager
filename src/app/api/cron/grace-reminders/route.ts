import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { queryScheduleRows } from "@/lib/scheduling/query-rows";
import { buildScheduleInputs } from "@/lib/scheduling/from-db";
import { computeSchedule } from "@/lib/scheduling/engine";
import { sendPushToUser } from "@/lib/notifications/send";
import { nowAbsMinute } from "@/lib/scheduling/time";

/** Nudges about work whose grace window is nearly up.
 *
 * A block whose time has passed without being ticked stays visible and
 * completable for profiles.grace_hours. This fires shortly before that lapses,
 * so the reshuffle isn't a surprise and the memory is still fresh.
 *
 * Runs hourly from GitHub Actions (Vercel Hobby cron is daily-only), so
 * "shortly before" means within the next hour rather than an exact 30 minutes. */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const supabase = createAdminClient();

  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id, grace_hours");
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  let notified = 0;
  for (const p of profiles ?? []) {
    const graceMinutes = (p.grace_hours ?? 4) * 60;
    if (graceMinutes <= 0) continue;

    const rows = await queryScheduleRows(supabase, p.id, now);
    const { inputs } = buildScheduleInputs(rows, now);
    const schedule = computeSchedule(inputs, now);
    const nowAbs = nowAbsMinute(inputs.timezone, now);

    // Blocks still in grace whose window runs out within the next hour.
    const expiring = schedule.blocks.filter((b) => {
      if (b.status !== "grace") return false;
      const endAbs = b.gday * 1440 + b.end;
      const minutesLeft = graceMinutes - (nowAbs - endAbs);
      return minutesLeft > 0 && minutesLeft <= 60;
    });
    if (!expiring.length) continue;

    const titles = Array.from(new Set(expiring.map((b) => b.title)));
    const ok = await sendPushToUser(supabase, p.id, {
      title:
        titles.length === 1
          ? `Did you finish ${titles[0]}?`
          : `Did you finish ${titles.length} things?`,
      body:
        titles.length === 1
          ? "It'll be rescheduled shortly if not — tap to tick it off."
          : `${titles.join(", ")} — they'll be rescheduled shortly if not.`,
      url: "/",
    });
    if (ok) notified++;
  }

  return NextResponse.json({ users: profiles?.length ?? 0, notified });
}
