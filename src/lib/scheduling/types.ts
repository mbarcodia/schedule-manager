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

export interface Project {
  id: string;
  title: string;
  deadlineDate?: Date | null;
  /** Weekly research minimum, in minutes. Null/undefined = not a research
   * project (no auto-generated weekly chunks). */
  weeklyMinMin?: number | null;
  preferMorning?: boolean;
  /** Default chunk size for auto-generated research blocks. */
  chunk?: number;
  /** Hard floor for a shrunk research chunk, in minutes — sourced from the
   * project's category. */
  minChunk?: number;
  /** Priority among research projects when claiming mornings; lower first. */
  researchOrd?: number;
  /** Colors this project's auto-generated weekly research chunks. */
  categoryId?: string | null;
}

export interface Proposal {
  id: string;
  title: string;
  deadlineDate?: Date | null;
}

export interface Goal {
  id: string;
  title: string;
  cadence: string;
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
export type ProgressStatus = "done" | "partial" | "missed" | "active";

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
  /** Keyed by `${taskId}@${gday}-${start}`. */
  completed: Record<string, boolean>;
  partial: Record<string, number>;
  pinned: Record<string, PinnedEntry>;
}
