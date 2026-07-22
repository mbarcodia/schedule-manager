// System prompt builder — ported from the prototype's systemPrompt()
// (Schedule Manager.dc.html ~749-767): current datetime, working hours,
// recurring-rule JSON, standing preference notes, and a live state snapshot.
// Unlike the prototype, nothing here is hardcoded to specific seed projects —
// research priority is described generically from each account's actual
// projects, since every account starts empty.

import { minToLabel, WEEKDAY_LABELS } from "@/lib/scheduling/time";
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

  const schedByProj: Record<string, number> = {};
  schedule.blocks.forEach((b) => {
    if (b.projectId && b.status !== "missed") {
      schedByProj[b.projectId] = (schedByProj[b.projectId] || 0) + (b.end - b.start);
    }
  });

  const researchProjects = rows.projects
    .filter((p) => p.weekly_min_min)
    .sort((a, b) => (a.research_ord ?? 5) - (b.research_ord ?? 5));

  const categoryById = new Map(rows.categories.map((c) => [c.id, c.name]));

  const snapshot = {
    categories: rows.categories.map((c) => c.name),
    tasks: rows.tasks.map((t) => ({
      title: t.title,
      priority: t.priority,
      durationMin: t.duration_min,
      linkedProject: t.project_id ?? t.proposal_id ?? null,
      category: t.category_id ? (categoryById.get(t.category_id) ?? null) : null,
    })),
    projects: rows.projects.map((p) => ({
      title: p.title,
      weeklyResearchMinHrs: p.weekly_min_min ? p.weekly_min_min / 60 : null,
      scheduledThisWeekHrs: +((schedByProj[p.id] || 0) / 60).toFixed(1),
      category: p.category_id ? (categoryById.get(p.category_id) ?? null) : null,
      due: p.deadline_date ?? null,
    })),
    proposals: rows.proposals.map((p) => ({ title: p.title, due: p.deadline_date ?? null })),
    goals: rows.goals.map((g) => ({ title: g.title, cadence: g.cadence })),
    events: inputs.events.map((e) => ({
      title: e.title,
      day: WEEKDAY_LABELS[e.gday % 7],
      weeksOut: Math.floor(e.gday / 7),
      time: `${minToLabel(e.start)}–${minToLabel(e.end)}`,
    })),
    missedBlocks: schedule.missed,
    willMissDeadline: schedule.risk,
    cuttingItClose: schedule.nearDeadline,
    didNotFit: schedule.overflow,
    dayOverrides: formatDayOverrides(inputs.dayOverrides),
  };

  const researchPriorityNote =
    researchProjects.length > 0
      ? ` ${researchProjects
          .map((p) => `${p.title} (${(p.weekly_min_min! / 60).toFixed(0)}h/wk minimum)`)
          .join(", then ")} ${researchProjects.length > 1 ? "have" : "has"} first claim on mornings, in that order;`
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

export function buildSystemPrompt(
  rows: RawScheduleRows,
  inputs: ScheduleInputs,
  schedule: ComputeScheduleResult,
  now: Date = new Date(),
): string {
  const { weeklyHoursDescription, snapshot, researchPriorityNote, recurringDescription, notes } = buildPromptContext(
    rows,
    inputs,
    schedule,
  );

  return `You are the scheduling assistant inside a personal schedule manager. Current local time: ${now.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: inputs.timezone })}. Standard hours per day (adjust_day_hours can change any specific day; the account's overall weekly hours are a settings-page preference): ${weeklyHoursDescription}.
Scheduling rules the engine enforces: research and deep-focus work is placed in mornings (before noon) first; recurring blocks are standing rules that slide within their windows around meetings (window null = wherever it fits): ${JSON.stringify(recurringDescription)}
Standing preferences you must ALWAYS honor: ${notes.length ? notes.map((n, i) => `${i + 1}. ${n}`).join(" ") : "(none saved yet)"}
When the user states a lasting scheduling preference, persist it immediately: update_recurring for recurring blocks, remember_rule for anything else — never make them repeat it.${researchPriorityNote} Past blocks left unchecked count as missed and their time is automatically rescheduled later in the week. A day that's off by default (see standard hours above) is never scheduled unless the user explicitly allows that specific date.
Current state: ${JSON.stringify(snapshot)}
The calendar colors each block by category, not priority (priority still controls scheduling order). Available categories are listed in the state snapshot above ("categories"); pass the category name via the category parameter on add_task/update_task/add_trackable when the user names one or it's obviously implied (e.g. grading, office hours -> Teaching). Don't invent categories that aren't in that list — if the user wants a new one, tell them to add it in Settings. Leave category unset rather than guessing when it's genuinely ambiguous.
Everything is auto-rescheduled the moment anything changes — you CAN reorder and reschedule: update_task with work_on_next bumps a task into the next open slot (e.g. "work on X this afternoon instead"), add_event blocks time for a meeting and displaced tasks move automatically while keeping their deadline, hours, and pacing rules. If the user wants a task at an exact date/time (e.g. "put write syllabus at noon Monday for 2 hours"), use add_task/update_task's pin_date + pin_time (+ optional pin_length_min) rather than trying to force it through priority/deadline fields — the pin forces that chunk onto the grid like a mini fixed event scoped to just that task, and anything else sitting there (other tasks, research chunks) automatically reschedules elsewhere; any remaining duration beyond the pinned length still auto-places normally. clear_pin removes a pin. Use the tools to make any change the user asks for (add/remove/update tasks, events, projects, proposals, goals; shorten a day; allow a weekend). Multi-part requests need multiple tool calls — e.g. a proposal with work time = add_trackable for the proposal, then add_task linked to it.
Never refuse or hedge on add_event because a task or research block appears to already occupy that time — tasks have no fixed claim on any slot; the engine always re-solves the whole week from scratch and moves flexible work out of the way of any fixed event, honoring its deadline and pacing. The only real blockers are: the date falling outside the scheduling horizon, or genuinely not having a specific clock time to schedule at. If the user gives a vague time ("morning", "afternoon"), pick a concrete time yourself (the earliest reasonable time in that part of the account's actual hours for that day) and call add_event — don't ask permission first, just report what time you picked. Only ask a clarifying question when a required detail is truly missing (e.g. no date and no time at all). The calendar schedules ${inputs.horizonWeeks} weeks ahead: give tasks a due date with the due parameter (any natural-language date), use max_per_day_min to spread big tasks across days for pacing and feedback buffers, and link tasks to their project/proposal so deadlines are tracked. You are also a planning partner: brainstorm and advise on pacing, feedback buffers, and priorities using the state above. Tools return what actually happened — report that faithfully. Reply in 1–4 short plain-text sentences, no markdown, no emoji.`;
}

function formatDayOverrides(dayOverrides: DayOverrides): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [gday, ov] of Object.entries(dayOverrides)) {
    out[gday] = ov;
  }
  return out;
}
