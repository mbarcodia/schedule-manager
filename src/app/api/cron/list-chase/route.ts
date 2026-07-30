import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendPushToUser } from "@/lib/notifications/send";
import { zonedNow } from "@/lib/scheduling/time";
import { isPeriodEnd, periodStart } from "@/lib/notifications/chase";
import type { ChaseCadence } from "@/lib/supabase/database.types";

/** Chases whatever is still unticked when a list's period runs out.
 *
 * A list can opt into being chased weekly, monthly or yearly (todo_lists.chase).
 * Shortly before the period ends, anything still open on that list becomes one
 * notification — the point being that "This week" is only a useful heading if
 * something actually happens at the end of the week.
 *
 * Fires in the user's own evening rather than at UTC midnight, so "end of the
 * week" means what they'd mean by it (see lib/notifications/chase.ts).
 * last_chased_at stops the same period nagging twice however often the hourly
 * job runs. */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const supabase = createAdminClient();

  const { data: lists, error } = await supabase
    .from("todo_lists")
    .select("id,user_id,name,chase,last_chased_at")
    .not("chase", "is", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!lists?.length) return NextResponse.json({ lists: 0, chased: 0 });

  const { data: profiles } = await supabase.from("profiles").select("id,timezone");
  const tzById = new Map((profiles ?? []).map((p) => [p.id, p.timezone || "UTC"]));

  let chased = 0;
  for (const list of lists) {
    const cadence = list.chase as ChaseCadence;
    const z = zonedNow(tzById.get(list.user_id) ?? "UTC", now);
    if (!isPeriodEnd(cadence, z)) continue;
    // Already nagged about this period.
    if (list.last_chased_at && new Date(list.last_chased_at).getTime() > periodStart(cadence, now)) continue;

    const { data: open } = await supabase
      .from("todo_items")
      .select("text")
      .eq("list_id", list.id)
      .eq("done", false)
      .eq("hidden", false);
    if (!open?.length) {
      // Nothing outstanding is worth recording as handled, so the list doesn't
      // get re-examined every hour for the rest of the evening.
      await supabase.from("todo_lists").update({ last_chased_at: now.toISOString() }).eq("id", list.id);
      continue;
    }

    const titles = open.map((o) => o.text);
    const period = cadence === "week" ? "week" : cadence === "month" ? "month" : "year";
    await sendPushToUser(supabase, list.user_id, {
      title: `${list.name}: ${titles.length} still open`,
      body: `${titles.slice(0, 3).join(", ")}${titles.length > 3 ? `, and ${titles.length - 3} more` : ""} — the ${period} is nearly over.`,
      url: "/planner",
    });
    await supabase.from("todo_lists").update({ last_chased_at: now.toISOString() }).eq("id", list.id);
    chased++;
  }

  return NextResponse.json({ lists: lists.length, chased });
}
