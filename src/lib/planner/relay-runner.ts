// Calls the standalone subscription-token relay (Fly.io) — see
// src/relay/server.ts. The relay does all the work (fetch schedule/notes/
// history, build the prompt and tools, run the Agent SDK); Vercel only
// forwards the three plain-string fields a turn needs.

export async function runRelayTurn(input: { userId: string; secret: string; model: string }): Promise<{ reply: string }> {
  const relayUrl = process.env.PLANNER_RELAY_URL;
  const relaySecret = process.env.PLANNER_RELAY_SECRET;
  if (!relayUrl || !relaySecret) {
    throw new Error("Subscription-token planning isn't enabled on this deployment yet — use an API key instead.");
  }

  const res = await fetch(`${relayUrl}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${relaySecret}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Relay returned ${res.status}`);
  return res.json();
}

/** Streaming counterpart: forwards the relay's plain-text chunks to onChunk
 * as they arrive and returns the assembled reply for persistence — the same
 * contract as runAnthropicTurnStream on the API-key path. */
export async function runRelayTurnStream(
  input: { userId: string; secret: string; model: string },
  onChunk: (text: string) => void,
): Promise<{ reply: string }> {
  const relayUrl = process.env.PLANNER_RELAY_URL;
  const relaySecret = process.env.PLANNER_RELAY_SECRET;
  if (!relayUrl || !relaySecret) {
    throw new Error("Subscription-token planning isn't enabled on this deployment yet — use an API key instead.");
  }

  const res = await fetch(`${relayUrl}/turn-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${relaySecret}` },
    body: JSON.stringify(input),
  });
  if (!res.ok || !res.body) throw new Error(`Relay returned ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (text) {
      full += text;
      onChunk(text);
    }
  }
  return { reply: full.trim() || "Done." };
}
