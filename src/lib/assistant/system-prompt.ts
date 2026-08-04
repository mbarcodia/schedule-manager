// Builds the live state snapshot the chat sees every turn: current datetime,
// working hours, routines, standing preference notes, and the account's own
// projects and tasks. Nothing is hardcoded to particular projects —
// morning priority is described from whatever the account actually has, since
// every account starts empty.
//
// The snapshot speaks the user's vocabulary (projects / tasks / routines /
// labels / targets) so the chat and the screen agree. A project is one thing
// with optional facets — weekly hours, a deadline, a cadence, an active window —
// and targets are the dated checkpoints inside it that carry no hours.

import { minToLabel, WEEKDAY_LABELS } from "@/lib/scheduling/time";
import { resolveDayWindow } from "@/lib/scheduling/day-window";
import { allDayDueDate } from "@/lib/scheduling/all-day-due";
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
  // A task reported its project as a raw UUID, which told the model nothing —
  // it could see that a task was linked but not to what, so it described linked
  // tasks as unlinked.
  const projectTitleById = new Map(rows.projects.map((p) => [p.id, p.title]));

  // Soft WIP accounting for the kanban board's In Progress column — surfaced
  // in the snapshot so the planner can push back on starting new tasks while
  // over the limit (same spirit as flagging overcommitted deadlines).
  const boardIndex = deriveBoardStatuses(schedule);
  const wipInProgressCount = rows.tasks.filter((t) => boardStatusFor(boardIndex, t.id) === "in_progress").length;

  const snapshot = {
    wip: {
      inProgressCount: wipInProgressCount,
      limit: DEFAULT_WIP_LIMIT,
      overLimit: wipInProgressCount > DEFAULT_WIP_LIMIT,
    },
    // Names alone were enough while a label was only a colour. It now carries
    // scheduling settings, and the model needs them to explain why a block
    // landed where it did — or to say that labelling work Deep focus will move
    // it to a morning.
    labels: rows.categories.map((c) => ({
      name: c.name,
      minChunkMin: c.min_chunk_min ?? null,
      timeOfDay: c.time_pref ?? null,
      weeklyTargetPct: c.weekly_target_pct ?? null,
    })),
    /** Where a label with a weekly share target actually stands this week.
     * capacityHrs is the working time left after meetings, away days and
     * routines — the pool the percentage is a share of — so a travel week
     * legitimately has a smaller target rather than a missed one. When planned
     * falls short of target, the per-commitment hours wearing that label are
     * the thing to change; they act as a ratio, not a total. */
    labelTargetsThisWeek: schedule.labelTargets.map((t) => ({
      label: t.label,
      target: `${t.pct}% of ${(t.capacityMin / 60).toFixed(1)}h available = ${(t.targetMin / 60).toFixed(1)}h`,
      plannedHrs: +(t.plannedMin / 60).toFixed(1),
      shortfallHrs: +Math.max(0, (t.targetMin - t.plannedMin) / 60).toFixed(1),
    })),
    // A task's DEADLINE was missing here, which read as the deadline never
    // having been saved: asked about three tasks, the planner reported all
    // three as having no due date while two of them had one in the database.
    // The only deadlines that reached the model were the ones already at risk
    // (willMissDeadline/cuttingItClose below), so a comfortable deadline was
    // indistinguishable from none at all. `important` was missing for the same
    // reason and matters for the same conversation — it is the board's
    // Eisenhower signal, and the planner is told to set it.
    tasks: rows.tasks.map((t) => ({
      title: t.title,
      priority: t.priority,
      durationMin: t.duration_min,
      due: t.deadline_at
        ? t.deadline_all_day
          ? { date: allDayDueDate(t.deadline_at, inputs.timezone), anyTimeThatDay: true }
          : t.deadline_at
        : null,
      notBefore: t.floor_at,
      important: t.important,
      linkedProject: t.project_id ? (projectTitleById.get(t.project_id) ?? null) : null,
      label: t.category_id ? (labelById.get(t.category_id) ?? null) : null,
      timeOfDay: t.time_of_day ?? null,
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
    // An all-day entry is reported as such rather than as a 00:00-00:00 block,
    // and says what it actually blocks. Without this the model saw a
    // midnight-to-midnight event and reasonably concluded the day was gone —
    // then described a conference day as having no working time, when
    // "no_meetings" days are still working days by design.
    events: inputs.events.map((e) => ({
      title: e.title,
      day: WEEKDAY_LABELS[e.gday % 7],
      weeksOut: Math.floor(e.gday / 7),
      ...(e.allDay
        ? {
            allDay: true,
            blocks:
              inputs.allDayBlocks[e.gday] === "away"
                ? "nothing is scheduled this day"
                : "others cannot book this day, but it IS still a working day and tasks are scheduled on it",
          }
        : { time: `${minToLabel(e.start)}–${minToLabel(e.end)}` }),
    })),
    /** Working time genuinely left on each of the next 14 days, after meetings,
     * routines and already-placed tasks. The model was previously inferring this
     * from the event list and getting conference weeks wrong. */
    freeHoursByDay: Array.from({ length: 14 }, (_, i) => {
      const win = resolveDayWindow(i, inputs.weeklyHours, inputs.dayOverrides, inputs.allDayBlocks);
      if (!win) return { day: WEEKDAY_LABELS[i % 7], weeksOut: Math.floor(i / 7), free: "day off" };
      const taken = new Set<number>();
      for (const b of schedule.blocks) {
        if (b.gday !== i || b.allDay) continue;
        for (let m = Math.max(b.start, win.start); m < Math.min(b.end, win.end); m++) taken.add(m);
      }
      let free = 0;
      for (let m = win.start; m < win.end; m++) if (!taken.has(m)) free++;
      return { day: WEEKDAY_LABELS[i % 7], weeksOut: Math.floor(i / 7), free: `${(free / 60).toFixed(1)}h` };
    }),
    missedTimeBlocks: schedule.missed,
    willMissDeadline: schedule.risk,
    cuttingItClose: schedule.nearDeadline,
    didNotFit: schedule.overflow,
    dayOverrides: formatDayOverrides(inputs.dayOverrides),
  };

  // Order only — NOT "first claim on mornings", which was true when the engine
  // forced a morning preference on every weekly-hours block off an internal
  // tag. Where those hours go is now the commitment's own setting (or its
  // label's), so claiming mornings here would contradict the schedule.
  const researchPriorityNote =
    hourlyProjects.length > 0
      ? ` ${hourlyProjects
          .map((p) => `${p.title} (${(p.weekly_min_min! / 60).toFixed(0)}h/wk minimum)`)
          .join(", then ")} compete for time in that order;`
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
