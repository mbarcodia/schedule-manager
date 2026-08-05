// Domain types for the scheduling engine, ported from the prototype's state
// shape (Schedule Manager.dc.html) but typed and shared between server and
// browser.

export type Priority = "high" | "medium" | "low";

/** A label: a user-defined grouping (e.g. Research/Teaching/Deep focus) that
 * drives the calendar block's fill color and the word in its corner — priority
 * still drives scheduling order, it just isn't the color anymore.
 *
 * This is the only user-named concept. It absorbed "time block names", four
 * fixed rename slots that named block kinds two of which nobody could choose
 * (see migration 0030), which is why a label now carries placement settings of
 * its own rather than only a colour. */
export interface Category {
  id: string;
  name: string;
  color: string; // hex
  sortOrder: number;
  /** Hard floor for any shrunk chunk in this category, in minutes. Null/
   * undefined = no category-specific floor (engine falls back to 30m). */
  minChunkMin?: number | null;
  /** Where in the day this label's work belongs. Null/undefined = any time.
   * Resolved onto each Task/Project's own timeOfDay/preferMorning/
   * preferAfternoon by from-db before the engine sees it — the engine reads
   * placement off the work, never off the label. */
  timePref?: LabelTimePref | null;
  /** Share of each week's available working time this label should get, 1-100.
   * Null = no target; per-commitment weekly minimums stand as absolute hours.
   * When set, this label's commitments have their weekly minutes scaled
   * proportionally to sum to the target, so those minutes act as a RATIO
   * between projects rather than a total anyone maintains by hand. */
  weeklyTargetPct?: number | null;
}

/** See Database's LabelTimePref: "*_only" is a hard constraint the engine
 * refuses to place outside, "prefer_*" is tried first and falls back rather
 * than leaving the work unscheduled. */
export type LabelTimePref = "prefer_morning" | "morning_only" | "prefer_afternoon" | "afternoon_only";

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
  /** Half-of-day constraint the scheduler must honor — "morning" means before
   * noon, "afternoon" means noon or later. Comes from the work's own
   * time_of_day, or failing that from a "*_only" label. Undefined = no hard
   * constraint beyond whatever preferMorning/preferAfternoon nudges. */
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
  /** Soft nudges: try that half of the day first, but take the other rather
   * than leave the work unscheduled. Mutually exclusive, and both are ignored
   * when timeOfDay is set (a hard constraint has nothing to fall back to). */
  preferMorning?: boolean;
  preferAfternoon?: boolean;
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
  /** Soft nudges for where this commitment's weekly hours go — see Task. */
  preferMorning?: boolean;
  preferAfternoon?: boolean;
  /** Hard half-of-day constraint for this project's weekly hours. Comes from
   * the commitment's own time_of_day, or failing that from a "*_only" label.
   * Undefined = unconstrained beyond the soft nudges above. */
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
  /** Total expected effort in minutes. Null = unestimated, which makes pace
   * unmeasurable rather than optimistic — see pace.ts. */
  effortEstimateMin?: number | null;
  /** The importance half of importance-vs-urgency, as tasks have. */
  important?: boolean;
  /** Whether deadlineDate is externally imposed ("hard") or self-set ("goal").
   * Both are scheduled toward identically; only the consequence of missing one
   * differs. */
  deadlineKind?: "hard" | "goal";
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
  /** Interim dates default to "goal" — a checkpoint is an aim by nature. */
  dateKind?: "hard" | "goal";
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
  tagLabel: string | null;
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
  /** The word in the block's corner: its label's name, "Routine" for a
   * routine, "Meeting"/"All day" for a synced event. Null when the block has
   * no label, in which case no tag is drawn. */
  tagLabel: string | null;
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
  /** Task titles the engine couldn't find room for — a genuine capacity
   * problem. Excludes work that simply starts later than the horizon reaches;
   * that's beyondHorizon, which is not a capacity problem at all. */
  overflow: string[];
  /** Task titles whose earliest start is past the end of the horizon, so there
   * is nothing to decide about them yet. */
  beyondHorizon: string[];
  /** Task titles scheduled to finish strictly after their deadline — red. */
  risk: string[];
  /** Task titles scheduled to finish on the same day as their deadline —
   * still on time, but no buffer day left. Yellow. */
  nearDeadline: string[];
  /** Human-readable missed/short entries for the warning banner. */
  missed: string[];
  /** THIS week's share targets: what each label with weekly_target_pct set
   * should get, against what actually landed. Empty when no label has one. */
  labelTargets: LabelTargetReport[];
  /** THIS week's scaled goal in minutes, keyed by commitment id, for those whose
   * label carries a share target. Absent for everything else, where the declared
   * weekly minimum is still the goal as stated. 0 means the week has no room for
   * it (travel), which is a real answer rather than a shortfall. */
  weeklyTargetMinByProject: Record<string, number>;
}

export interface LabelTargetReport {
  label: string;
  pct: number;
  /** Working minutes this week that weren't already taken by meetings, away
   * days or routines — what the percentage is a share OF. */
  capacityMin: number;
  targetMin: number;
  plannedMin: number;
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
  /** Label id -> label name, for the word in a block's corner. A block with no
   * label simply has no tag (there is no default word to fall back to — the
   * four built-in kind names this replaced were the problem, not the fix).
   * Routines are the one exception: they carry no label and always show
   * "Routine", because "this repeats on its own" is worth seeing at a glance
   * and there is nothing else to say about them. */
  labelNames: Record<string, string>;
  /** Label id -> its weekly share target as a percentage of that week's
   * available working time (categories.weekly_target_pct). Absent = no target.
   * See labelScaleForWeek in engine.ts for what it does to the commitments
   * wearing that label. */
  labelTargetPct: Record<string, number>;
}

export interface ResearchPin {
  projectId: string;
  gday: GDay;
  start: MinuteOfDay;
  length: number;
}

/** The corner tag on a routine's block. Not user-renameable, unlike a label —
 * it names a structural fact about the block rather than a grouping the user
 * chose. */
export const ROUTINE_TAG_LABEL = "Routine";
