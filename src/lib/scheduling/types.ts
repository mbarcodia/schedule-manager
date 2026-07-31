// Domain types for the scheduling engine, ported from the prototype's state
// shape (Schedule Manager.dc.html) but typed and shared between server and
// browser.

export type Priority = "high" | "medium" | "low";

/** A user-defined grouping (e.g. Research/Teaching/Tasks) that now drives the
 * calendar block's fill color — priority still drives scheduling order, it
 * just isn't the color anymore. */
export interface Category {
  id: string;
  name: string;
  color: string; // hex
  sortOrder: number;
  /** Hard floor for any shrunk chunk in this category, in minutes. Null/
   * undefined = no category-specific floor (engine falls back to 30m). */
  minChunkMin?: number | null;
}

/** A "global day" index: 0 = Monday of the current week, 1 = Tuesday, ...
 * 7 = Monday of next week, etc. Day-of-week is `gday % 7` (0=Mon..6=Sun). */
export type GDay = number;

/** Minutes since local midnight (0-1439), in the account's timezone. */
export type MinuteOfDay = number;

/** Minutes since gday=0's midnight — `gday * 1440 + minuteOfDay`. */
export type AbsMinute = number;

export interface Task {
  id: string;
  title: string;
  priority: Priority;
  /** Total minutes of work remaining. */
  duration: number;
  /** Preferred chunk size in minutes; the engine may shrink a chunk to fit
   * a gap, down to minChunk (or 30m if unset). */
  chunk: number;
  /** Hard floor for a shrunk chunk, in minutes — sourced from the task's/
   * project's category. Defaults to 30 (the engine's original universal
   * floor) when the category has none set. */
  minChunk?: number;
  tag?: "deep-focus" | "research" | null;
  /** Explicit half-of-day constraint the scheduler must honor — "morning"
   * means before noon (same as tag "deep-focus"), "afternoon" means noon or
   * later. Undefined = no constraint beyond whatever tag/preferMorning
   * already implies. */
  timeOfDay?: "morning" | "afternoon" | null;
  dependsOn?: string | null;
  /** Deadline in absolute minutes from the horizon start; 99999 = none. */
  deadline: number;
  /** Earliest this task may start, in absolute minutes from horizon start. */
  floor: number;
  /** Latest absolute minute a chunk may end by (used to fence research to
   * its own week). Undefined = no ceiling. */
  ceilAbs?: number;
  maxPerDayMin?: number | null;
  projectId?: string | null;
  categoryId?: string | null;
  /** Explicit ordering; lower sorts first among equal priority. work_on_next
   * sets this to 0. */
  ord?: number;
  preferMorning?: boolean;
  /** One-shot forced placement: this many minutes of the task are pinned to
   * this exact gday/start, like a mini fixed event scoped to just this task.
   * The remaining duration (if any) is still auto-placed normally. Expires
   * on its own once the date passes — from-db.ts stops forwarding stale
   * pins, so nothing needs to clear it. */
  pin?: { gday: GDay; start: MinuteOfDay; length: number } | null;
}

/** A project: anything ongoing the user has signed up for. Its behaviour
 * comes from which facets are filled in, not from a type — weekly hours make
 * the engine generate and defend time, a deadline makes it tracked toward a
 * date, a cadence makes it ongoing. Any combination is legal. (Stored in the
 * `projects` table; see migration 0023.) */
export interface Project {
  id: string;
  title: string;
  deadlineDate?: Date | null;
  /** Weekly minimum, in minutes. Null/undefined = carries no weekly hours, so
   * no chunks are generated for it. */
  weeklyMinMin?: number | null;
  preferMorning?: boolean;
  /** Hard half-of-day constraint for this project's weekly hours. Undefined
   * = unconstrained beyond preferMorning's softer nudge. */
  timeOfDay?: "morning" | "afternoon" | null;
  /** Weekly hours only apply inside this window — absolute minutes from the
   * horizon start. Undefined = unbounded on that side. Lets a project that
   * begins next semester exist now without booking hours today. */
  activeFromAbs?: number | null;
  activeUntilAbs?: number | null;
  /** An ongoing rhythm ("Weekly", "Ongoing") for a project with no
   * deadline. Descriptive only — nothing is scheduled from it. */
  cadence?: string | null;
  /** Default chunk size for its auto-generated weekly blocks. */
  chunk?: number;
  /** Hard floor for a shrunk weekly chunk, in minutes — sourced from the
   * project's label. */
  minChunk?: number;
  /** Order among projects competing for mornings; lower first. */
  researchOrd?: number;
  /** Colors this project's auto-generated weekly blocks. */
  categoryId?: string | null;
}

/** A date inside a project that consumes no calendar time. Deliberately
 * absent from ScheduleInputs: the engine must never see these, because giving
 * them hours is exactly the mistake they exist to avoid. */
export interface Target {
  id: string;
  projectId: string;
  title: string;
  date: Date;
  completedAt: Date | null;
}

/** A fixed calendar event (meeting) — immovable; tasks flow around it. */
export interface CalendarEvent {
  id: string;
  title: string;
  gday: GDay;
  start: MinuteOfDay;
  end: MinuteOfDay;
  source?: "manual" | "google" | "icloud" | "outlook";
  description?: string | null;
  location?: string | null;
  meetingUrl?: string | null;
  /** Accent color of the calendar connection this was synced from — used
   * for the left-edge bar so multiple connected calendars are
   * distinguishable at a glance. Null for manually-added events. */
  connectionColor?: string | null;
  connectionLabel?: string | null;
  /** From an all-day entry. These never occupy hours: what they block is
   * decided by the connection's all_day_mode and reaches the engine as
   * ScheduleInputs.allDayBlocks, not as busy time. */
  allDay?: boolean;
}

export interface RecurringRule {
  id: string;
  title: string;
  tag?: string;
  /** Days of week this rule applies to, 0=Mon..4=Fri. Recurring rules are
   * weekday-only by design (per the handoff spec). */
  days: number[];
  length: number;
  /** Placement window in minutes-of-day. Null on both = "wherever it fits"
   * (uses working hours as the window). winStart === winEnd - length means
   * fixed. */
  winStart: number | null;
  winEnd: number | null;
}

export interface DayOverride {
  start?: number;
  end?: number;
  /** Explicitly turns on a date whose weekday is off by default in
   * WeeklyHours (most commonly a weekend, but works for any day-off
   * weekday). Ignored for days that are already on. New in production — not
   * in the prototype, which only understood a global Mon-Fri window. */
  allowWeekend?: boolean;
}

export type DayOverrides = Record<GDay, DayOverride>;

/** Per-weekday default working window, 0=Mon..6=Sun. null = day off by
 * default (day_overrides can still turn a specific date on). Replaces the
 * prototype's single global workStartHour/workEndHour applied to every
 * weekday. */
export type WeeklyHours = Record<number, { start: MinuteOfDay; end: MinuteOfDay } | null>;

/** done = fully done; partial = N minutes credited, remainder re-fed;
 * missed = all time re-fed. */
/** "grace" = its time has passed with nothing logged, but recently enough that
 * the user may simply not have ticked it yet. It stays in place, greyed and
 * still completable, until the grace window lapses and it becomes "missed". */
export type ProgressStatus = "done" | "partial" | "missed" | "active" | "grace";

export interface ProgressEntry {
  /** Present only when status === 'partial'. */
  minutes?: number;
}

/** A future task chunk checked off early — pinned in place, time credited. */
export interface PinnedEntry {
  taskId: string;
  projectId?: string | null;
  tagLabel: string;
  title: string;
  gday: GDay;
  start: MinuteOfDay;
  end: MinuteOfDay;
  priority: Priority | null;
}

export type BlockType = "synced" | "anchor" | "task";

export interface ScheduleBlock {
  type: BlockType;
  taskId?: string;
  projectId?: string | null;
  categoryId?: string | null;
  tagLabel: string;
  title: string;
  gday: GDay;
  start: MinuteOfDay;
  end: MinuteOfDay;
  priority: Priority | null;
  /** Present on task blocks that have already started/passed. */
  key?: string;
  abs?: AbsMinute;
  status?: ProgressStatus;
  partMin?: number | null;
  pinned?: boolean;
  /** Present on synced meeting blocks only. */
  allDay?: boolean;
  description?: string | null;
  location?: string | null;
  meetingUrl?: string | null;
  connectionColor?: string | null;
  connectionLabel?: string | null;
  /** UI-only: set when adjacent same-task chunks are visually merged into
   * one display block (see WeekGrid's mergeAdjacentTaskBlocks) — the
   * original chunks, needed to log progress against each one's own
   * progress_log key rather than the merged span. */
  mergedChunks?: ScheduleBlock[];
}

export interface ComputeScheduleResult {
  blocks: ScheduleBlock[];
  /** Task titles that couldn't be fully placed within the horizon. */
  overflow: string[];
  /** Task titles scheduled to finish strictly after their deadline — red. */
  risk: string[];
  /** Task titles scheduled to finish on the same day as their deadline —
   * still on time, but no buffer day left. Yellow. */
  nearDeadline: string[];
  /** Human-readable missed/short entries for the warning banner. */
  missed: string[];
}

export interface ScheduleInputs {
  timezone: string;
  /** Rolling scheduling horizon in weeks. Production default: 12. */
  horizonWeeks: number;
  weeklyHours: WeeklyHours;
  tasks: Task[];
  projects: Project[];
  events: CalendarEvent[];
  recurringRules: RecurringRule[];
  dayOverrides: DayOverrides;
  /** Hours an un-ticked past block stays completable in place before it counts
   * as definitively missed (profiles.grace_hours). */
  graceHours: number;
  /** Days covered by an all-day event, and what it blocks.
   *
   * "no_meetings" leaves scheduling untouched — it only makes the day
   * unavailable on the public booking page, which is the common case: away at a
   * conference, still working. "away" makes the day non-working entirely, as
   * though its hours were switched off. */
  allDayBlocks: Record<GDay, "no_meetings" | "away">;
  /** Research time the user fixed to an exact slot (see research_pins).
   * Reduces that week's auto-placed chunk for the same project. */
  researchPins: ResearchPin[];
  /** Keyed by `${taskId}@${gday}-${start}`. */
  completed: Record<string, boolean>;
  partial: Record<string, number>;
  pinned: Record<string, PinnedEntry>;
  /** User-customizable display names for the four block-tag kinds — see
   * Settings. Always fully resolved (defaults already applied) by the time
   * they reach the engine. */
  tagLabels: TagLabels;
}

export interface ResearchPin {
  projectId: string;
  gday: GDay;
  start: MinuteOfDay;
  length: number;
}

export interface TagLabels {
  task: string;
  research: string;
  deepFocus: string;
  block: string;
}

export const DEFAULT_TAG_LABELS: TagLabels = {
  task: "Work",
  research: "Research",
  deepFocus: "Deep focus",
  block: "Routine",
};
