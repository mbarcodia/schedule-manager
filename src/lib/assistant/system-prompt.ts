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

import { dateForGday, minToLabel, MONTH_NAMES, WEEKDAY_LABELS, zonedDateKey } from "@/lib/scheduling/time";
import { activeNotesForPrompt } from "@/lib/planner/routine-notes";
import { describeDayFocus } from "@/lib/planner/day-focus-form";
import { resolveDayWindow } from "@/lib/scheduling/day-window";
import { allDayDueDate } from "@/lib/scheduling/all-day-due";
import { computePace, paceSentence } from "@/lib/scheduling/pace";
import { hasReserve, typicalBookableWeekMin, type WeeklyReserve } from "@/lib/scheduling/reserve";
import { computeCalibration, correctEstimate, projectTotalMin } from "@/lib/scheduling/calibration";
import { computeStreaks, streakGlyphs } from "@/lib/scheduling/streaks";
import { deriveBoardStatuses, boardStatusFor } from "@/lib/planner/board-status";
import { DEFAULT_WIP_LIMIT } from "@/lib/planner/board-constants";
import type { ComputeScheduleResult, DayOverrides } from "@/lib/scheduling/types";
import { toTargets } from "@/lib/scheduling/from-db";
import type { RawScheduleRows } from "@/lib/scheduling/from-db";
import type { ScheduleInputs } from "@/lib/scheduling/types";

/** How far out the snapshot lists individual meetings. Past this, only travel
 * and a per-month count survive — see beyondTheNextWeeks. Four weeks covers
 * "this week", "next week" and the fortnight after, which is the range ordinary
 * scheduling questions are about. */
const DETAILED_EVENT_DAYS = 28;

/** Distant weeks reduced to what makes them usable or not: the away/no-meetings
 * entries that decide whether a week can hold work at all, and a count of
 * ordinary meetings per month so a busy month is still visible.
 *
 * Grouped by calendar month rather than by week because that is how the far
 * future gets discussed ("September is packed"), and a multi-day trip stored as
 * one row per day is collapsed back into a single range so a two-week trip costs
 * one line instead of fourteen. */
function summariseDistantEvents(inputs: ScheduleInputs, fromGday: number) {
  const distant = inputs.events.filter((e) => e.gday >= fromGday);
  if (!distant.length) return null;

  const monthOf = (gday: number) => {
    const d = dateForGday(inputs.timezone, gday);
    return { key: `${d.year}-${String(d.month).padStart(2, "0")}`, label: `${MONTH_NAMES[d.month - 1]} ${d.year}` };
  };

  // Consecutive away/no-meetings days under the same title are one trip.
  const blocking = distant
    .filter((e) => e.allDay && inputs.allDayBlocks[e.gday])
    .sort((a, b) => a.gday - b.gday);
  const trips: { title: string; from: number; to: number; blocks: "away" | "no_meetings" }[] = [];
  for (const e of blocking) {
    const mode = inputs.allDayBlocks[e.gday]!;
    const last = trips[trips.length - 1];
    if (last && last.title === e.title && last.blocks === mode && e.gday <= last.to + 1) last.to = e.gday;
    else trips.push({ title: e.title, from: e.gday, to: e.gday, blocks: mode });
  }
  const fmt = (gday: number) => {
    const d = dateForGday(inputs.timezone, gday);
    return `${MONTH_NAMES[d.month - 1]} ${d.day}`;
  };

  const meetingsByMonth: Record<string, number> = {};
  distant.filter((e) => !e.allDay).forEach((e) => {
    const { label } = monthOf(e.gday);
    meetingsByMonth[label] = (meetingsByMonth[label] ?? 0) + 1;
  });

  return {
    travelAndAwayDays: trips.map((t) => ({
      title: t.title,
      dates: t.from === t.to ? fmt(t.from) : `${fmt(t.from)}–${fmt(t.to)}`,
      blocks: t.blocks === "away" ? "nothing is scheduled these days" : "others cannot book, still working days",
    })),
    otherMeetingsPerMonth: meetingsByMonth,
  };
}

/** The schedule-state sections shared by the assistant and planner prompts —
 * extracted so the planner can compose its own behavioral text around the
 * same fresh per-turn snapshot. */
export function buildPromptContext(
  rows: RawScheduleRows,
  inputs: ScheduleInputs,
  schedule: ComputeScheduleResult,
  /** Injectable so "is this routine note still current" is decided against the
   * same instant the rest of the turn's context is built from, rather than a
   * second `new Date()` a few milliseconds later. */
  now: Date = new Date(),
) {
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
    // Not one on hold: nothing is scheduled for it, so listing it as competing
    // for time contradicts snapshot.projects[].onHold in the same payload.
    .filter((p) => p.weekly_min_min && !p.on_hold_at)
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

  // Targets are deliberately absent from ScheduleInputs (the engine must never
  // schedule hours for them), so they come straight from the raw rows — through
  // the shared mapper, since a local copy of it parsed the dates as UTC and
  // reported every target a day early.
  const reserve: WeeklyReserve = {
    expectedMeetingMin: rows.profile.expected_meeting_min_per_week ?? 0,
    miscMin: rows.profile.reserve_misc_min_per_week ?? 0,
  };
  const pace = computePace({
    projects: inputs.projects,
    targets: toTargets(rows.targets),
    loggedByProject: rows.progressFacts?.byProject ?? {},
    weeklyHours: inputs.weeklyHours,
    // So a "go 38h/wk" recommendation carries the fact that no week has 38
    // hours in it — the model repeats these sentences verbatim.
    bookableWeekMin: hasReserve(reserve)
      ? typicalBookableWeekMin(inputs.weeklyHours, inputs.recurringRules, reserve)
      : null,
    now: new Date(),
  });
  const paceById = new Map(pace.map((p) => [p.projectId, p]));
  const facts = rows.progressFacts;
  const calibration = computeCalibration(facts?.finished ?? []);
  const streakById = new Map(
    computeStreaks({
      logged: facts?.logged ?? [],
      commitments: inputs.projects.map((p) => ({
          id: p.id,
          // The remembered rate, or a paused commitment's whole history reads as
          // "nothing to measure against" — see streaks.ts heldSince.
          weeklyMinMin: p.weeklyMinMin ?? p.weeklyMinMinOnHold,
          createdAt: null,
          heldSince: p.onHoldAt ?? null,
        })),
      now: new Date(),
    }).map((s) => [s.projectId, s]),
  );

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
      // The two figures that turn "Research is 1.6h short" into something
      // actionable, and which this mapping used to drop.
      //
      // askedMin vs targetMin separates a week with no room from hours that
      // don't divide into usable blocks — opposite fixes: clear the week, or
      // change a number. Without it the model can only guess which it is.
      askedHrs: +(t.askedMin / 60).toFixed(1),
      // ...and WHICH commitment went quiet. A project whose share came out
      // below its own minimum chunk gets nothing at all rather than an unusable
      // sliver, which is invisible in the label total it disappears from.
      gotNothingThisWeek: t.belowFloor,
    })),
    /** Days whose whole label allocation was handed to one commitment. Present
     * only when the user has set one.
     *
     * The numbers matter more here than anywhere else in this snapshot, because a
     * focus deliberately takes hours off other commitments: `takenFromOthersHrs`
     * is a debt those commitments still carry, and a focus that reads as a success
     * while three of them quietly go short is the exact failure this feature was
     * built out of. `skippedBecause` means it did NOTHING — never report one of
     * those as done. */
    focusedDays: schedule.dayFocus.length
      ? schedule.dayFocus.map((o) => ({
          day: (() => {
            const d = dateForGday(inputs.timezone, o.gday);
            return `${WEEKDAY_LABELS[o.gday % 7]} ${MONTH_NAMES[d.month - 1]} ${d.day}`;
          })(),
          label: o.labelName,
          commitment: o.projectTitle,
          heldHrs: +(o.heldMin / 60).toFixed(1),
          placedHrs: +(o.placedMin / 60).toFixed(1),
          takenFromOthersHrs: +(o.transferredMin / 60).toFixed(1),
          displaced: o.displaced.map((d) => `${d.title} (${+(d.min / 60).toFixed(1)}h)`),
          alsoOnThatDay: [
            ...o.leftoverTo.map((l) => `${l.title} (${+(l.min / 60).toFixed(1)}h — the focus had no work left for it)`),
            ...o.pinnedOthers.map((t) => `${t} (pinned, so it stands)`),
          ],
          skippedBecause: o.skipped,
          sentence: describeDayFocus(o),
        }))
      : null,
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
      // The placement constraints, for exactly the reason the deadlines above
      // were added: the model is told to SET these and could not SEE them. A
      // task locked to one day looked identical to a free one, so the honest
      // answer to "why is this in three pieces on Thursday?" wasn't available —
      // and a helpful suggestion to re-chunk it would have contradicted a rule
      // the user had set. Omitted when unset so an ordinary task stays quiet.
      ...(t.split_mode && t.split_mode !== "free" ? { splitMode: t.split_mode } : {}),
      ...(t.min_chunk_min ? { minChunkMin: t.min_chunk_min } : {}),
      ...(t.max_per_day_min ? { maxPerDayMin: t.max_per_day_min } : {}),
    })),
    // One thing with optional facets — only the ones actually set are reported,
    // so the model sees a project the way the user described it rather than a
    // row full of nulls.
    projects: rows.projects.map((p) => ({
      title: p.title,
      important: p.important || undefined,
      // Reported as a state, not as absent hours. Without this the model reads a
      // paused commitment as one somebody forgot to configure and offers to fix
      // it — which is precisely what the user asked it to stop doing.
      onHold: p.on_hold_at
        ? `on hold since ${p.on_hold_at.slice(0, 10)} — nothing is scheduled for it or its tasks, and it claims no share of its label's week. Its weekly hours (${p.weekly_min_min ? `${p.weekly_min_min / 60}h/wk` : "none set"}) are kept for when it resumes. Do NOT treat its empty fields as gaps to fill, and do not schedule work for it unless asked to take it off hold.`
        : undefined,
      totalEffortHrs: p.effort_estimate_min ? p.effort_estimate_min / 60 : null,
      pace: paceById.get(p.id) ? paceSentence(paceById.get(p.id)!) : null,
      /** Last 8 weeks against this commitment's weekly minimum, oldest first:
       * ● met, ○ missed, – nothing logged anywhere that week (treated as time
       * off rather than a failure), blank before it existed. */
      weeklyConsistency: streakById.get(p.id)?.marks.some((m) => m === "hit" || m === "missed")
        ? {
            marks: streakGlyphs(streakById.get(p.id)!.marks),
            currentStreak: streakById.get(p.id)!.current,
            bestStreak: streakById.get(p.id)!.best,
          }
        : null,
      /** Where the effort is really heading, from the share of phases done.
       * Derived from phases rather than hours, since projecting hours from hours
       * is circular. Worth raising when it exceeds the estimate. */
      projectedTotalHrs: (() => {
        const mine = rows.targets.filter((t) => t.commitment_id === p.id);
        const proj = projectTotalMin(
          facts?.byProject[p.id] ?? 0,
          mine.length,
          mine.filter((t) => t.completed_at).length,
        );
        return proj == null ? null : +(proj / 60).toFixed(1);
      })(),
      weeklyHrs: p.weekly_min_min ? p.weekly_min_min / 60 : null,
      scheduledThisWeekHrs: +((schedByProject[p.id] || 0) / 60).toFixed(1),
      label: p.category_id ? (labelById.get(p.category_id) ?? null) : null,
      due: p.deadline_date ? { date: p.deadline_date, kind: p.deadline_kind } : null,
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
    // gday >= 0 as well as the cap: the row window now reaches four weeks BACK so
    // the calendar can be scrolled there, and a past event has a negative gday —
    // which is trivially under the cap, so without this the chat would be handed
    // a month of meetings that already happened, on every single turn.
    events: inputs.events.filter((e) => e.gday >= 0 && e.gday < DETAILED_EVENT_DAYS).map((e) => ({
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
    /** Everything past the detailed window above, summarised.
     *
     * This snapshot is rebuilt and re-sent on EVERY turn, so listing each
     * meeting across the whole horizon put a wall of them in front of every
     * message — already 77% of the snapshot at a 12-week horizon, and it grows
     * with the horizon. What long-range planning actually needs from a distant
     * week is whether it is usable at all, which is travel and away days, plus
     * enough of a count to see that a month is busy. Individual 1:1s in October
     * are not worth re-sending while answering a question about this week.
     *
     * Ask for the detail when it's needed: get_status takes a date range. */
    beyondTheNextWeeks: summariseDistantEvents(inputs, DETAILED_EVENT_DAYS),
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
    /** Not a capacity problem: these start later than the horizon reaches, so
     * no hours have been placed for them yet. Say that, don't call them work
     * that didn't fit. */
    startsBeyondThePlannedHorizon: schedule.beyondHorizon,
    dayOverrides: formatDayOverrides(inputs.dayOverrides),
    /** How wrong this account's estimates have run, measured on finished work.
     *
     * Use it when PROPOSING a duration or a total effort figure: say the number
     * asked for, say what similar work actually took, and propose the corrected
     * one. Never silently store a different number than the one the user gave —
     * an estimate they chose is information too, and quietly rewriting it makes
     * every later comparison meaningless. Null until there is enough finished
     * work to mean anything, in which case say nothing about it. */
    estimateCalibration: calibration.summary
      ? {
          summary: calibration.summary,
          factor: calibration.factor,
          example: `an 8h estimate would more realistically be ${+(correctEstimate(480, calibration.factor) / 60).toFixed(2)}h`,
        }
      : null,
    /** What the board cannot answer yet, and why.
     *
     * The boards are only as informative as what has been filled in, and an
     * under-specified one looks identical to a quiet week: Priorities puts
     * everything in one quadrant when nothing is marked important, the Progress
     * board can't judge a commitment with no effort estimate, and the Timeline
     * has nothing to plot for a commitment with no date. Reporting the gaps
     * here means raising them in a planning session instead of describing the
     * board as complete. Ask about these; don't fill them in by guessing. */
    whatIsThin: (() => {
      const gaps: string[] = [];
      // An ON HOLD commitment is not thin — it is a decision. Reporting its
      // empty fields as gaps is how the chat came to keep asking about work the
      // user had already told it they were not doing.
      const live = rows.projects.filter((p) => !p.on_hold_at);
      const hourly = live.filter((p) => p.weekly_min_min);
      const noEstimate = hourly.filter((p) => !p.effort_estimate_min);
      const noDate = live.filter(
        (p) => !p.deadline_date && !rows.targets.some((t) => t.commitment_id === p.id),
      );
      const noTasks = hourly.filter((p) => !rows.tasks.some((t) => t.project_id === p.id));
      if (noEstimate.length)
        gaps.push(
          `${noEstimate.length} commitment(s) carry weekly hours but no total-effort estimate, so their pace cannot be computed: ${noEstimate.map((p) => p.title).join(", ")}`,
        );
      if (noDate.length)
        gaps.push(
          `${noDate.length} commitment(s) have no date of any kind, so nothing counts down and they cannot appear on the timeline: ${noDate.map((p) => p.title).join(", ")}`,
        );
      if (!live.some((p) => p.important) && !rows.tasks.some((t) => t.important))
        gaps.push("nothing is marked important, so the Priorities board puts everything in one quadrant");
      if (noTasks.length)
        gaps.push(
          `${noTasks.length} commitment(s) have weekly hours but no concrete tasks under them, so there is nothing to check off: ${noTasks.map((p) => p.title).join(", ")}`,
        );
      return gaps.length ? gaps : null;
    })(),
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

  // Today in the ACCOUNT's timezone, which is the only zone in which "has this
  // note expired" has a correct answer. query-rows deliberately over-fetches by a
  // day because it doesn't know the zone yet; this is where that slack is cut.
  const todayKey = zonedDateKey(inputs.timezone, now);
  const routineNotes = rows.routineNotes ?? [];

  const recurringDescription = inputs.recurringRules.map((r) => ({
    title: r.title,
    days: r.days.map((d) => WEEKDAY_LABELS[d]).join("/"),
    min: r.length,
    // What the user wants to do in THIS week's run of it, when they've said.
    // Present only while the note's window covers today, so nothing has to be
    // cleaned up and an old intention can't come back as a current one. Absent
    // rather than empty when there's nothing, to keep the common case free.
    ...(() => {
      const active = activeNotesForPrompt(routineNotes, r.id, todayKey);
      return active.length ? { notesForNow: active } : {};
    })(),
    // An anchored routine has no clock time — saying one would invite the model
    // to quote a number that changes with the day's hours.
    window:
      r.anchor === "day_start"
        ? "first thing in the day (moves with the day's hours; nothing scheduled before it)"
        : r.anchor === "day_end"
          ? "last thing in the day (moves with the day's hours)"
          : r.winStart == null
            ? "anytime"
            : `${minToLabel(r.winStart)}-${minToLabel(r.winEnd!)}`,
  }));

  const notes = rows.preferenceNotes.map((n) => n.note);

  // What the week is NOT available for. Given as the two assumptions AND the
  // figure they come to, because the useful question is almost always "does this
  // fit" and answering it from the gross weekly hours is how a plan comes to be
  // agreed that no week could have held. Absent when the account keeps none.
  const capacityNote = hasReserve(reserve)
    ? {
        expectedMeetingsPerWeek: `${+(reserve.expectedMeetingMin / 60).toFixed(1)}h (only the part not already booked is held back)`,
        keptUnbookedPerWeek: `${+(reserve.miscMin / 60).toFixed(1)}h`,
        typicalBookableWeek: `${+(typicalBookableWeekMin(inputs.weeklyHours, inputs.recurringRules, reserve) / 60).toFixed(1)}h of flexible work in a normal week, after routines, expected meetings and the reserve`,
        howToUseIt:
          "Judge feasibility against typicalBookableWeek, not against the standard hours. These are advisory — the engine still fills the week — so say plainly when a plan only fits by eating into them.",
      }
    : null;

  return { weeklyHoursDescription, snapshot, researchPriorityNote, recurringDescription, notes, capacityNote };
}

function formatDayOverrides(dayOverrides: DayOverrides): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [gday, ov] of Object.entries(dayOverrides)) {
    out[gday] = ov;
  }
  return out;
}
