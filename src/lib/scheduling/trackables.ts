// Trackables-strip view model — ported from the prototype's renderVals()
// trackables mapping (Schedule Manager.dc.html ~1211-1247).

import { availableCapacity } from "@/lib/assistant/status";
import type { ComputeScheduleResult, Project, Task, WeeklyHours } from "@/lib/scheduling/types";

export interface TrackableChip {
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
): TrackableChip[] {
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
      const under = sched < c.weeklyMinMin;
      const windowNote =
        c.activeFromAbs != null || c.activeUntilAbs != null ? " · only inside its active window" : "";
      chips.push({
        projectId: c.id,
        facet: "weekly",
        title: c.title,
        statusText: `${(sched / 60).toFixed(1)}h / ${c.weeklyMinMin / 60}h wk`,
        statusColor: under ? "#d2cefd" : "#9397ab",
        statusWeight: under ? "600" : "500",
        border: under ? "#9184d9" : "rgba(233,233,237,0.16)",
        bg: under ? "rgba(145,132,217,0.12)" : "#1d1f2b",
        tooltip: `Weekly minimum ${c.weeklyMinMin / 60}h${
          c.timeOfDay ? ` · ${c.timeOfDay}s` : c.preferMorning ? " · mornings first" : ""
        }${windowNote}`,
      });
    }
    if (c.deadlineDate) {
      chips.push(deadlineChip(c.id, c.title, c.deadlineDate, tasks, today, weeklyHours));
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
 * — a project without a date produces a cadence chip instead. */
function deadlineChip(
  projectId: string,
  title: string,
  deadlineDate: Date,
  tasks: Task[],
  today: Date,
  weeklyHours: WeeklyHours,
): TrackableChip {
  const capacity = availableCapacity(today, deadlineDate, weeklyHours);
  const days = capacity?.days ?? 0;
  const neededMin = tasks.filter((t) => t.projectId === projectId).reduce((s, t) => s + t.duration, 0);
  const availableMin = capacity?.minutes ?? 0;
  const atRisk = neededMin > availableMin * 0.85;
  return {
    projectId,
    facet: "deadline",
    title,
    statusText: atRisk ? `At risk · ${days}d left` : `On track · ${days}d left`,
    statusColor: atRisk ? "#d2cefd" : "#9397ab",
    statusWeight: atRisk ? "600" : "500",
    border: atRisk ? "#9184d9" : "rgba(233,233,237,0.16)",
    bg: atRisk ? "rgba(145,132,217,0.12)" : "#1d1f2b",
    tooltip: `Due ${deadlineDate.toLocaleDateString()}`,
  };
}
