import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { syncConnection } from "@/lib/calendar-sync/sync";

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

  return NextResponse.json({ synced, failed });
}
