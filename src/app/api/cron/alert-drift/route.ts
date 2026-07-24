import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendPushToUser } from "@/lib/notifications/send";

/** Called by the digest-notifications GitHub Actions workflow when a cron
 * route returns a non-200 — almost always a CRON_SECRET drift between
 * Vercel and GitHub Actions (see CRON_SECRET_RUNBOOK.md). Gated by its own
 * ALERT_SECRET (not CRON_SECRET) so the alert can still fire even when
 * CRON_SECRET itself is the thing that's broken. */
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.ALERT_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ownerId = process.env.ALERT_OWNER_USER_ID;
  if (!ownerId) return NextResponse.json({ error: "ALERT_OWNER_USER_ID not configured" }, { status: 500 });

  const body = await request.json().catch(() => ({}));
  const reason = typeof body?.reason === "string" ? body.reason : "cron routes returned a non-200 response";

  const supabase = createAdminClient();
  const sent = await sendPushToUser(supabase, ownerId, {
    title: "Cron auth broken",
    body: `${reason}. Likely CRON_SECRET drift between Vercel and GitHub Actions — see CRON_SECRET_RUNBOOK.md for the fix.`,
    url: "https://github.com/mbarcodia/schedule-manager/blob/main/web/CRON_SECRET_RUNBOOK.md",
  });

  return NextResponse.json({ sent });
}
