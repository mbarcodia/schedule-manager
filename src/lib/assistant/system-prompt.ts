// Builds the live state snapshot the chat sees every turn: current datetime,
// working hours, routines, standing preference notes, and the account's own
// projects and work. Nothing is hardcoded to particular projects —
// morning priority is described from whatever the account actually has, since
// every account starts empty.
//
// The snapshot speaks the user's vocabulary (projects / work / routines /
// labels / targets) so the chat and the screen agree. A project is one thing
// with optional facets — weekly hours, a deadline, a cadence, an active window —
// and targets are the dated checkpoints inside it that carry no hours.

import { minToLabel, WEEKDAY_LABELS } from "@/lib/scheduling/time";
import { deriveBoardStatuses, boardStatusFor } from "@/lib/planner/board-status";
import { DEFAULT_WIP_LIMIT } from "@/lib/planner/board-constants";
import type { ComputeScheduleResult, DayOverrides } from "@/lib/scheduling/types";
import type { RawScheduleRows } from "@/lib/scheduling/from-db";
import type { ScheduleInputs } from "@/lib/scheduling/types";

/** The schedule-state sections shared by the assistant and planner prompts —
 * extracted so the planner can compose its own behavioral text around the
 * same fresh per-turn snapshot. */
export function buildPromptContext(rows: RawScheduleRows, inputs: ScheduleInputs, schedule: ComputeScheduleResult) {
  const weeklyHoursDescription = WEEKDAY_LABELS.map((label, dow) => {
    const w = inputs.weeklyHours[dow];
    return `${label}: ${w ? `${minToLabel(w.start)}-${minToLabel(w.end)}` : "off"}`;
  }).join(", ");

  // THIS week only (gday 0-6). Without the week filter this summed the whole
  // 12-week horizon and reported it as "scheduled this week", so a project with
  // a 6h/week minimum was described to the model as having 69.5h booked this
  // week — making every judgement about capacity nonsense. The chips in
  // trackables.ts always filtered correctly; this didn't.
  const schedByProject: Record<string, number> = {};
  schedule.blocks.forEach((b) => {
    if (b.projectId && b.status !== "missed" && Math.floor(b.gday / 7) === 0) {
      schedByProject[b.projectId] = (schedByProject[b.projectId] || 0) + (b.end - b.start);
    }
  });

  const hourlyProjects = rows.projects
    .filter((p) => p.weekly_min_min)
    .sort((a, b) => (a.research_ord ?? 5) - (b.research_ord ?? 5));

  const labelById = new Map(rows.categories.map((c) => [c.id, c.name]));

  // Soft WIP accounting for the kanban board's In Progress column — surfaced
  // in the snapshot so the planner can push back on starting new work while
  // over the limit (same spirit as flagging overcommitted deadlines).
  const boardIndex = deriveBoardStatuses(schedule);
  const wipInProgressCount = rows.tasks.filter((t) => boardStatusFor(boardIndex, t.id) === "in_progress").length;

  const snapshot = {
    wip: {
      inProgressCount: wipInProgressCount,
      limit: DEFAULT_WIP_LIMIT,
      overLimit: wipInProgressCount > DEFAULT_WIP_LIMIT,
    },
    labels: rows.categories.map((c) => c.name),
    work: rows.tasks.map((t) => ({
      title: t.title,
      priority: t.priority,
      durationMin: t.duration_min,
      linkedProject: t.project_id,
      label: t.category_id ? (labelById.get(t.category_id) ?? null) : null,
    })),
    // One thing with optional facets — only the ones actually set are reported,
    // so the model sees a project the way the user described it rather than a
    // row full of nulls.
    projects: rows.projects.map((p) => ({
      title: p.title,
      weeklyHrs: p.weekly_min_min ? p.weekly_min_min / 60 : null,
      scheduledThisWeekHrs: +((schedByProject[p.id] || 0) / 60).toFixed(1),
      label: p.category_id ? (labelById.get(p.category_id) ?? null) : null,
      due: p.deadline_date ?? null,
      cadence: p.cadence ?? null,
      hoursPlacedIn: p.time_of_day ?? (p.prefer_morning ? "mornings preferred" : null),
      weeklyHoursActiveFrom: p.active_from ?? null,
      weeklyHoursActiveUntil: p.active_until ?? null,
      targets: rows.targets
        .filter((t) => t.commitment_id === p.id)
        .map((t) => ({ title: t.title, date: t.target_date, done: t.completed_at != null })),
    })),
    events: inputs.events.map((e) => ({
      title: e.title,
      day: WEEKDAY_LABELS[e.gday % 7],
      weeksOut: Math.floor(e.gday / 7),
      time: `${minToLabel(e.start)}–${minToLabel(e.end)}`,
    })),
    missedTimeBlocks: schedule.missed,
    willMissDeadline: schedule.risk,
    cuttingItClose: schedule.nearDeadline,
    didNotFit: schedule.overflow,
    dayOverrides: formatDayOverrides(inputs.dayOverrides),
  };

  const researchPriorityNote =
    hourlyProjects.length > 0
      ? ` ${hourlyProjects
          .map((p) => `${p.title} (${(p.weekly_min_min! / 60).toFixed(0)}h/wk minimum)`)
          .join(", then ")} ${hourlyProjects.length > 1 ? "have" : "has"} first claim on mornings, in that order;`
      : "";

  const recurringDescription = inputs.recurringRules.map((r) => ({
    title: r.title,
    days: r.days.map((d) => WEEKDAY_LABELS[d]).join("/"),
    min: r.length,
    window: r.winStart == null ? "anytime" : `${minToLabel(r.winStart)}-${minToLabel(r.winEnd!)}`,
  }));

  const notes = rows.preferenceNotes.map((n) => n.note);

  return { weeklyHoursDescription, snapshot, researchPriorityNote, recurringDescription, notes };
}

function formatDayOverrides(dayOverrides: DayOverrides): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [gday, ov] of Object.entries(dayOverrides)) {
    out[gday] = ov;
  }
  return out;
}
