// Deadline-feasibility and research-progress status text — ported from the
// prototype's trackableStatus()/statusReply()/businessDaysUntil() (Schedule
// Manager.dc.html ~494-542), adapted for per-weekday working hours instead of
// one global window.

import type { ComputeScheduleResult, Task, WeeklyHours } from "@/lib/scheduling/types";

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const BREAK_ALLOWANCE_MIN = 75; // lunch/breaks carved out of each working day

export function formatDate(d: Date): string {
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

/** Walks each calendar day between today and the deadline, counting only
 * days that are "on" per the account's weekly hours (so a custom day-off,
 * not just Sat/Sun, correctly doesn't count) and summing that day's
 * capacity (hours minus a break allowance). Day-specific overrides aren't
 * factored in here — this is a planning estimate, not the engine itself. */
export function availableCapacity(
  today: Date,
  deadlineDate: Date | null,
  weeklyHours: WeeklyHours,
): { days: number; minutes: number } | null {
  if (!deadlineDate) return null;
  let days = 0;
  let minutes = 0;
  const d = new Date(today);
  while (d < deadlineDate) {
    d.setDate(d.getDate() + 1);
    const dow = (d.getDay() + 6) % 7; // JS Sun=0..Sat=6 -> our Mon=0..Sun=6
    const window = weeklyHours[dow];
    if (window) {
      days++;
      minutes += Math.max(0, window.end - window.start - BREAK_ALLOWANCE_MIN);
    }
  }
  return { days, minutes };
}

export interface TrackableLike {
  id: string;
  title: string;
  deadlineDate: Date | null;
  weeklyMinMin?: number | null;
  preferMorning?: boolean;
}

export function statusReply(
  item: TrackableLike,
  today: Date,
  weeklyHours: WeeklyHours,
  tasks: Task[],
  schedule?: ComputeScheduleResult,
): string {
  if (item.weeklyMinMin && schedule) {
    const sched = schedule.blocks
      .filter((b) => b.projectId === item.id && b.status !== "missed" && Math.floor(b.gday / 7) === 0)
      .reduce((s, b) => s + (b.end - b.start), 0);
    const ok = sched >= item.weeklyMinMin;
    return `"${item.title}": ${(sched / 60).toFixed(1)}h of research on the books this week against a ${(item.weeklyMinMin / 60)}h minimum — ${ok ? "target met." : "UNDER TARGET. Want me to free up time?"}${item.preferMorning ? " Mornings get first claim." : ""}`;
  }

  const linked = tasks.filter((t) => t.projectId === item.id);
  const neededMin = linked.reduce((s, t) => s + t.duration, 0);
  if (item.deadlineDate == null) return `"${item.title}" has no deadline tracked.`;

  const capacity = availableCapacity(today, item.deadlineDate, weeklyHours);
  const dateStr = formatDate(item.deadlineDate);
  if (capacity == null) return `"${item.title}" is due ${dateStr}.`;

  const { days, minutes: availableMin } = capacity;
  const atRisk = neededMin > availableMin * 0.85;
  const neededHrs = (neededMin / 60).toFixed(1);
  const availHrs = (availableMin / 60).toFixed(1);

  if (atRisk) {
    return `At risk: "${item.title}" needs ~${neededHrs}h across ${days} working day${days === 1 ? "" : "s"} before ${dateStr}, but you only have ~${availHrs}h of capacity. Want me to free up time or push a lower-priority task?`;
  }
  return `On track: "${item.title}" needs ~${neededHrs}h, you have ~${availHrs}h before ${dateStr} (${days} working day${days === 1 ? "" : "s"} left).`;
}
