import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { queryScheduleRows } from "@/lib/scheduling/query-rows";
import { buildScheduleInputs } from "@/lib/scheduling/from-db";
import { computeSchedule } from "@/lib/scheduling/engine";
import { buildPlannerSystemPrompt } from "@/lib/planner/system-prompt";
import { buildPlannerTools } from "@/lib/planner/tools";
import { runPlannerTurnStream, type PlannerProvider } from "@/lib/planner/run-turn";
import { runRelayTurn } from "@/lib/planner/relay-runner";
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

  const credential = await resolveCredential(user.id);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let reply: string;
      try {
        if (credential.provider === "subscription_oauth") {
          // The relay does everything itself (fetch rows/notes/history,
          // build the prompt and tools) using its own admin client — see
          // src/relay/server.ts. Vercel only needs the model choice here.
          // Dormant today (no relay deployed) — resolves to a clean error
          // via runRelayTurn's own check, delivered as a single chunk so
          // the client's read loop doesn't need a separate code path.
          const { data: profile } = await supabase.from("profiles").select("planner_model").eq("id", user.id).single();
          ({ reply } = await runRelayTurn({
            userId: user.id,
            secret: credential.secret,
            model: profile?.planner_model ?? "claude-opus-4-8",
          }));
          controller.enqueue(encoder.encode(reply));
        } else {
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

          ({ reply } = await runPlannerTurnStream(
            {
              provider: credential.provider,
              secret: credential.secret,
              model: rows.profile.planner_model,
              system: systemPrompt,
              history,
              tools,
              maxIterations: 12,
            },
            (chunk) => controller.enqueue(encoder.encode(chunk)),
          ));
        }
      } catch (err) {
        console.error("planner route error", err);
        reply = "I couldn't reach the planner just now — nothing was changed. Please send that again.";
        controller.enqueue(encoder.encode(reply));
      }

      await supabase.from("planner_messages").insert({ user_id: user.id, role: "assistant", content: reply });
      controller.close();
    },
  });

  return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
