// Handing a question to the chat from somewhere else on the page.
//
// The calendar and the chat are siblings in the page grid, so a control on one
// cannot reach into the other. The existing route for this is a URL parameter
// (/?review=1, /?plan=1), which is right for a LINK arriving from another page
// but wrong for a button sitting next to the thing it is about: it remounts the
// page and throws away the calendar's scroll position to move focus a few
// hundred pixels sideways.
//
// So this is the same one-line event bus the view-days preference already uses.
// It carries a question and the mode to answer it in; the chat panel fills its
// composer and switches mode.
//
// IT NEVER SENDS. The message is put in the box and left there, exactly as the
// weekly-review deep link does. A button that silently spent a turn on the
// user's own subscription — and, worse, one that could start writing to their
// schedule from a single click on a warning banner — is not a shortcut, it is
// a surprise.

import type { ChatMode } from "./modes";

const EVENT = "planner-ask";

export interface PlannerAsk {
  text: string;
  mode: ChatMode;
}

/** Put a question in the chat's composer and switch it to `mode`. */
export function askPlanner(ask: PlannerAsk): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PlannerAsk>(EVENT, { detail: ask }));
}

/** Subscribe. Returns an unsubscribe, for an effect's cleanup. */
export function onAskPlanner(handler: (ask: PlannerAsk) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<PlannerAsk>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

/** The question the calendar's over-booked banner hands over.
 *
 * Written as a request for the options rather than for a fix, because that is
 * what the planner should do first: the tool behind this returns trade-offs
 * with their costs, and the decision about which to take is the user's. */
export const RESOLVE_SHORTFALL_ASK: PlannerAsk = {
  text:
    "More is booked than fits this week. Show me the options for resolving it — what I could defer, trim, or move, with what each one would free — and tell me which you'd recommend and why. Don't change anything yet.",
  mode: "planning",
};
