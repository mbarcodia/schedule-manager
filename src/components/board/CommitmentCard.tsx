"use client";

// A commitment on the Progress board, with the tasks under it.
//
// The board used to show tasks only, which made it look empty for anyone whose
// work is organised as ongoing commitments with weekly hours rather than as a
// pile of discrete tasks. A commitment is the thing being kept up with; a task
// is a piece of it.
//
// The card leads with pace, and when pace can't be computed it says which input
// is missing instead of showing a reassuring number derived from nothing.

import { StarIcon } from "@phosphor-icons/react";
import type { CommitmentPace } from "@/lib/scheduling/pace";
import { paceSentence } from "@/lib/scheduling/pace";
import type { ReactNode } from "react";

export function CommitmentCard({
  pace,
  color,
  onToggleImportant,
  children,
}: {
  pace: CommitmentPace;
  /** The commitment's label colour, as a left edge — same treatment as a task. */
  color?: string | null;
  onToggleImportant: () => void;
  /** Task cards belonging to this commitment. */
  children?: ReactNode;
}) {
  const pct = pace.fractionDone == null ? null : Math.round(pace.fractionDone * 100);
  const hrs = (min: number) => `${+(min / 60).toFixed(1)}h`;

  return (
    <div
      className="rounded-md border border-border bg-surface px-2.5 py-2 flex flex-col gap-1.5"
      style={color ? { borderLeft: `3px solid ${color}` } : undefined}
    >
      <div className="flex items-start gap-1.5">
        <div className="flex-1 min-w-0 text-[12px] text-text leading-snug">{pace.title}</div>
        <button
          onClick={onToggleImportant}
          title={pace.important ? "Not important" : "Mark important"}
          className="flex-none text-muted-2 hover:text-accent-text"
        >
          <StarIcon size={12} weight={pace.important ? "fill" : "regular"} />
        </button>
      </div>

      {/* Progress against the estimate. Omitted entirely without one — a bar at
          0% would imply nothing had been done rather than nothing being known. */}
      {pct != null && (
        <div className="flex items-center gap-1.5">
          <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: "rgba(233,233,237,0.12)" }}>
            <div
              className="h-full rounded-full"
              style={{ width: `${pct}%`, background: pace.status === "slipping" ? "#e0a94e" : "#9184d9" }}
            />
          </div>
          <span className="flex-none text-[9.5px] text-muted-2">
            {hrs(pace.loggedMin)}/{hrs(pace.estimateMin!)}
          </span>
        </div>
      )}

      <div className="text-[9.5px] text-muted-2 leading-snug">{paceSentence(pace)}</div>

      {children && <div className="flex flex-col gap-1 pt-0.5">{children}</div>}
    </div>
  );
}
