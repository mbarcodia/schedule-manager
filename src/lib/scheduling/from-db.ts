// Converts raw Supabase rows into the engine's ScheduleInputs shape. Real
// calendar dates/timestamps (deadline_at, floor_at, starts_at, override_date,
// occurred_date) are converted into the current week-relative grid here —
// see the design note at the top of supabase/migrations/0001_init.sql for
// why persistence uses real dates while the engine works in relative minutes.

import { gdayForDate, zonedNow } from "./time";
import { defaultDayWindow } from "./day-window";
import type {
  CalendarEvent,
  Category,
  DayOverrides,
  PinnedEntry,
  Project,
  RecurringRule,
  ResearchPin,
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
  recurringRules: Row<"recurring_rules">[];
  preferenceNotes: Row<"preference_notes">[];
  dayOverrides: Row<"day_overrides">[];
  events: Row<"events">[];
  progressLog: Row<"progress_log">[];
  pinnedChunks: Row<"pinned_chunks">[];
  researchPins: Row<"research_pins">[];
  calendarConnections: Row<"calendar_connections">[];
}

function dateParts(iso: string): { year: number; month: number; day: number } {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return { year: y, month: m, day: d };
}

/** A timestamptz converted to this account's timezone, as civil date parts
 * plus minute-of-day — used to place it on the relative grid. */
function timestampToParts(iso: string, timeZone: string) {
  const at = new Date(iso);
  const z = zonedNow(timeZone, at);
  return { year: z.year, month: z.month, day: z.day, minuteOfDay: z.minuteOfDay };
}

const NO_DEADLINE = 99999;
const HORIZON_WEEKS = 12;

export function buildScheduleInputs(
  rows: RawScheduleRows,
  now: Date = new Date(),
): {
  inputs: ScheduleInputs;
  projects: Project[];
  targets: Target[];
  categories: Category[];
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
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const minChunkFor = (categoryId: string | null | undefined): number | undefined =>
    (categoryId ? categoryById.get(categoryId)?.minChunkMin : undefined) ?? undefined;

  const labelNames: Record<string, string> = {};
  const labelTargetPct: Record<string, number> = {};
  categories.forEach((c) => {
    labelNames[c.id] = c.name;
    if (c.weeklyTargetPct) labelTargetPct[c.id] = c.weeklyTargetPct;
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

  const projects: Project[] = rows.projects.map((p) => ({
    id: p.id,
    title: p.title,
    deadlineDate: p.deadline_date ? new Date(p.deadline_date) : null,
    weeklyMinMin: p.weekly_min_min,
    ...timePrefFor(p.category_id, p.time_of_day, p.prefer_morning),
    activeFromAbs: p.active_from ? dateToAbs(p.active_from, false) : null,
    activeUntilAbs: p.active_until ? dateToAbs(p.active_until, true) : null,
    cadence: p.cadence,
    chunk: p.chunk_min,
    minChunk: minChunkFor(p.category_id),
    researchOrd: p.research_ord ?? undefined,
    categoryId: p.category_id,
  }));

  const targets: Target[] = rows.targets.map((t) => ({
    id: t.id,
    projectId: t.commitment_id,
    title: t.title,
    date: new Date(t.target_date),
    completedAt: t.completed_at ? new Date(t.completed_at) : null,
  }));

  // Needed before the tasks below, not just by the engine: a date-only
  // deadline's ceiling is the end of that day's working window.
  const weeklyHours: WeeklyHours = {};
  for (let dow = 0; dow < 7; dow++) {
    weeklyHours[dow] = rows.profile.weekly_hours[String(dow)] ?? null;
  }

  const tasks: Task[] = rows.tasks.map((t) => {
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
    // nothing needs to clear the columns afterward. A pin still within this
    // week but already past NOW flows through normally: the engine's
    // kept/missed reconciliation (same as any other block) picks it up.
    let pin: Task["pin"] = null;
    if (t.pinned_date && t.pinned_start_min != null && t.pinned_length_min != null) {
      const pGday = gdayForDate(timezone, dateParts(t.pinned_date), now);
      if (pGday >= 0 && pGday < horizonWeeks * 7) {
        pin = { gday: pGday, start: t.pinned_start_min, length: t.pinned_length_min };
      }
    }

    return {
      id: t.id,
      title: t.title,
      priority: t.priority,
      duration: t.duration_min,
      chunk: t.chunk_min,
      minChunk: minChunkFor(t.category_id),
      ...timePrefFor(t.category_id, t.time_of_day),
      dependsOn: t.depends_on,
      deadline,
      floor,
      maxPerDayMin: t.max_per_day_min,
      projectId: t.project_id,
      categoryId: t.category_id,
      ord: t.ord,
      pin,
    };
  });

  const recurringRules: RecurringRule[] = rows.recurringRules.map((r) => ({
    id: r.id,
    title: r.title,
    days: r.days,
    length: r.length_min,
    winStart: r.win_start_min,
    winEnd: r.win_end_min,
  }));

  const dayOverrides: DayOverrides = {};
  for (const ov of rows.dayOverrides) {
    const gday = gdayForDate(timezone, dateParts(ov.override_date), now);
    if (gday < 0 || gday >= horizonWeeks * 7) continue; // outside the visible horizon
    dayOverrides[gday] = {
      start: ov.start_min ?? undefined,
      end: ov.end_min ?? undefined,
      allowWeekend: ov.allow_weekend,
    };
  }

  const connectionById = new Map(rows.calendarConnections.map((c) => [c.id, c]));

  // Which days an all-day entry covers, and what that calendar says it blocks.
  // "away" wins over "no_meetings" if two calendars disagree about the same day:
  // the stricter reading is the safer default when someone has said they're out.
  const allDayBlocks: Record<number, "no_meetings" | "away"> = {};

  const events: CalendarEvent[] = rows.events.map((e) => {
    const s = timestampToParts(e.starts_at, timezone);
    const en = timestampToParts(e.ends_at, timezone);
    const gday = gdayForDate(timezone, s, now);
    const connection = e.connection_id ? connectionById.get(e.connection_id) : null;
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
    completed,
    partial,
    pinned,
    labelNames,
    labelTargetPct,
  };

  return { inputs, projects, targets, categories };
}
