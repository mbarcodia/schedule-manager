import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncConnection } from "@/lib/calendar-sync/sync";

/** User-triggered "Sync now" — re-fetches every connected calendar feed for
 * the signed-in account only (RLS scopes the query; no admin client needed
 * here, unlike the cron route which has no user session to scope by). */
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { data: connections, error } = await supabase
    .from("calendar_connections")
    .select("id,user_id,provider,ics_url,all_day_mode")
    .eq("user_id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results = await Promise.all((connections ?? []).map((c) => syncConnection(supabase, c)));
  const synced = results.filter((r) => r.ok).length;
  const failed = results.length - synced;

  return NextResponse.json({ synced, failed, results });
}
