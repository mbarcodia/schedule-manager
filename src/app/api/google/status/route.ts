import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { revokeToken } from "@/lib/google/oauth";

// google_credentials is service-role-only (RLS with no policies), so the
// Settings UI reads/deletes through these authenticated endpoints — same
// pattern as /api/planner/credentials.

async function sessionUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function GET() {
  const user = await sessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  const { data } = await admin
    .from("google_credentials")
    .select("google_email,needs_reconnect")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!data) return NextResponse.json({ connected: false });
  return NextResponse.json({ connected: true, email: data.google_email, needsReconnect: data.needs_reconnect });
}

export async function DELETE() {
  const user = await sessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  const { data } = await admin
    .from("google_credentials")
    .select("refresh_token")
    .eq("user_id", user.id)
    .maybeSingle();
  if (data) await revokeToken(data.refresh_token);
  await admin.from("google_credentials").delete().eq("user_id", user.id);
  return NextResponse.json({ connected: false });
}
