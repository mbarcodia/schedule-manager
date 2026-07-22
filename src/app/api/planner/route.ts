import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { queryScheduleRows } from "@/lib/scheduling/query-rows";
import { buildScheduleInputs } from "@/lib/scheduling/from-db";
import { computeSchedule } from "@/lib/scheduling/engine";
import { buildPlannerSystemPrompt } from "@/lib/planner/system-prompt";
import { buildPlannerTools } from "@/lib/planner/tools";
import { runPlannerTurn, type PlannerProvider } from "@/lib/planner/run-turn";
import { zonedNow } from "@/lib/scheduling/time";

/** Resolves which Claude credential this turn runs on: the user's own
 * planner_credentials row (locked to the service role — see migration
 * 0011) if they've saved one, else the shared env key. */
async function resolveCredential(userId: string): Promise<{ provider: PlannerProvider; secret: string }> {
  const admin = createAdminClient();
  const { data } = await admin.from("planner_credentials").select("provider,secret").eq("user_id", userId).maybeSingle();
  if (data?.provider === "api_key") return { provider: "user_api_key", secret: data.secret };
  if (data?.provider === "oauth_token") return { provider: "subscription_oauth", secret: data.secret };
  return { provider: "env_api_key", secret: process.env.ANTHROPIC_API_KEY ?? "" };
}

// Planning turns run a strong model over a large snapshot with up to 12 tool
// iterations — give the function room beyond the platform default.
export const maxDuration = 300;

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "Missing message" }, { status: 400 });

  // Persist the user's message immediately (planner history survives reloads).
  await supabase.from("planner_messages").insert({ user_id: user.id, role: "user", content: message });

  const [rows, { data: noteRows }] = await Promise.all([
    queryScheduleRows(supabase, user.id),
    supabase.from("notes").select("*").eq("user_id", user.id).order("updated_at", { ascending: false }),
  ]);
  const { inputs } = buildScheduleInputs(rows);
  const schedule = computeSchedule(inputs);
  const systemPrompt = buildPlannerSystemPrompt(rows, inputs, schedule, noteRows ?? []);

  const z = zonedNow(rows.profile.timezone);
  const today = new Date(z.year, z.month - 1, z.day);

  const tools = buildPlannerTools({
    supabase,
    userId: user.id,
    timezone: rows.profile.timezone,
    weeklyHours: inputs.weeklyHours,
    horizonWeeks: inputs.horizonWeeks,
    today,
    rows,
    inputs,
  });

  const { data: historyRows } = await supabase
    .from("planner_messages")
    .select("role,content")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(40);
  const history = (historyRows ?? [])
    .slice()
    .reverse()
    .map((m) => ({ role: m.role, content: m.content }));

  const credential = await resolveCredential(user.id);

  let reply: string;
  try {
    ({ reply } = await runPlannerTurn({
      provider: credential.provider,
      secret: credential.secret,
      model: rows.profile.planner_model,
      system: systemPrompt,
      history,
      tools,
      maxIterations: 12,
    }));
  } catch (err) {
    console.error("planner route error", err);
    reply = "I couldn't reach the planner just now — nothing was changed. Please send that again.";
  }

  await supabase.from("planner_messages").insert({ user_id: user.id, role: "assistant", content: reply });

  return NextResponse.json({ reply });
}
