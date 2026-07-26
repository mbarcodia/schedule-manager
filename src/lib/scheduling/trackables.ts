// Trackables-strip view model — ported from the prototype's renderVals()
// trackables mapping (Schedule Manager.dc.html ~1211-1247).

import { availableCapacity } from "@/lib/assistant/status";
import type { ComputeScheduleResult, Goal, Project, Proposal, Task, WeeklyHours } from "@/lib/scheduling/types";

export interface TrackableChip {
  kind: string;
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
  proposals: Proposal[],
  goals: Goal[],
  tasks: Task[],
  schedule: ComputeScheduleResult,
  today: Date,
  weeklyHours: WeeklyHours,
): TrackableChip[] {
  const schedByProj: Record<string, number> = {};
  schedule.blocks.forEach((b) => {
    if (b.projectId && b.status !== "missed" && Math.floor(b.gday / 7) === 0) {
      schedByProj[b.projectId] = (schedByProj[b.projectId] || 0) + (b.end - b.start);
    }
  });

  const chips: TrackableChip[] = [];

  for (const p of projects) {
    if (p.weeklyMinMin) {
      const sched = schedByProj[p.id] || 0;
      const under = sched < p.weeklyMinMin;
      chips.push({
        kind: "Project",
        title: p.title,
        statusText: `${(sched / 60).toFixed(1)}h / ${(p.weeklyMinMin / 60)}h wk`,
        statusColor: under ? "#d2cefd" : "#9397ab",
        statusWeight: under ? "600" : "500",
        border: under ? "#9184d9" : "rgba(233,233,237,0.16)",
        bg: under ? "rgba(145,132,217,0.12)" : "#1d1f2b",
        tooltip: `Weekly minimum ${(p.weeklyMinMin / 60)}h${p.preferMorning ? " · mornings first" : ""}`,
      });
      continue;
    }
    chips.push(deadlineChip("Project", p.id, p.title, p.deadlineDate ?? null, tasks, today, weeklyHours));
  }

  for (const p of proposals) {
    chips.push(deadlineChip("Proposal", p.id, p.title, p.deadlineDate ?? null, tasks, today, weeklyHours));
  }

  for (const g of goals) {
    chips.push({
      kind: "Goal",
      title: g.title,
      statusText: g.cadence,
      statusColor: "#9397ab",
      statusWeight: "500",
      border: "rgba(233,233,237,0.16)",
      bg: "#1d1f2b",
      tooltip: g.cadence,
    });
  }

  return chips;
}

function deadlineChip(
  kind: string,
  id: string,
  title: string,
  deadlineDate: Date | null,
  tasks: Task[],
  today: Date,
  weeklyHours: WeeklyHours,
): TrackableChip {
  if (deadlineDate == null) {
    return {
      kind,
      title,
      statusText: "No deadline",
      statusColor: "#9397ab",
      statusWeight: "500",
      border: "rgba(233,233,237,0.16)",
      bg: "#1d1f2b",
      tooltip: "No deadline set",
    };
  }
  const capacity = availableCapacity(today, deadlineDate, weeklyHours);
  const days = capacity?.days ?? 0;
  const neededMin = tasks.filter((t) => t.projectId === id).reduce((s, t) => s + t.duration, 0);
  const availableMin = capacity?.minutes ?? 0;
  const atRisk = neededMin > availableMin * 0.85;
  return {
    kind,
    title,
    statusText: atRisk ? `At risk · ${days}d left` : `On track · ${days}d left`,
    statusColor: atRisk ? "#d2cefd" : "#9397ab",
    statusWeight: atRisk ? "600" : "500",
    border: atRisk ? "#9184d9" : "rgba(233,233,237,0.16)",
    bg: atRisk ? "rgba(145,132,217,0.12)" : "#1d1f2b",
    tooltip: `Due ${deadlineDate.toLocaleDateString()}`,
  };
}
