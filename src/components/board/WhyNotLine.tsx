"use client";

// The one sentence saying why something isn't scheduled, wherever it appears.
//
// Shared because the reason is the same fact on a card, in a panel and on a
// commitment, and three copies of the wording is how they drift. A benign reason
// ("it can't start until October") is drawn in grey rather than amber: it is
// information, not a problem, and colouring it as a warning would make a
// correctly-configured project look broken.

import type { Reason } from "@/lib/scheduling/why-not";

export function WhyNotLine({ reason, size = 10 }: { reason: Reason | null; size?: number }) {
  if (!reason) return null;
  return (
    <div
      className="leading-snug"
      style={{ fontSize: size, color: reason.benign ? "var(--color-muted-2, #75798c)" : "#e0a94e" }}
    >
      {reason.text}
      {reason.fix && <span className="opacity-75"> {reason.fix}</span>}
    </div>
  );
}
