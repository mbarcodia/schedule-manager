// Anthropic-SDK backend for planner turns — the same beta tool-runner loop
// the assistant uses, with planning-sized budgets. The client is constructed
// per request: once keys are per-user (Stage 2), a module-level client would
// pin every user to whichever key initialized it first.

import Anthropic from "@anthropic-ai/sdk";
import type { PlannerTurnInput } from "./run-turn";

export async function runAnthropicTurn(input: PlannerTurnInput): Promise<{ reply: string }> {
  const anthropic = new Anthropic({ apiKey: input.secret });

  const finalMessage = await anthropic.beta.messages.toolRunner({
    model: input.model,
    max_tokens: 8000,
    system: input.system,
    messages: input.history.map((m) => ({ role: m.role, content: m.content })),
    tools: input.tools,
    max_iterations: input.maxIterations,
  });

  // Fable 5's safety classifiers can decline a request with HTTP 200 and an
  // empty/partial body — surface it as a normal reply instead of crashing.
  if (finalMessage.stop_reason === "refusal") {
    return { reply: "I can't help with that particular request. Nothing was changed — let's get back to planning." };
  }

  const reply =
    finalMessage.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim() || "Done.";
  return { reply };
}
