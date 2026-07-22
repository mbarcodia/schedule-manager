import Anthropic from "@anthropic-ai/sdk";

/** Turns an Anthropic API error (bad key, out of credits, rate limited,
 * etc.) into the message Anthropic itself gave, instead of a generic
 * "couldn't reach it" message that makes a real, actionable failure look
 * like a transient network blip. Returns null for anything else, so callers
 * can fall back to their own generic message. */
export function describeAnthropicError(err: unknown): string | null {
  if (err instanceof Anthropic.APIError) {
    const nested = (err.error as { error?: { message?: string } } | undefined)?.error?.message;
    return nested ?? err.message;
  }
  return null;
}
