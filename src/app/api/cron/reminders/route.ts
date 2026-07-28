import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendPushToUser } from "@/lib/notifications/send";

/** Fires reminder notifications whose lead time has arrived.
 *
 * Runs hourly from GitHub Actions alongside the digest routes (Vercel's Hobby
 * cron only allows daily, see README). A reminder can have several leads — "a
 * week before" and "a day before" — so each lead is tracked individually in
 * sent_leads and can only fire once.
 *
 * Deliberately fires any lead whose moment has PASSED rather than only ones
 * landing in this exact hour: if a run is missed (a workflow outage, a paused
 * repo), the nudge still goes out late instead of being skipped silently. Leads
 * more than a day overdue are dropped as stale — a "1 week before" alert
 * arriving after the event is worse than nothing. */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const supabase = createAdminClient();

  // Only reminders that still have unfired leads and haven't long passed.
  const horizonPast = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const { data: reminders, error } = await supabase
    .from("reminders")
    .select("id,user_id,title,heading,due_at,notes,lead_minutes,sent_leads")
    .gte("due_at", horizonPast);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let sent = 0;
  for (const r of reminders ?? []) {
    const dueMs = new Date(r.due_at).getTime();
    // Fire the longest overdue lead first so the message names the right one.
    const pending = r.lead_minutes
      .filter((lead) => !r.sent_leads.includes(lead))
      .filter((lead) => {
        const fireAt = dueMs - lead * 60_000;
        const lateBy = now - fireAt;
        return lateBy >= 0 && lateBy < 24 * 60 * 60 * 1000; // due, and not stale
      })
      .sort((a, b) => b - a);
    if (!pending.length) continue;

    const lead = pending[0];
    const when = new Date(r.due_at).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const leadLabel =
      lead === 0
        ? "now"
        : lead % (7 * 24 * 60) === 0
          ? `in ${lead / (7 * 24 * 60)} week(s)`
          : lead % (24 * 60) === 0
            ? `in ${lead / (24 * 60)} day(s)`
            : `in ${Math.round(lead / 60)} hour(s)`;

    const ok = await sendPushToUser(supabase, r.user_id, {
      title: r.heading ? `${r.heading}: ${r.title}` : r.title,
      body: `${leadLabel} — ${when}${r.notes ? ` · ${r.notes}` : ""}`,
      url: "/planner",
    });

    // Mark it fired even when no device accepted, so a user without push
    // enabled doesn't accumulate a backlog that all arrives at once later.
    await supabase
      .from("reminders")
      .update({ sent_leads: [...r.sent_leads, lead] })
      .eq("id", r.id);
    if (ok) sent++;
  }

  return NextResponse.json({ considered: reminders?.length ?? 0, sent });
}
