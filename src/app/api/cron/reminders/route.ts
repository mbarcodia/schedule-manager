import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendPushToUser } from "@/lib/notifications/send";
import { formatDue, leadAnchor } from "@/lib/scheduling/all-day-due";

/** Fires reminder notifications whose lead time has arrived.
 *
 * Reminders live on to-do items now rather than in their own table: the thing
 * you want warning about and the thing you have to do were always the same
 * thing described twice.
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
 * arriving after the event is worse than nothing.
 *
 * A date-only item has no due time to count back from, so its leads are
 * measured from the start of that date's working day instead of the 23:59 the
 * column stores — otherwise "one day before" fired near midnight. That needs
 * the account's timezone and hours, which is why profiles are read here. */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const supabase = createAdminClient();

  // Only items with a date that still have unfired leads and haven't long
  // passed. A ticked-off item is never chased.
  const horizonPast = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const { data: reminders, error } = await supabase
    .from("todo_items")
    .select("id,user_id,text,due_at,due_all_day,notes,lead_minutes,sent_leads,list_id,done")
    .eq("done", false)
    .not("due_at", "is", null)
    .gte("due_at", horizonPast);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // List names are the heading a reminder arrives under.
  const { data: lists } = await supabase.from("todo_lists").select("id,name");
  const listName = new Map((lists ?? []).map((l) => [l.id, l.name]));

  // Only for the accounts that actually have a reminder pending this run.
  const userIds = [...new Set((reminders ?? []).map((r) => r.user_id))];
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id,timezone,weekly_hours")
    .in("id", userIds);
  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));

  let sent = 0;
  for (const r of reminders ?? []) {
    const profile = profileById.get(r.user_id);
    const timezone = profile?.timezone || "UTC";
    const anchorMs = leadAnchor(r.due_at!, r.due_all_day, timezone, profile?.weekly_hours ?? {}).getTime();
    // Fire the longest overdue lead first so the message names the right one.
    const pending = r.lead_minutes
      .filter((lead) => !r.sent_leads.includes(lead))
      .filter((lead) => {
        const fireAt = anchorMs - lead * 60_000;
        const lateBy = now - fireAt;
        return lateBy >= 0 && lateBy < 24 * 60 * 60 * 1000; // due, and not stale
      })
      .sort((a, b) => b - a);
    if (!pending.length) continue;

    const lead = pending[0];
    const when = formatDue(r.due_at!, r.due_all_day, timezone);
    const leadLabel =
      lead === 0
        ? "now"
        : lead % (7 * 24 * 60) === 0
          ? `in ${lead / (7 * 24 * 60)} week(s)`
          : lead % (24 * 60) === 0
            ? `in ${lead / (24 * 60)} day(s)`
            : `in ${Math.round(lead / 60)} hour(s)`;

    const heading = listName.get(r.list_id);
    const ok = await sendPushToUser(supabase, r.user_id, {
      title: heading ? `${heading}: ${r.text}` : r.text,
      body: `${leadLabel} — ${when}${r.notes ? ` · ${r.notes}` : ""}`,
      url: "/planner",
    });

    // Mark it fired even when no device accepted, so a user without push
    // enabled doesn't accumulate a backlog that all arrives at once later.
    await supabase
      .from("todo_items")
      .update({ sent_leads: [...r.sent_leads, lead] })
      .eq("id", r.id);
    if (ok) sent++;
  }

  return NextResponse.json({ considered: reminders?.length ?? 0, sent });
}
