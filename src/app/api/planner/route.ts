import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { queryScheduleRows } from "@/lib/scheduling/query-rows";
import { buildScheduleInputs } from "@/lib/scheduling/from-db";
import { computeSchedule } from "@/lib/scheduling/engine";
import { buildPlannerPersonaPrompt, buildPlannerDynamicContext } from "@/lib/planner/system-prompt";
import { pickTurnModel } from "@/lib/planner/model-routing";
import { DEFAULT_CHAT_MODE, isChatMode, modeInstruction } from "@/lib/planner/modes";
import { buildPlannerTools } from "@/lib/planner/tools";
import { runPlannerTurnStream } from "@/lib/planner/run-turn";
import { runRelayTurnStream } from "@/lib/planner/relay-runner";
import { resolvePlannerCredential, NO_CREDENTIAL_MESSAGE } from "@/lib/ai/credentials";
import { describeAnthropicError } from "@/lib/ai/errors";
import { zonedNow } from "@/lib/scheduling/time";
import { logWrite } from "@/lib/planner/write";

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
  // Which job the user asked for: a single edit, or a guided planning session.
  const mode = isChatMode(body?.mode) ? body.mode : DEFAULT_CHAT_MODE;

  // Persist the user's message immediately (planner history survives reloads).
  await logWrite(
    "planner: saving the user's message to history",
    supabase.from("planner_messages").insert({ user_id: user.id, role: "user", content: message }),
  );

  const credential = await resolvePlannerCredential(user.id);
  const mutationTracker = { mutated: false };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let reply: string;
      try {
        if (!credential.ok) {
          reply = NO_CREDENTIAL_MESSAGE;
          controller.enqueue(encoder.encode(reply));
        } else if (credential.provider === "subscription_oauth") {
          // The relay does everything itself (fetch rows/notes/history,
          // build the prompt and tools) using its own admin client — see
          // src/relay/server.ts. Vercel only needs the model choice here,
          // and pipes the relay's text chunks straight through to the
          // client as they arrive.
          const { data: profile } = await supabase.from("profiles").select("planner_model").eq("id", user.id).single();
          ({ reply } = await runRelayTurnStream(
            {
              userId: user.id,
              secret: credential.secret,
              model: pickTurnModel(message, profile?.planner_model ?? "claude-opus-4-8", mode),
              mode,
            },
            (chunk) => controller.enqueue(encoder.encode(chunk)),
          ));
        } else {
          const [rows, { data: noteRows }] = await Promise.all([
            queryScheduleRows(supabase, user.id),
            supabase.from("notes").select("*").eq("user_id", user.id).order("updated_at", { ascending: false }),
          ]);
          const { inputs } = buildScheduleInputs(rows);
          const schedule = computeSchedule(inputs);
          // Split rather than concatenated: the persona half is cacheable
          // (see PlannerSystemPrompt), the context half changes every turn.
          const systemPrompt = {
            persona: buildPlannerPersonaPrompt(),
            // The mode contract belongs in the volatile half — it changes per
            // turn, and putting it in the persona would break the cache prefix.
            context: `${buildPlannerDynamicContext(rows, inputs, schedule, noteRows ?? [])}\n${modeInstruction(mode)}`,
          };

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
            mutationTracker,
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
              model: pickTurnModel(message, rows.profile.planner_model, mode),
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
        reply =
          describeAnthropicError(err) ??
          (mutationTracker.mutated
            ? "The planner hit an error partway through this turn — some changes (tasks/notes/etc.) may have already gone through before it failed. Check your calendar and notes, then send that again if anything's still missing."
            : "I couldn't reach the planner just now — nothing was changed. Please send that again.");
        controller.enqueue(encoder.encode(reply));
      }

      // The reply has already streamed to the screen by now, so losing this row
      // costs the history rather than the answer — but silently losing half a
      // conversation is exactly the kind of thing that gets blamed on the model.
      await logWrite(
        "planner: saving the assistant's reply to history",
        supabase.from("planner_messages").insert({ user_id: user.id, role: "assistant", content: reply }),
      );
      controller.close();
    },
  });

  return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
