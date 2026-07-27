// Google OAuth for writing bookings onto the owner's Google Calendar.
// Hand-rolled against Google's REST endpoints (two POSTs) — not worth the
// googleapis dependency. Narrowest scope: calendar.events (+ openid email so
// the callback can show which account got connected).
//
// The refresh token lives in google_credentials (service-role-only table,
// same trust model as planner_credentials). The client secret only ever
// exists in env vars — the repo is public.

import { createHmac, timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { sendPushToUser } from "@/lib/notifications/send";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const SCOPES = "https://www.googleapis.com/auth/calendar.events openid email";
const STATE_TTL_MS = 10 * 60 * 1000;

/** Google refused our refresh token (owner revoked access, or Google
 * invalidated it). The credential row is flagged and the owner push-notified
 * by the time this is thrown — callers just degrade gracefully. */
export class GoogleDisconnectedError extends Error {
  constructor() {
    super("Google Calendar connection needs to be re-authorized");
  }
}

function redirectUri(): string {
  return `${process.env.APP_ORIGIN}/api/google/callback`;
}

function sign(payload: string): string {
  return createHmac("sha256", process.env.GOOGLE_CLIENT_SECRET!).update(payload).digest("hex");
}

/** CSRF state: `${userId}.${expiryEpochMs}.${hmac}` — verified in the
 * callback against both the signature and the session user. */
export function buildState(userId: string): string {
  const payload = `${userId}.${Date.now() + STATE_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyState(state: string, sessionUserId: string): boolean {
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [userId, expiry, mac] = parts;
  const expected = sign(`${userId}.${expiry}`);
  if (mac.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  if (Number(expiry) < Date.now()) return false;
  return userId === sessionUserId;
}

export function buildAuthUrl(userId: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    // Force a fresh refresh_token even on re-consent (Google omits it on
    // repeat authorizations otherwise).
    prompt: "consent",
    state: buildState(userId),
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

export async function exchangeCode(code: string): Promise<{ refreshToken: string; email: string }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(),
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
  const data = (await res.json()) as { refresh_token?: string; id_token?: string };
  if (!data.refresh_token) throw new Error("Google returned no refresh token");
  // The id_token arrived over TLS directly from Google's token endpoint —
  // decoding without signature verification is fine for a display-only email.
  let email = "";
  if (data.id_token) {
    try {
      const claims = JSON.parse(Buffer.from(data.id_token.split(".")[1], "base64url").toString());
      email = typeof claims.email === "string" ? claims.email : "";
    } catch {
      // display-only; leave blank
    }
  }
  return { refreshToken: data.refresh_token, email };
}

/** Fresh access token from the stored refresh token. No caching — one extra
 * round trip per booking is irrelevant at this volume. On invalid_grant the
 * row is flagged needs_reconnect and the owner is push-notified. */
export async function getAccessToken(admin: SupabaseClient<Database>, userId: string): Promise<string> {
  const { data: cred } = await admin
    .from("google_credentials")
    .select("refresh_token,needs_reconnect")
    .eq("user_id", userId)
    .maybeSingle();
  if (!cred || cred.needs_reconnect) throw new GoogleDisconnectedError();

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cred.refresh_token,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  });
  if (!res.ok) {
    let error = "";
    try {
      error = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      // non-JSON error body — treat by status alone
    }
    if (error === "invalid_grant" || res.status === 400 || res.status === 401) {
      await admin.from("google_credentials").update({ needs_reconnect: true }).eq("user_id", userId);
      await sendPushToUser(admin, userId, {
        title: "Google Calendar disconnected",
        body: "Bookings still work, but Google invites won't send until you reconnect in Settings.",
        url: "/settings",
      });
      throw new GoogleDisconnectedError();
    }
    throw new Error(`Google token refresh failed (${res.status})`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

/** Best-effort revoke on disconnect — Google-side cleanup, failure ignored. */
export async function revokeToken(refreshToken: string): Promise<void> {
  try {
    await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(refreshToken)}`, { method: "POST" });
  } catch {
    // the row deletion is what matters; Google's side can also be revoked
    // manually at myaccount.google.com/permissions
  }
}
