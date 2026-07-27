// Anthropic-SDK backend for planner turns — the same beta tool-runner loop
// the assistant uses, with planning-sized budgets. The client is constructed
// per request: once keys are per-user (Stage 2), a module-level client would
// pin every user to whichever key initialized it first.

import Anthropic from "@anthropic-ai/sdk";
import type { PlannerSystemPrompt, PlannerTurnInput } from "./run-turn";

/** Tools render before system, so a breakpoint on the persona block caches the
 * whole tool set plus the persona — by far the largest stable span in the
 * request. The per-turn context block follows it, uncached. Repeat turns in a
 * conversation then re-read that prefix at a fraction of the input cost (and
 * the energy) of reprocessing it. */
function systemBlocks(system: PlannerSystemPrompt): Anthropic.Beta.Messages.BetaTextBlockParam[] {
  return [
    { type: "text", text: system.persona, cache_control: { type: "ephemeral" } },
    { type: "text", text: system.context },
  ];
}

export async function runAnthropicTurn(input: PlannerTurnInput): Promise<{ reply: string }> {
  const anthropic = new Anthropic({ apiKey: input.secret });

  const finalMessage = await anthropic.beta.messages.toolRunner({
    model: input.model,
    max_tokens: 8000,
    system: systemBlocks(input.system),
    messages: input.history.map((m) => ({ role: m.role, content: m.content })),
    tools: input.tools,
    max_iterations: input.maxIterations,
  });

  // Fable 5's safety classifiers can decline a request with HTTP 200 and an
  // empty/partial body — surface it as a normal reply instead of crashing.
  if (finalMessage.stop_reason === "refusal") {
    return { reply: REFUSAL_REPLY };
  }

  const reply =
    finalMessage.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim() || "Done.";
  return { reply };
}

const REFUSAL_REPLY = "I can't help with that particular request. Nothing was changed — let's get back to planning.";

/** Streaming variant: calls onChunk with each piece of visible text as the
 * model writes it, across every tool-runner iteration (not just the final
 * message — a deliberate behavior change from the non-streaming path, which
 * only ever showed the last iteration's text). Still returns the full
 * assembled reply so the caller can persist it once streaming completes. */
export async function runAnthropicTurnStream(
  input: PlannerTurnInput,
  onChunk: (text: string) => void,
): Promise<{ reply: string }> {
  const anthropic = new Anthropic({ apiKey: input.secret });

  const runner = anthropic.beta.messages.toolRunner({
    model: input.model,
    max_tokens: 8000,
    system: systemBlocks(input.system),
    messages: input.history.map((m) => ({ role: m.role, content: m.content })),
    tools: input.tools,
    max_iterations: input.maxIterations,
    stream: true,
  });

  let full = "";
  let lastStopReason: string | null = null;
  let firstIteration = true;
  for await (const messageStream of runner) {
    // Text from different iterations (e.g. a remark before a tool call,
    // then the summary after it comes back) are otherwise concatenated
    // with no boundary — insert a paragraph break between iterations that
    // both produced visible text.
    let wroteInThisIteration = false;
    for await (const event of messageStream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        if (!wroteInThisIteration && !firstIteration && full && !full.endsWith("\n\n")) {
          full += "\n\n";
          onChunk("\n\n");
        }
        wroteInThisIteration = true;
        full += event.delta.text;
        onChunk(event.delta.text);
      } else if (event.type === "message_delta") {
        lastStopReason = event.delta.stop_reason ?? lastStopReason;
      }
    }
    firstIteration = false;
  }

  if (lastStopReason === "refusal") return { reply: REFUSAL_REPLY };
  return { reply: full.trim() || "Done." };
}
