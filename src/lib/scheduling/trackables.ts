// Trackables-strip view model — ported from the prototype's renderVals()
// trackables mapping (Schedule Manager.dc.html ~1211-1247).

import { availableCapacity } from "@/lib/assistant/status";
import { paceSentence, type CommitmentPace } from "./pace";
import type { ComputeScheduleResult, Project, Task, WeeklyHours } from "@/lib/scheduling/types";

export interface TrackableChip {
  /** Whether this wants attention — a slipping commitment, or a tight one under a
   * hard date. Read this rather than matching statusText: a caller doing the
   * latter silently counted zero the moment the wording changed. */
  needsAttention?: boolean;
  /** The project this describes. Lookups key on this rather than the title,
   * since one project can produce more than one chip and two projects
   * may share a name. */
  projectId: string;
  /** Which facet the chip is reporting on. A project carrying both weekly
   * hours and a deadline produces one of each — they are independent things to
   * know, and collapsing them hid the deadline. */
  facet: "weekly" | "deadline" | "cadence";
  title: string;
  statusText: string;
  statusColor: string;
  statusWeight: "500" | "600";
  border: string;
  bg: string;
  tooltip: string;
}

export function computeTrackableChips(
  projects: Project[],
  tasks: Task[],
  schedule: ComputeScheduleResult,
  today: Date,
  weeklyHours: WeeklyHours,
  /** Pace per commitment, when the caller has it. Omitted by callers that only
   * want the weekly-hours chips; the deadline chip then says pace is unknown
   * rather than inventing "on track". */
  pace: CommitmentPace[] = [],
): TrackableChip[] {
  const paceById = new Map(pace.map((p) => [p.projectId, p]));
  const schedByProject: Record<string, number> = {};
  schedule.blocks.forEach((b) => {
    if (b.projectId && b.status !== "missed" && Math.floor(b.gday / 7) === 0) {
      schedByProject[b.projectId] = (schedByProject[b.projectId] || 0) + (b.end - b.start);
    }
  });

  const chips: TrackableChip[] = [];

  for (const c of projects) {
    if (c.weeklyMinMin) {
      const sched = schedByProject[c.id] || 0;
      // Under a label share target the declared minutes are a RATIO between
      // commitments, not a weekly total, so the goal for THIS week is the scaled
      // figure the engine actually worked to. Comparing against the declared
      // number instead made a correctly-scheduled commitment look short.
      const scaledGoal = schedule.weeklyTargetMinByProject[c.id];
      const goal = scaledGoal ?? c.weeklyMinMin;
      const scaledByTarget = scaledGoal != null;
      const under = sched < goal;
      const windowNote =
        c.activeFromAbs != null || c.activeUntilAbs != null ? " · only inside its active window" : "";
      const placement = c.timeOfDay
        ? ` · ${c.timeOfDay}s`
        : c.preferMorning
          ? " · mornings first"
          : c.preferAfternoon
            ? " · afternoons first"
            : "";
      // A share of zero means the week is gone to travel, not that hours are
      // missing — saying "0.0h / 0h" invites exactly the wrong reading.
      const statusText = scaledByTarget && goal === 0
        ? "away this week"
        : `${(sched / 60).toFixed(1)}h / ${+(goal / 60).toFixed(2)}h wk`;
      const tooltip = scaledByTarget
        ? `${+(goal / 60).toFixed(2)}h this week — its share of the label's weekly target. ` +
          `The ${c.weeklyMinMin / 60}h set on this commitment is its size relative to the others, ` +
          `not a weekly total, so it scales with how much of the week is actually free${placement}${windowNote}`
        : `Weekly minimum ${c.weeklyMinMin / 60}h${placement}${windowNote}`;
      chips.push({
        projectId: c.id,
        facet: "weekly",
        title: c.title,
        statusText,
        statusColor: under ? "#d2cefd" : "#9397ab",
        statusWeight: under ? "600" : "500",
        border: under ? "#9184d9" : "rgba(233,233,237,0.16)",
        bg: under ? "rgba(145,132,217,0.12)" : "#1d1f2b",
        tooltip,
      });
    }
    if (c.deadlineDate) {
      chips.push(
        deadlineChip(c.id, c.title, c.deadlineDate, c.deadlineKind ?? "hard", paceById.get(c.id), today, weeklyHours),
      );
    }
    // Nothing scheduled and no date: a project that exists to be tracked
    // rather than solved. Cadence describes its rhythm if it has one.
    if (!c.weeklyMinMin && !c.deadlineDate) {
      chips.push({
        projectId: c.id,
        facet: "cadence",
        title: c.title,
        statusText: c.cadence || "no dates set",
        statusColor: "#9397ab",
        statusWeight: "500",
        border: "rgba(233,233,237,0.16)",
        bg: "#1d1f2b",
        tooltip: c.cadence || "No weekly hours and no deadline",
      });
    }
  }

  return chips;
}

/** Callers only reach this with a deadline in hand, so there is no null branch
 * — a project without a date produces a cadence chip instead.
 *
 * This used to decide "on track" by summing the tasks linked to the commitment
 * against the working time before the date. A commitment with no linked tasks
 * therefore needed zero minutes and could never be at risk, so every one of
 * them reported "On track" unconditionally — the most confident-looking part of
 * the screen was measuring nothing at all.
 *
 * It now reports the pace computed in pace.ts, which is honest about being
 * unmeasurable when the effort estimate is missing rather than defaulting to
 * reassurance. */
function deadlineChip(
  projectId: string,
  title: string,
  deadlineDate: Date,
  deadlineKind: "hard" | "goal",
  pace: CommitmentPace | undefined,
  today: Date,
  weeklyHours: WeeklyHours,
): TrackableChip {
  const days = availableCapacity(today, deadlineDate, weeklyHours)?.days ?? 0;
  // The commitment's OWN kind, not pace.nextDateKind — pace is measured against
  // the soonest unmet date, which is often an interim target with a different
  // kind, and using it here labelled a hard deadline as a goal.
  const kind = deadlineKind;
  const status = pace?.status ?? "unmeasurable";
  const flag = status === "slipping" || (status === "on_pace" && kind === "hard");
  const label =
    status === "unmeasurable"
      ? `Pace unknown · ${days}d left`
      : status === "slipping"
        ? `Slipping · ${days}d left`
        : status === "not_started"
          ? `Not started · ${days}d left`
          : status === "ahead"
            ? `Ahead · ${days}d left`
            : `On pace · ${days}d left`;
  return {
    projectId,
    facet: "deadline",
    title,
    statusText: label,
    needsAttention: flag,
    statusColor: flag ? "#d2cefd" : "#9397ab",
    statusWeight: flag ? "600" : "500",
    border: flag ? "#9184d9" : "rgba(233,233,237,0.16)",
    bg: flag ? "rgba(145,132,217,0.12)" : "#1d1f2b",
    tooltip: pace
      ? `${kind === "hard" ? "Hard deadline" : "Goal date"} ${deadlineDate.toLocaleDateString()} — ${paceSentence(pace)}`
      : `Due ${deadlineDate.toLocaleDateString()}`,
  };
}
