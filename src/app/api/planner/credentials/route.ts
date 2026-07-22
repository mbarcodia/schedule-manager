import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import type { PlannerCredentialProvider } from "@/lib/supabase/database.types";

// planner_credentials is locked down at the DB level (RLS on, zero
// policies, revoked grants — see migration 0011) so every read/write here
// goes through the admin client. Auth still gates every request through
// the normal user-scoped client first; the admin client only ever touches
// the authenticated user's own row.

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const admin = createAdminClient();
  const { data } = await admin
    .from("planner_credentials")
    .select("provider,secret")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!data) return NextResponse.json({ hasSecret: false });
  return NextResponse.json({ hasSecret: true, provider: data.provider, last4: data.secret.slice(-4) });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const provider = body?.provider as PlannerCredentialProvider | undefined;
  const secret = typeof body?.secret === "string" ? body.secret.trim() : "";
  if (provider !== "api_key" && provider !== "oauth_token") {
    return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  }
  if (!secret) return NextResponse.json({ error: "Missing secret" }, { status: 400 });

  const admin = createAdminClient();
  const { error } = await admin
    .from("planner_credentials")
    .upsert({ user_id: user.id, provider, secret }, { onConflict: "user_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ hasSecret: true, provider, last4: secret.slice(-4) });
}

export async function DELETE() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const admin = createAdminClient();
  await admin.from("planner_credentials").delete().eq("user_id", user.id);
  return NextResponse.json({ hasSecret: false });
}
