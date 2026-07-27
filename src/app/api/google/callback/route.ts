import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { exchangeCode, verifyState } from "@/lib/google/oauth";

/** Google redirects here after consent. Verifies the HMAC state against the
 * session user (CSRF), exchanges the code, stores the refresh token in the
 * service-role-only google_credentials table, and bounces back to Settings.
 * Errors never leak details into the redirect — just ?google=error. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const settingsUrl = (result: string) => new URL(`/settings?google=${result}`, process.env.APP_ORIGIN);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", process.env.APP_ORIGIN));

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !verifyState(state, user.id)) {
    return NextResponse.redirect(settingsUrl("error"));
  }

  try {
    const { refreshToken, email } = await exchangeCode(code);
    const admin = createAdminClient();
    const { error } = await admin.from("google_credentials").upsert(
      { user_id: user.id, google_email: email, refresh_token: refreshToken, needs_reconnect: false },
      { onConflict: "user_id" },
    );
    if (error) throw error;
    return NextResponse.redirect(settingsUrl("connected"));
  } catch (e) {
    console.error("[google] callback failed:", e instanceof Error ? e.message : e);
    return NextResponse.redirect(settingsUrl("error"));
  }
}
