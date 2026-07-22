// One interface, multiple backends. The route only ever calls
// runPlannerTurn; which Claude runtime executes the turn is decided here.
// Stage 1 ships the Anthropic-SDK path (shared env key). Stage 2 adds
// per-user API keys (same backend, different secret). Stage 3 adds the
// Claude Agent SDK backend for subscription OAuth tokens, which only work
// through Claude Code-shaped traffic.

import { runAnthropicTurn } from "./anthropic-runner";
import type { buildPlannerTools } from "./tools";

export type PlannerProvider = "env_api_key" | "user_api_key" | "subscription_oauth";

export interface PlannerTurnInput {
  provider: PlannerProvider;
  /** Resolved server-side; never sent to or from the client. */
  secret: string;
  model: string;
  system: string;
  history: { role: "user" | "assistant"; content: string }[];
  tools: ReturnType<typeof buildPlannerTools>;
  maxIterations: number;
}

export async function runPlannerTurn(input: PlannerTurnInput): Promise<{ reply: string }> {
  switch (input.provider) {
    case "env_api_key":
    case "user_api_key":
      return runAnthropicTurn(input);
    case "subscription_oauth":
      throw new Error("Subscription-token planning is not enabled on this deployment yet — use an API key.");
  }
}
