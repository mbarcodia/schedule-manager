// One interface, two in-process backends (both riding the Anthropic SDK's
// tool runner). The route only ever calls runPlannerTurn for these two.
//
// The third provider, subscription_oauth, is deliberately NOT handled
// here: the Claude Agent SDK it requires bundles a ~250-270MB native CLI
// binary that doesn't fit in a Vercel serverless function (confirmed by
// measuring the traced bundle size). That path runs on a separate relay
// service instead (src/relay/server.ts, called via relay-runner.ts) —
// api/planner/route.ts branches to it BEFORE reaching this file, so
// agent-runner.ts is intentionally never imported here. Keeping that
// import out of this file is what keeps the Agent SDK out of every
// Vercel function's dependency graph.

import { runAnthropicTurn, runAnthropicTurnStream } from "./anthropic-runner";
import type { buildPlannerTools } from "./tools";

export type PlannerProvider = "user_api_key" | "subscription_oauth";

/** The system prompt split at its stability boundary. `persona` is byte-identical
 * every turn, so it sits before the prompt-cache breakpoint and is re-read
 * instead of re-processed; `context` (clock time, schedule snapshot, notes
 * index) changes every turn and must follow it. Prompt caching is a prefix
 * match — putting the volatile half first would cache nothing. */
export interface PlannerSystemPrompt {
  persona: string;
  context: string;
}

export interface PlannerTurnInput {
  provider: PlannerProvider;
  /** Resolved server-side; never sent to or from the client. */
  secret: string;
  model: string;
  system: PlannerSystemPrompt;
  history: { role: "user" | "assistant"; content: string }[];
  tools: ReturnType<typeof buildPlannerTools>;
  maxIterations: number;
}

export async function runPlannerTurn(input: PlannerTurnInput): Promise<{ reply: string }> {
  switch (input.provider) {
    case "user_api_key":
      return runAnthropicTurn(input);
    case "subscription_oauth":
      // Should be unreachable — api/planner/route.ts intercepts this
      // provider before calling runPlannerTurn. Throwing here (rather than
      // importing agent-runner.ts to handle it) is what keeps the Agent
      // SDK out of this route's bundle.
      throw new Error("subscription_oauth must be routed through relay-runner.ts, not runPlannerTurn.");
  }
}

/** Streaming counterpart of runPlannerTurn — same two in-process backends,
 * same subscription_oauth exclusion. */
export async function runPlannerTurnStream(
  input: PlannerTurnInput,
  onChunk: (text: string) => void,
): Promise<{ reply: string }> {
  switch (input.provider) {
    case "user_api_key":
      return runAnthropicTurnStream(input, onChunk);
    case "subscription_oauth":
      throw new Error("subscription_oauth must be routed through relay-runner.ts, not runPlannerTurnStream.");
  }
}
