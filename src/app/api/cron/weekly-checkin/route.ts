import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { zonedNow } from "@/lib/scheduling/time";
import { targetUtcHour } from "@/lib/notifications/time-match";
import { sendPushToUser } from "@/lib/notifications/send";

/** The GitHub Actions workflow (.github/workflows/digest-notifications.yml)
 * hits this hourly with ?hour=N — Vercel Hobby crons are capped at once/day,
 * so any-hour delivery is driven from there instead (see time-match.ts).
 *
 * Unlike eod-checkin/weekly-summary, which each read ONE time off `profiles`,
 * a user's check-ins are a FLEXIBLE LIST (checkin_slots) — as many or as few
 * points in the week as they want, not a fixed "beginning/middle/end" count.
 * Each row carries its own day and time; a slot matches this invocation when
 * both land in the current UTC hour, in that slot's own timezone. */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hour = Number(new URL(request.url).searchParams.get("hour"));
  const now = new Date();
  const supabase = createAdminClient();

  const { data: slots, error } = await supabase
    .from("checkin_slots")
    .select("id, user_id, label, dow, time_min")
    .eq("enabled", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!slots?.length) return NextResponse.json({ matched: 0, sent: 0 });

  // checkin_slots has no direct FK to profiles (both reference auth.users
  // independently), so the timezone lookup is a second query rather than a
  // Postgrest embed — one round trip for every distinct user with a slot,
  // not one per slot.
  const userIds = [...new Set(slots.map((s) => s.user_id))];
  const { data: profiles } = await supabase.from("profiles").select("id, timezone").in("id", userIds);
  const tzById = new Map((profiles ?? []).map((p) => [p.id, p.timezone]));

  const matched = slots.filter((s) => {
    const tz = tzById.get(s.user_id);
    if (!tz) return false;
    return zonedNow(tz, now).weekdayIdx === s.dow && targetUtcHour(tz, s.time_min, now) === hour;
  });

  let sent = 0;
  for (const s of matched) {
    // The slot's own label is what the user typed for this moment
    // ("Monday kickoff", "Friday wrap-up") — more honest than guessing a
    // position in the week from a count that isn't fixed to begin with.
    const body = s.label ? `${s.label} — how's the week looking?` : "Time for a check-in — how's the week looking?";
    const ok = await sendPushToUser(supabase, s.user_id, { title: "Week check-in", body, url: "/planner?checkin=1" });
    if (ok) sent++;
  }

  return NextResponse.json({ matched: matched.length, sent });
}
