// Sends routine one-line commands to a smaller model.
//
// Most messages to this app are not planning conversations — they're single
// mechanical edits ("log 45 minutes on grading", "move ACE2 to 3pm"). Running
// those on the largest model burns tokens, time, and energy for no gain in
// answer quality. This picks the cheaper model for exactly that shape of
// request and leaves everything else on the user's chosen model.
//
// Deliberately conservative: any hint of reasoning, comparison, open-endedness,
// or multiple clauses falls through to the user's model. A wrong downgrade
// costs answer quality, while a missed downgrade only costs tokens — so the
// asymmetry is priced in.

/** The step-down target. Sonnet 5 handles single-action tool calls at Opus
 * quality; only Opus/Fable-tier choices are ever downgraded to it. */
const SIMPLE_TURN_MODEL = "claude-sonnet-5";

/** Models big enough to be worth stepping down from. */
const HEAVY_MODELS = new Set(["claude-opus-4-8", "claude-fable-5", "claude-opus-5"]);

/** Verbs that begin a mechanical, single-action request. */
const SIMPLE_OPENERS =
  /^(add|log|record|mark|set|move|rename|delete|remove|archive|pin|unpin|clear|shorten|extend|reschedule|push|star|done|finish|complete)\b/i;

/** Anything here means the turn wants reasoning, judgement, or prose — never
 * downgrade these, however short the message is. */
const NEEDS_JUDGEMENT =
  /\b(why|how|should|could|would|plan|planning|review|think|thoughts|advice|advise|suggest|recommend|compare|explain|summar|draft|write|analy[sz]e|prioriti[sz]e|realistic|feasible|worried|help me|what if|options?|trade-?offs?|instead of)\b/i;

/** Choose the model for one turn. `preferred` is the user's Settings choice —
 * returned unchanged for anything that isn't plainly mechanical. */
export function pickTurnModel(message: string, preferred: string): string {
  if (!HEAVY_MODELS.has(preferred)) return preferred; // already small; never upgrade
  const text = message.trim();

  if (text.length > 120) return preferred; // long enough to carry real context
  if (text.includes("?")) return preferred; // questions get the big model
  if (NEEDS_JUDGEMENT.test(text)) return preferred;
  if (!SIMPLE_OPENERS.test(text)) return preferred; // not an imperative edit
  // More than one sentence means more than one thing is going on.
  if (/[.!]\s+\S/.test(text)) return preferred;

  return SIMPLE_TURN_MODEL;
}
