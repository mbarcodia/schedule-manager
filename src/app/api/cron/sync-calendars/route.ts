import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { syncConnection } from "@/lib/calendar-sync/sync";
import { sendPushToUser } from "@/lib/notifications/send";

/** Vercel Cron hits this on a schedule (see vercel.json) with an
 * Authorization: Bearer <CRON_SECRET> header it adds automatically once
 * CRON_SECRET is set as an env var. No user session exists in this
 * context, so this is the one place the admin (RLS-bypassing) client is
 * appropriate — it needs every account's connections, not just one. */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const { data: connections, error } = await supabase
    .from("calendar_connections")
    .select("id,user_id,provider,ics_url,all_day_mode");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results = await Promise.all((connections ?? []).map((c) => syncConnection(supabase, c)));
  const synced = results.filter((r) => r.ok).length;
  const failed = results.length - synced;

  // A feed that stops is the failure the booking link cannot absorb: it pauses
  // itself rather than offer times it can't vouch for (see FEED_STALE_HOURS),
  // and a paused link that nobody knows is paused just loses meetings quietly.
  // This is the only sync that runs unattended, so it is where the owner finds
  // out. Notifying is best-effort — it must never turn a partial sync into a
  // failed request.
  const broken = (connections ?? []).filter((c, i) => !results[i].ok);
  const byUser = new Map<string, string[]>();
  for (const c of broken) byUser.set(c.user_id, [...(byUser.get(c.user_id) ?? []), c.id]);
  for (const [userId, ids] of byUser) {
    try {
      const { data: labels } = await supabase
        .from("calendar_connections")
        .select("label")
        .in("id", ids);
      const names = (labels ?? []).map((l) => l.label).join(", ") || "a calendar";
      await sendPushToUser(supabase, userId, {
        title: "Booking link paused",
        body: `${names} failed to sync, so your booking link is not offering times. Open Settings to see why.`,
        url: "/settings",
      });
    } catch (err) {
      console.error("[sync] could not notify about a broken feed:", err);
    }
  }

  return NextResponse.json({ synced, failed });
}
