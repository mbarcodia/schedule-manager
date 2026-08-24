// Converts raw Supabase rows into the engine's ScheduleInputs shape. Real
// calendar dates/timestamps (deadline_at, floor_at, starts_at, override_date,
// occurred_date) are converted into the current week-relative grid here —
// see the design note at the top of supabase/migrations/0001_init.sql for
// why persistence uses real dates while the engine works in relative minutes.

import { gdayForDate, zonedNow } from "./time";
import { defaultDayWindow } from "./day-window";
import { computePace } from "./pace";
import { ROUTINE_TAG_LABEL } from "./types";
import { HISTORY_WEEKS, HORIZON_WEEKS } from "./horizon";
import type { WeeklyReserve } from "./reserve";
import type { ProgressFacts } from "./logged-hours";
import type {
  CalendarEvent,
  Category,
  DayFocus,
  DayOverrides,
  PinnedEntry,
  Project,
  RecurringRule,
  ResearchPin,
  ScheduleBlock,
  ScheduleInputs,
  Target,
  Task,
  WeeklyHours,
} from "./types";
import type { Database } from "@/lib/supabase/database.types";

type Row<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];

export interface RawScheduleRows {
  profile: Row<"profiles">;
  categories: Row<"categories">[];
  projects: Row<"projects">[];
  targets: Row<"targets">[];
  tasks: Row<"tasks">[];
  /** Id + title of the ARCHIVED tasks, which `tasks` above deliberately omits.
   * Completing a task archives it, so without these every finished piece of
   * work redrew itself on the calendar as the placeholder "Work" the moment it
   * was ticked off — including the whole logged history. Titles only: nothing
   * archived may re-enter scheduling. Optional because a caller that assembles
   * rows by hand still gets the placeholder rather than an error. */
  archivedTaskTitles?: Pick<Row<"tasks">, "id" | "title">[];
  recurringRules: Row<"recurring_rules">[];
  /** Notes attached to those routines whose window covers today or a day still
   * ahead (migration 0044). Optional because nothing in the scheduling engine
   * reads them — they are context for the chat, not an input to placement — so
   * the browser's own fetch path has no reason to carry them. */
  routineNotes?: Row<"routine_notes">[];
  preferenceNotes: Row<"preference_notes">[];
  dayOverrides: Row<"day_overrides">[];
  events: Row<"events">[];
  progressLog: Row<"progress_log">[];
  pinnedChunks: Row<"pinned_chunks">[];
  researchPins: Row<"research_pins">[];
  /** Exact slots tasks are fixed to (migration 0047). Replaced the single
   * `tasks.pinned_date/start/length` triple, which could hold only one slot per
   * task. Optional so a hand-assembled caller means "no pins" rather than
   * crashing. */
  taskPins?: Row<"task_pins">[];
  /** Days where one label's weekly hours all go to one project (migration 0046).
   * Optional for the same reason as routineNotes: the engine tolerates its
   * absence, and not every caller assembles one. */
  dayFocus?: Row<"day_focus">[];
  calendarConnections: Row<"calendar_connections">[];
  /** The one derived field here: everything computed from the FULL work history,
   * which progressLog above cannot give because it is windowed to a fortnight
   * back for done/missed resolution. Feeds pace, estimate calibration and weekly
   * consistency. Optional so callers that don't need it (and the engine, which
   * never does) can leave it out. See logged-hours.ts. */
  progressFacts?: ProgressFacts;
}

function dateParts(iso: string): { year: number; month: number; day: number } {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return { year: y, month: m, day: d };
}

/** A date-only column ("2026-10-30") as a LOCAL calendar date.
 *
 * `new Date("2026-10-30")` is parsed as UTC midnight, which renders as the 29th
 * anywhere west of Greenwich — so a deadline stored as the 30th displayed as the
 * 29th, and a target the user set for Aug 20 showed as Aug 19. These columns are
 * civil dates with no time in them; they must be built in local terms. */
function localDate(iso: string): Date {
  const { year, month, day } = dateParts(iso);
  return new Date(year, month - 1, day);
}

/** A timestamptz converted to this account's timezone, as civil date parts
 * plus minute-of-day — used to place it on the relative grid. */
function timestampToParts(iso: string, timeZone: string) {
  const at = new Date(iso);
  const z = zonedNow(timeZone, at);
  return { year: z.year, month: z.month, day: z.day, minuteOfDay: z.minuteOfDay };
}

const NO_DEADLINE = 99999;

/** Exported because the chat's prompt context needs targets too, and a second
 * copy of this mapping is how target dates went back to being parsed as UTC and
 * displaying a day early. */
export function toTargets(rows: Row<"targets">[]): Target[] {
  return rows.map((t) => ({
    id: t.id,
    projectId: t.commitment_id,
    title: t.title,
    date: localDate(t.target_date),
    completedAt: t.completed_at ? new Date(t.completed_at) : null,
    dateKind: t.date_kind,
    effortEstimateMin: t.effort_estimate_min,
  }));
}

export function buildScheduleInputs(
  rows: RawScheduleRows,
  now: Date = new Date(),
): {
  inputs: ScheduleInputs;
  projects: Project[];
  targets: Target[];
  categories: Category[];
  reserve: WeeklyReserve;
} {
  const timezone = rows.profile.timezone || "UTC";
  const horizonWeeks = HORIZON_WEEKS;

  const categories: Category[] = rows.categories
    .map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      sortOrder: c.sort_order,
      minChunkMin: c.min_chunk_min,
      timePref: c.time_pref,
      weeklyTargetPct: c.weekly_target_pct,
      targetBasis: c.target_basis,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const minChunkFor = (categoryId: string | null | undefined): number | undefined =>
    (categoryId ? categoryById.get(categoryId)?.minChunkMin : undefined) ?? undefined;

  const labelNames: Record<string, string> = {};
  const labelTargetPct: Record<string, number> = {};
  const labelTargetBasis: Record<string, "week" | "after_meetings"> = {};
  categories.forEach((c) => {
    labelNames[c.id] = c.name;
    if (c.weeklyTargetPct) labelTargetPct[c.id] = c.weeklyTargetPct;
    labelTargetBasis[c.id] = c.targetBasis ?? "week";
  });

  /** A label's time preference, split into the two things the engine reads:
   * a hard half-of-day constraint and a soft nudge. The work's OWN setting
   * always wins — a label expresses where this kind of thing usually belongs,
   * and saying so about one piece of work is more specific than saying it
   * about a whole category. */
  const timePrefFor = (
    categoryId: string | null | undefined,
    ownTimeOfDay: "morning" | "afternoon" | null | undefined,
    ownPreferMorning?: boolean,
  ): { timeOfDay: "morning" | "afternoon" | null; preferMorning: boolean; preferAfternoon: boolean } => {
    const pref = categoryId ? categoryById.get(categoryId)?.timePref : null;
    // A hard constraint has nothing to fall back to, so the soft nudges are
    // meaningless alongside one and are dropped rather than left to confuse
    // whoever reads the placement logic next.
    if (ownTimeOfDay) return { timeOfDay: ownTimeOfDay, preferMorning: false, preferAfternoon: false };
    if (pref === "morning_only") return { timeOfDay: "morning", preferMorning: false, preferAfternoon: false };
    if (pref === "afternoon_only") return { timeOfDay: "afternoon", preferMorning: false, preferAfternoon: false };
    return {
      timeOfDay: null,
      preferMorning: !!ownPreferMorning || pref === "prefer_morning",
      preferAfternoon: pref === "prefer_afternoon" && !ownPreferMorning,
    };
  };

  // An active-window bound is a civil date, and the engine works in absolute
  // minutes from the horizon start — so active_from becomes that date's
  // midnight and active_until the END of its day, making both inclusive.
  const dateToAbs = (iso: string, endOfDay: boolean): number => {
    const gday = gdayForDate(timezone, dateParts(iso), now);
    return gday * 1440 + (endOfDay ? 1440 : 0);
  };

  // An on-hold commitment reaches the engine as one carrying NO weekly hours,
  // which is the whole of the mechanism: no chunks are generated for it and it
  // takes no part of its label's share, without the engine needing to know the
  // concept exists. The declared rate travels alongside so the boards can say
  // what it will resume at — deleting it to pause would throw away a decision.
  const projects: Project[] = rows.projects.map((p) => ({
    id: p.id,
    title: p.title,
    deadlineDate: p.deadline_date ? localDate(p.deadline_date) : null,
    weeklyMinMin: p.on_hold_at ? null : p.weekly_min_min,
    onHold: p.on_hold_at != null,
    weeklyMinMinOnHold: p.on_hold_at ? p.weekly_min_min : null,
    onHoldAt: p.on_hold_at ? new Date(p.on_hold_at) : null,
    ...timePrefFor(p.category_id, p.time_of_day, p.prefer_morning),
    activeFromAbs: p.active_from ? dateToAbs(p.active_from, false) : null,
    activeUntilAbs: p.active_until ? dateToAbs(p.active_until, true) : null,
    activeFrom: p.active_from ? localDate(p.active_from) : null,
    activeUntil: p.active_until ? localDate(p.active_until) : null,
    cadence: p.cadence,
    chunk: p.chunk_min,
    minChunk: minChunkFor(p.category_id),
    researchOrd: p.research_ord ?? undefined,
    categoryId: p.category_id,
    effortEstimateMin: p.effort_estimate_min,
    important: p.important,
    deadlineKind: p.deadline_kind,
  }));

  const targets: Target[] = toTargets(rows.targets);

  // Needed before the tasks below, not just by the engine: a date-only
  // deadline's ceiling is the end of that day's working window.
  const weeklyHours: WeeklyHours = {};
  for (let dow = 0; dow < 7; dow++) {
    weeklyHours[dow] = rows.profile.weekly_hours[String(dow)] ?? null;
  }

  // A hold that still booked the tasks underneath would be a distinction without
  // a difference, so they are withheld from the engine too. They stay on the
  // board (which reads rawTasks) — invisible would be a different promise from
  // unscheduled.
  const onHoldProjectIds = new Set(rows.projects.filter((p) => p.on_hold_at).map((p) => p.id));

  // Grouped once rather than filtered per task: a task row is mapped for every
  // task in the account, and re-scanning every pin inside that loop is the kind
  // of quadratic that only shows up on a full calendar.
  const taskPinsByTask = new Map<string, RawScheduleRows["taskPins"]>();
  for (const tp of rows.taskPins ?? []) {
    const list = taskPinsByTask.get(tp.task_id);
    if (list) list.push(tp);
    else taskPinsByTask.set(tp.task_id, [tp]);
  }

  const tasks: Task[] = rows.tasks
    .filter((t) => !(t.project_id && onHoldProjectIds.has(t.project_id)))
    .map((t) => {
    const floorParts = timestampToParts(t.floor_at, timezone);
    const floorGday = gdayForDate(timezone, floorParts, now);
    const floor = Math.max(0, floorGday * 1440 + floorParts.minuteOfDay);

    let deadline = NO_DEADLINE;
    if (t.deadline_at) {
      const dParts = timestampToParts(t.deadline_at, timezone);
      const dGday = gdayForDate(timezone, dParts, now);
      // A date-only deadline ("due August 11") means the end of that working
      // day, not the 23:59 the column stores to mark which day it is. Using
      // the stored minute would be harmless most days and wrong on any day
      // whose hours run late; using the working day's end is what the user
      // means, and it keeps the same-day "no buffer left" warning honest.
      deadline = t.deadline_all_day
        ? dGday * 1440 + (defaultDayWindow(dGday, weeklyHours)?.end ?? 1440)
        : dGday * 1440 + dParts.minuteOfDay;
    }

    // A pin older than the current week is stale — don't forward it, so
    // nothing needs to sweep the table afterward. A pin still within this
    // week but already past NOW flows through normally: the engine's
    // kept/missed reconciliation (same as any other block) picks it up.
    const pins = (taskPinsByTask.get(t.id) ?? []).flatMap((tp) => {
      const pGday = gdayForDate(timezone, dateParts(tp.pinned_date), now);
      if (pGday < 0 || pGday >= horizonWeeks * 7) return [];
      return [{ gday: pGday, start: tp.start_min, length: tp.length_min }];
    });

    return {
      id: t.id,
      title: t.title,
      priority: t.priority,
      duration: t.duration_min,
      chunk: t.chunk_min,
      // The task's own minimum OVERRIDES its label's, in both directions — see
      // migration 0042. Deliberately not `Math.max` of the two: a label's floor
      // is a default for a kind of work, and "this particular job is different"
      // is the entire reason the field exists. The panels warn at the point of
      // setting one shorter, so it is never a silent divergence.
      minChunk: t.min_chunk_min ?? minChunkFor(t.category_id),
      splitMode: t.split_mode,
      ...timePrefFor(t.category_id, t.time_of_day),
      dependsOn: t.depends_on,
      deadline,
      floor,
      maxPerDayMin: t.max_per_day_min,
      projectId: t.project_id,
      categoryId: t.category_id,
      ord: t.ord,
      pins,
    };
  });

  const recurringRules: RecurringRule[] = rows.recurringRules.map((r) => ({
    id: r.id,
    title: r.title,
    days: r.days,
    length: r.length_min,
    winStart: r.win_start_min,
    winEnd: r.win_end_min,
    anchor: r.anchor,
    categoryId: r.category_id,
  }));

  const dayOverrides: DayOverrides = {};
  for (const ov of rows.dayOverrides) {
    const gday = gdayForDate(timezone, dateParts(ov.override_date), now);
    if (gday < -HISTORY_WEEKS * 7 || gday >= horizonWeeks * 7) continue; // outside the visible range
    dayOverrides[gday] = {
      start: ov.start_min ?? undefined,
      end: ov.end_min ?? undefined,
      allowWeekend: ov.allow_weekend,
      closed: ov.closed,
    };
  }

  const connectionById = new Map(rows.calendarConnections.map((c) => [c.id, c]));

  // Which days an all-day entry covers, and what that calendar says it blocks.
  // "away" wins over "no_meetings" if two calendars disagree about the same day:
  // the stricter reading is the safer default when someone has said they're out.
  const allDayBlocks: Record<number, "no_meetings" | "away"> = {};

  // ONE MEETING ON SEVERAL CALENDARS IS ONE MEETING.
  //
  // A meeting invited to two connected accounts arrives down both feeds as two
  // rows, and every reader then treated them as two separate commitments. On
  // screen that draws one block on top of another — which is indistinguishable
  // from the scheduler having double-booked something, and was reported as
  // exactly that. An audit of one real account found 36 overlapping pairs across
  // a 145-day horizon, every one of them meeting-on-meeting, several of them the
  // same standing meeting arriving down four feeds at once.
  //
  // Deduped HERE rather than in the sync, so both rows stay in the database:
  // whichever feed happens to sync first would otherwise decide the surviving
  // row's colour and source, and that would flip between hourly runs.
  //
  // THE KEY IS DELIBERATELY STRICT — identical title, identical start, identical
  // end. Anything looser can hide a meeting that genuinely exists: two same-named
  // slots at different times are a common, real thing (two sections of a class,
  // back-to-back 1:1s), and a calendar that silently drops one is worse than a
  // calendar that draws two. So a copy whose time differs by even a minute
  // survives and stays visible, overlapping, which is the honest rendering of a
  // feed that hasn't caught up with a moved invite.
  //
  // Capacity was never affected either way — freeHoursByDay marks busy MINUTES in
  // a set, so the same minute blocked twice was always just blocked.
  const dedupedRows: typeof rows.events = [];
  /** For each surviving row, the labels of the other calendars carrying it, so
   * the block can say "on 3 calendars" instead of quietly discarding the fact. */
  const alsoOnByRowId = new Map<string, string[]>();
  {
    const seen = new Map<string, string>(); // dedupe key -> surviving row id
    for (const e of rows.events) {
      const key = `${e.title.trim().toLowerCase()}|${e.starts_at}|${e.ends_at}`;
      const keptId = seen.get(key);
      const labelOf = (row: typeof e) =>
        (row.connection_id ? connectionById.get(row.connection_id)?.label : null) ?? "this app";
      if (keptId == null) {
        seen.set(key, e.id);
        dedupedRows.push(e);
        alsoOnByRowId.set(e.id, [labelOf(e)]);
        continue;
      }
      // A duplicate. Record which calendar it also sits on, then decide which of
      // the two rows survives: an event made in THIS APP wins over a synced
      // mirror, because that is the one with a panel that can edit it. Losing
      // that would make a meeting the user created uneditable.
      alsoOnByRowId.get(keptId)!.push(labelOf(e));
      if (!e.connection_id) {
        const at = dedupedRows.findIndex((r) => r.id === keptId);
        const labels = alsoOnByRowId.get(keptId)!;
        alsoOnByRowId.delete(keptId);
        alsoOnByRowId.set(e.id, labels);
        seen.set(key, e.id);
        if (at >= 0) dedupedRows[at] = e;
      }
    }
  }

  const events: CalendarEvent[] = dedupedRows.map((e) => {
    const s = timestampToParts(e.starts_at, timezone);
    const en = timestampToParts(e.ends_at, timezone);
    const gday = gdayForDate(timezone, s, now);
    const connection = e.connection_id ? connectionById.get(e.connection_id) : null;
    // Only worth carrying when there IS more than one; the single-calendar case
    // is almost every event and should cost nothing downstream.
    const onCalendars = alsoOnByRowId.get(e.id) ?? [];
    return {
      id: e.id,
      title: e.title,
      gday,
      start: s.minuteOfDay,
      end: en.minuteOfDay,
      source: e.source,
      description: e.description,
      location: e.location,
      meetingUrl: e.meeting_url,
      connectionColor: connection?.color ?? null,
      connectionLabel: connection?.label ?? null,
      allDay: e.all_day,
      ...(onCalendars.length > 1 ? { onCalendars } : {}),
    };
  });

  for (const row of rows.events) {
    if (!row.all_day || !row.connection_id) continue;
    const mode = connectionById.get(row.connection_id)?.all_day_mode;
    if (mode !== "no_meetings" && mode !== "away") continue;
    const gday = gdayForDate(timezone, timestampToParts(row.starts_at, timezone), now);
    if (gday < 0 || gday >= horizonWeeks * 7) continue;
    if (allDayBlocks[gday] === "away") continue;
    allDayBlocks[gday] = mode;
  }

  // Only entries within the current week matter to the engine — anything
  // computed in prior weeks was already reconciled when that week was
  // "current" and doesn't feed back into future scheduling (see the
  // migration file's design note).
  const completed: Record<string, boolean> = {};
  const partial: Record<string, number> = {};
  for (const p of rows.progressLog) {
    const gday = gdayForDate(timezone, dateParts(p.occurred_date), now);
    if (gday < 0 || gday >= 7) continue;
    const subjectId =
      p.subject_type === "research"
        ? `research-${p.subject_id}-w${Math.floor(gday / 7)}`
        : p.subject_type === "anchor"
          ? `anchor-${p.subject_id}`
          : p.subject_id;
    const key = `${subjectId}@${gday}-${p.start_min}`;
    if (p.minutes_done == null) completed[key] = true;
    else partial[key] = p.minutes_done;
  }

  // Past weeks are a RECORD, not a plan. The scheduler is never run over them —
  // re-deriving a past week from today's rules would put blocks on it that never
  // happened, indistinguishable from the ones that did. So a past day shows only
  // what was logged at the time, built here where the titles can be resolved.
  const taskTitle = new Map([
    ...(rows.archivedTaskTitles ?? []).map((t) => [t.id, t.title] as const),
    ...rows.tasks.map((t) => [t.id, t.title] as const),
  ]);
  const projectTitle = new Map(rows.projects.map((p) => [p.id, p.title]));
  const ruleTitle = new Map(rows.recurringRules.map((r) => [r.id, r.title]));
  const taskById = new Map(rows.tasks.map((t) => [t.id, t]));
  const projectById = new Map(rows.projects.map((p) => [p.id, p]));

  const historyBlocks: ScheduleBlock[] = [];
  for (const p of rows.progressLog) {
    const gday = gdayForDate(timezone, dateParts(p.occurred_date), now);
    // Strictly before this week: from gday 0 on, the engine reconciles progress
    // against the plan it just built, and a second copy would double up.
    if (gday >= 0 || gday < -HISTORY_WEEKS * 7) continue;
    const title =
      p.subject_type === "research"
        ? (projectTitle.get(p.subject_id) ?? "Research")
        : p.subject_type === "anchor"
          ? (ruleTitle.get(p.subject_id) ?? "Routine")
          : (taskTitle.get(p.subject_id) ?? "Work");
    const categoryId =
      p.subject_type === "research"
        ? (projectById.get(p.subject_id)?.category_id ?? null)
        : p.subject_type === "task"
          ? (taskById.get(p.subject_id)?.category_id ?? null)
          : null;
    const projectId =
      p.subject_type === "research" ? p.subject_id : (taskById.get(p.subject_id)?.project_id ?? null);
    // A partial log means only that many minutes were worked, so the block is
    // drawn at the length actually done rather than as it was scheduled.
    const doneMin = p.minutes_done ?? p.end_min - p.start_min;
    if (doneMin <= 0) continue;
    historyBlocks.push({
      type: p.subject_type === "anchor" ? "anchor" : "task",
      taskId: p.subject_id,
      projectId,
      categoryId,
      tagLabel: p.subject_type === "anchor" ? ROUTINE_TAG_LABEL : labelNames[categoryId ?? ""] ?? null,
      title,
      gday,
      start: p.start_min,
      end: p.start_min + doneMin,
      priority: null,
      status: p.minutes_done == null ? "done" : "partial",
      partMin: p.minutes_done ?? null,
      key: `history-${p.subject_type}-${p.subject_id}@${gday}-${p.start_min}`,
      abs: gday * 1440 + p.start_min,
    });
  }

  // The current week's fallback — see ScheduleInputs.currentWeekFallback for
  // why this exists. Same reconstruction as historyBlocks above, just for
  // gday 0-6 and keyed to match `kept`'s own key format exactly (not the
  // `history-` prefix above) so engine.ts can dedupe against it by a plain
  // key lookup.
  //
  // Anchors are deliberately excluded: they never go through taskDefs/pass 1
  // at all — anchorDefs() regenerates one deterministically every run and
  // resolves its own done/missed status directly against `completed`, with no
  // def to lose and nothing that can hold it. Including them here duplicated
  // every ticked routine, since that direct render sits outside `kept` and so
  // never showed up in the dedupe check below.
  const currentWeekFallback: ScheduleBlock[] = [];
  for (const p of rows.progressLog) {
    if (p.subject_type === "anchor") continue;
    const gday = gdayForDate(timezone, dateParts(p.occurred_date), now);
    if (gday < 0 || gday >= 7) continue;
    const subjectId = p.subject_type === "research" ? `research-${p.subject_id}-w${Math.floor(gday / 7)}` : p.subject_id;
    const title = p.subject_type === "research" ? (projectTitle.get(p.subject_id) ?? "Research") : (taskTitle.get(p.subject_id) ?? "Work");
    const categoryId =
      p.subject_type === "research"
        ? (projectById.get(p.subject_id)?.category_id ?? null)
        : p.subject_type === "task"
          ? (taskById.get(p.subject_id)?.category_id ?? null)
          : null;
    const projectId =
      p.subject_type === "research" ? p.subject_id : (taskById.get(p.subject_id)?.project_id ?? null);
    const doneMin = p.minutes_done ?? p.end_min - p.start_min;
    if (doneMin <= 0) continue;
    currentWeekFallback.push({
      type: "task",
      taskId: subjectId,
      projectId,
      categoryId,
      tagLabel: labelNames[categoryId ?? ""] ?? null,
      title,
      gday,
      start: p.start_min,
      end: p.start_min + doneMin,
      priority: null,
      status: p.minutes_done == null ? "done" : "partial",
      partMin: p.minutes_done ?? null,
      key: `${subjectId}@${gday}-${p.start_min}`,
      abs: gday * 1440 + p.start_min,
    });
  }

  const pinned: Record<string, PinnedEntry> = {};
  for (const p of rows.pinnedChunks) {
    const gday = gdayForDate(timezone, dateParts(p.occurred_date), now);
    if (gday < 0 || gday >= horizonWeeks * 7) continue;
    const subjectId =
      p.subject_type === "research"
        ? `research-${p.subject_id}-w${Math.floor(gday / 7)}`
        : p.subject_id;
    const key = `${subjectId}@${gday}-${p.start_min}`;
    pinned[key] = {
      taskId: subjectId,
      projectId: p.project_id,
      tagLabel: p.tag_label,
      title: p.title,
      gday,
      start: p.start_min,
      end: p.end_min,
      priority: p.priority,
    };
  }

  // Research time fixed to an exact slot. Pins older than this week are
  // stale (their week was already reconciled) and ones past the horizon
  // can't be placed — drop both rather than making callers filter.
  const researchPins: ResearchPin[] = [];
  for (const rp of rows.researchPins) {
    const gday = gdayForDate(timezone, dateParts(rp.pinned_date), now);
    if (gday < 0 || gday >= horizonWeeks * 7) continue;
    researchPins.push({ projectId: rp.project_id, gday, start: rp.start_min, length: rp.length_min });
  }

  // Focused days. Dropped on the same terms as the pins above — a focus on a day
  // that has passed described a decision that has already played out, and one past
  // the horizon has nothing to act on yet.
  const dayFocus: DayFocus[] = [];
  for (const df of rows.dayFocus ?? []) {
    const gday = gdayForDate(timezone, dateParts(df.focus_date), now);
    if (gday < 0 || gday >= horizonWeeks * 7) continue;
    dayFocus.push({ projectId: df.project_id, categoryId: df.category_id, gday });
  }

  const inputs: ScheduleInputs = {
    timezone,
    horizonWeeks,
    weeklyHours,
    tasks,
    projects,
    events,
    recurringRules,
    dayOverrides,
    graceHours: rows.profile.grace_hours ?? 4,
    allDayBlocks,
    researchPins,
    dayFocus,
    // Only computable when the caller fetched the lifetime history; the engine
    // treats its absence as "no commitment has more slack than another".
    loggedMinByProject: rows.progressFacts?.byProject,
    paceSlackWeeksByProject: rows.progressFacts
      ? Object.fromEntries(
          computePace({
            projects,
            targets: toTargets(rows.targets),
            loggedByProject: rows.progressFacts.byProject,
            weeklyHours,
            now,
          })
            .filter((p) => p.weeksAvailable != null && p.weeksNeeded != null)
            .map((p) => [p.projectId, p.weeksAvailable! - p.weeksNeeded!]),
        )
      : undefined,
    completed,
    partial,
    pinned,
    historyBlocks,
    currentWeekFallback,
    labelNames,
    labelTargetPct,
    labelTargetBasis,
  };

  // Deliberately NOT part of ScheduleInputs: the engine does not read the
  // reserve and must not appear to. It travels alongside, for the views and
  // sentences that judge whether a week can hold what is being asked of it.
  const reserve: WeeklyReserve = {
    expectedMeetingMin: rows.profile.expected_meeting_min_per_week ?? 0,
    miscMin: rows.profile.reserve_misc_min_per_week ?? 0,
  };

  return { inputs, projects, targets, categories, reserve };
}
