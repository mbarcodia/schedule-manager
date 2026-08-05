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
import { missingList, paceSentence } from "@/lib/scheduling/pace";
import type { CommitmentStreak } from "@/lib/scheduling/streaks";
import type { ReactNode } from "react";

export function CommitmentCard({
  pace,
  streak,
  projectedTotalMin,
  color,
  targetCount = 0,
  onToggleImportant,
  onOpen,
  children,
}: {
  pace: CommitmentPace;
  /** Week-by-week consistency against the weekly minimum, oldest mark first. */
  streak?: CommitmentStreak | null;
  /** Where the effort is really heading, from how many phases are done. Shown
   * only when it disagrees with the estimate — agreeing with it is not news. */
  projectedTotalMin?: number | null;
  /** The commitment's label colour, as a left edge — same treatment as a task. */
  color?: string | null;
  /** How many dates the commitment carries, for the footer's own words. */
  targetCount?: number;
  onToggleImportant: () => void;
  /** Opens the panel holding the inputs pace names as missing. */
  onOpen?: () => void;
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

      {/* Consistency: the lead measure, and the one actually under your control
         each week. Filled = minimum met, hollow = missed, dash = a week nothing
         was logged anywhere (travel), blank = before this existed. */}
      {/* Only when there's something to read: an account with no logged history
         yet would otherwise show a row of dashes meaning nothing. */}
      {streak && streak.marks.some((m) => m === "hit" || m === "missed") && (
        <div className="flex items-center gap-1.5" title="Last 8 weeks against this weekly minimum">
          <span className="text-[9px] tracking-[0.15em] leading-none text-muted">
            {streak.marks.map((m) => (m === "hit" ? "●" : m === "missed" ? "○" : m === "skipped" ? "–" : " ")).join(" ")}
          </span>
          <span className="flex-none text-[9.5px] text-muted-2">
            {streak.current > 0
              ? `${streak.current} wk streak`
              : streak.best > 0
                ? `best ${streak.best}`
                : ""}
          </span>
        </div>
      )}

      <div className="text-[9.5px] text-muted-2 leading-snug">{paceSentence(pace)}</div>

      {projectedTotalMin != null && pace.estimateMin != null && projectedTotalMin > pace.estimateMin * 1.15 && (
        <div className="text-[9.5px]" style={{ color: "#e0a94e" }}>
          Phases done so far imply ~{Math.round(projectedTotalMin / 60)}h in total, not{" "}
          {Math.round(pace.estimateMin / 60)}h.
        </div>
      )}

      {/* The sentence above names what's missing; this is where it gets fixed.
          Worded as the thing it opens rather than as "edit", and it leads with
          the gap when there is one — the card is the first place the gap is
          seen, so it should be the first place it can be closed. */}
      {onOpen && (
        <button
          onClick={onOpen}
          className="self-start text-[9.5px] text-muted-2 hover:text-text"
          style={pace.status === "unmeasurable" ? { color: "#e0a94e" } : undefined}
        >
          {pace.status === "unmeasurable"
            ? `set ${missingList(pace.missing)} ▸`
            : targetCount > 0
              ? `${targetCount} date${targetCount > 1 ? "s" : ""} along the way ▸`
              : "hours and dates ▸"}
        </button>
      )}

      {children && <div className="flex flex-col gap-1 pt-0.5">{children}</div>}
    </div>
  );
}
