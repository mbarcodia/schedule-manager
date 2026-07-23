import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { queryScheduleRows } from "@/lib/scheduling/query-rows";
import { buildScheduleInputs } from "@/lib/scheduling/from-db";
import { computeSchedule } from "@/lib/scheduling/engine";
import { buildSystemPrompt } from "@/lib/assistant/system-prompt";
import { buildTools } from "@/lib/assistant/tools";
import { resolveAssistantCredential, NO_CREDENTIAL_MESSAGE } from "@/lib/ai/credentials";
import { describeAnthropicError } from "@/lib/ai/errors";
import { zonedNow } from "@/lib/scheduling/time";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "Missing message" }, { status: 400 });

  // Persist the user's message immediately (chat history survives reloads).
  await supabase.from("chat_messages").insert({ user_id: user.id, role: "user", content: message });

  const credential = await resolveAssistantCredential(user.id);
  if (!credential.ok) {
    await supabase.from("chat_messages").insert({ user_id: user.id, role: "assistant", content: NO_CREDENTIAL_MESSAGE });
    return NextResponse.json({ reply: NO_CREDENTIAL_MESSAGE });
  }
  const anthropic = new Anthropic({ apiKey: credential.secret });

  const rows = await queryScheduleRows(supabase, user.id);
  const { inputs } = buildScheduleInputs(rows);
  const schedule = computeSchedule(inputs);
  const systemPrompt = buildSystemPrompt(rows, inputs, schedule);

  const z = zonedNow(rows.profile.timezone);
  const today = new Date(z.year, z.month - 1, z.day);

  const mutationTracker = { mutated: false };
  const tools = buildTools({
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
    .from("chat_messages")
    .select("role,content")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(12);
  const history = (historyRows ?? [])
    .slice()
    .reverse()
    .map((m) => ({ role: m.role, content: m.content }) as Anthropic.Beta.Messages.BetaMessageParam);

  let reply: string;
  try {
    const finalMessage = await anthropic.beta.messages.toolRunner({
      model: rows.profile.preferred_model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: history,
      tools,
      max_iterations: 6,
    });
    reply =
      finalMessage.content
        .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim() || "Done.";
  } catch (err) {
    console.error("chat route error", err);
    reply =
      describeAnthropicError(err) ??
      (mutationTracker.mutated
        ? "The assistant hit an error partway through this — some changes may have already gone through before it failed. Check your calendar, then send that again if anything's still missing."
        : "I couldn't reach the assistant just now — nothing was changed. Please send that again.");
  }

  await supabase.from("chat_messages").insert({ user_id: user.id, role: "assistant", content: reply });

  return NextResponse.json({ reply });
}
