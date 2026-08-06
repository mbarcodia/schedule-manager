// Why isn't this scheduled?
//
// The board could say that something didn't fit and never why. "Didn't fit" is
// four or five quite different situations with different fixes, and the user is
// left to work out which by inspecting settings across three screens:
//
//   its window is impossible     a deadline earlier than its earliest start
//   it cannot start yet          nothing to fix; it begins later than we plan
//   it is locked to half a day   morning-only, and the mornings are full
//   its active window has passed weekly hours that no longer apply
//   the horizon really is full   the only one that means "your calendar is full"
//
// EVERY REASON HERE IS CHECKED, NEVER GUESSED. Each one reads the same inputs the
// engine read and reports a fact about them; where no fact explains it, the
// fallback says plainly that the time simply wasn't there. A confident wrong
// reason would send someone to change the wrong setting, which is worse than the
// silence this replaces.
//
// Two candidate reasons were written and then DELETED for failing that test,
// which is worth recording so they aren't re-added:
//
//   "it's shorter than its label's minimum chunk" — not a thing. chunkLengthsToTry
//   does `floor = Math.min(floorMin, remaining)`, so the floor never exceeds what
//   is left and a 20-minute task under a 60-minute floor schedules normally. The
//   floor governs SHRINKING a chunk to fit a gap, not the length of the work.
//
//   an impossible window as an unplaced cause — the engine places such work LATE
//   rather than not at all ("schedule it late rather than not at all, and let the
//   risk report say so"), so it never appears as unplaced. It is still a
//   contradiction worth naming, so it is checked before anything else and does not
//   depend on the work having failed to place.
//
// Ordered most specific first: a task that cannot start until next year is not
// also a capacity problem, and saying both would bury the one that matters.

import { resolveDayWindow } from "./day-window";
import type { Category, ComputeScheduleResult, Project, ScheduleInputs, Task, UnplacedWork } from "./types";

export interface Reason {
  /** One sentence, in the app's voice, saying what is actually true. */
  text: string;
  /** Which setting to change, when there is one. Null when nothing is wrong. */
  fix: string | null;
  /** True when this isn't a problem at all — it just starts later. */
  benign: boolean;
}

const hrs = (min: number) => `${+(min / 60).toFixed(min % 60 === 0 ? 0 : 1)}h`;

/** tasks[].deadline uses this to mean "no deadline" — same sentinel from-db and
 * the engine use. */
const NO_DEADLINE = 99999;

/** Absolute minutes -> a date, for wording. gday 0 is Monday of this week. */
function dateOf(abs: number, weekStart: Date): Date {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + Math.floor(abs / 1440));
  return d;
}

const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

export interface WhyNotInputs {
  inputs: ScheduleInputs;
  schedule: ComputeScheduleResult;
  categories: Category[];
  /** Monday of the current week, for turning absolute minutes into dates. */
  weekStart: Date;
  /** Now, in absolute minutes from the grid start (nowAbsMinute). Needed because
   * "didn't fit" in the CURRENT week usually means the open days have already
   * gone by, not that the hours are occupied — and those read identically on the
   * board while calling for completely different responses. */
  nowAbs: number;
}

/** Working minutes in a week that are still AHEAD and unoccupied.
 *
 * The distinction this exists for: a conference week whose only working day was
 * Monday has 8 hours of capacity, none of it booked, and nothing can be
 * scheduled into it on Thursday. Reporting that as "the working hours left are
 * already taken" is false and sends you looking for something to cancel. */
function freeAheadInWeek(
  inputs: ScheduleInputs,
  schedule: ComputeScheduleResult,
  weekOffset: number,
  nowAbs: number,
): { freeAheadMin: number; passedMin: number } {
  const busy = new Set<number>();
  for (const b of schedule.blocks) {
    if (b.allDay || b.gday < 0) continue;
    for (let m = b.start; m < b.end; m++) busy.add(b.gday * 1440 + m);
  }
  let freeAheadMin = 0;
  let passedMin = 0;
  for (let d = 0; d < 7; d++) {
    const gday = weekOffset * 7 + d;
    if (gday < 0) continue;
    const win = resolveDayWindow(gday, inputs.weeklyHours, inputs.dayOverrides, inputs.allDayBlocks);
    if (!win) continue;
    for (let m = win.start; m < win.end; m++) {
      const abs = gday * 1440 + m;
      if (abs < nowAbs) passedMin++;
      else if (!busy.has(abs)) freeAheadMin++;
    }
  }
  return { freeAheadMin, passedMin };
}

/** The half of the day a piece of work is locked to, and how much of that half
 * the horizon has left. Only computed when there IS a hard restriction, since it
 * is the only case where the answer is "the other half was free and unusable". */
function halfDayRoom(
  inputs: ScheduleInputs,
  schedule: ComputeScheduleResult,
  half: "morning" | "afternoon",
): number {
  const busy = new Set<number>();
  for (const b of schedule.blocks) {
    if (b.allDay || b.gday < 0) continue;
    for (let m = b.start; m < b.end; m++) busy.add(b.gday * 1440 + m);
  }
  let free = 0;
  for (let gday = 0; gday < inputs.horizonWeeks * 7; gday++) {
    const dow = ((gday % 7) + 7) % 7;
    const win = inputs.weeklyHours[dow];
    if (!win) continue;
    const from = half === "morning" ? win.start : Math.max(win.start, 720);
    const to = half === "morning" ? Math.min(win.end, 720) : win.end;
    for (let m = from; m < to; m++) if (!busy.has(gday * 1440 + m)) free++;
  }
  return free;
}

/** Why this task has minutes the scheduler couldn't place. Null when it has none. */
export function whyNotTask(
  task: Task,
  { inputs, schedule, categories, weekStart }: WhyNotInputs,
): Reason | null {
  const label = task.categoryId ? categories.find((c) => c.id === task.categoryId) : null;

  // Checked before anything else, and without needing the work to have failed:
  // a deadline earlier than the earliest start is a contradiction in the
  // settings, and the engine's response is to place the work late. So the task
  // looks scheduled and is guaranteed to be reported at risk forever.
  if (task.deadline !== NO_DEADLINE && task.deadline < task.floor) {
    return {
      text: `Its window is impossible: it's due ${fmt(dateOf(task.deadline, weekStart))} but may not start until ${fmt(dateOf(task.floor, weekStart))}. It has been scheduled late rather than not at all.`,
      fix: "Move the deadline later, or the start earlier.",
      benign: false,
    };
  }

  const entry: UnplacedWork | undefined = schedule.unplaced.find((u) => u.id === task.id);
  if (!entry || entry.remainingMin <= 0) return null;

  if (entry.startsAfterHorizon) {
    return {
      text: `Nothing to decide yet — it can't start before ${fmt(dateOf(entry.floorAbs, weekStart))}, which is past the ${inputs.horizonWeeks} weeks being planned.`,
      fix: null,
      benign: true,
    };
  }

  const floor = task.minChunk ?? 30;
  if (task.timeOfDay) {
    const room = halfDayRoom(inputs, schedule, task.timeOfDay);
    if (room < floor) {
      return {
        text: `It's restricted to ${task.timeOfDay}s, and there's ${room === 0 ? "no" : `only ${hrs(room)} of`} free ${task.timeOfDay} time left in the next ${inputs.horizonWeeks} weeks — the afternoons may be free, but a hard restriction can't use them.`,
        fix: label?.timePref?.endsWith("_only")
          ? `Change ${label.name}'s time of day to "prefer" instead of "only", or set this task's own.`
          : `Clear this task's time-of-day restriction, or make it a preference.`,
        benign: false,
      };
    }
  }

  return {
    text: `${hrs(entry.remainingMin)} of it has nowhere to go in the next ${inputs.horizonWeeks} weeks — every working hour inside its window is already taken.`,
    fix: "Something else has to move, or its deadline does.",
    benign: false,
  };
}

/** Why a commitment's weekly hours didn't fully land this week. Null when they
 * did, or when it carries no weekly hours to begin with. */
export function whyNotCommitment(
  project: Project,
  { inputs, schedule, categories, weekStart, nowAbs }: WhyNotInputs,
  weekOffset = 0,
): Reason | null {
  if (!project.weeklyMinMin) return null;

  const first = weekOffset * 7;
  const placed = schedule.blocks
    .filter(
      (b) =>
        b.type === "task" &&
        b.projectId === project.id &&
        Math.floor(b.gday / 7) === weekOffset &&
        b.status !== "missed",
    )
    .reduce((sum, b) => sum + (b.end - b.start), 0);

  // What it was actually asked for this week, which a share target may have
  // scaled down — comparing against the declared figure would report a shortfall
  // that was never asked for.
  const asked = schedule.weeklyTargetMinByProject[project.id] ?? project.weeklyMinMin;
  if (placed >= asked) return null;

  const label = project.categoryId ? categories.find((c) => c.id === project.categoryId) : null;

  // An active window that doesn't cover this week is the whole answer, and the
  // most common one for a project that starts next term.
  const weekStartAbs = first * 1440;
  const weekEndAbs = (first + 7) * 1440;
  if (project.activeFromAbs != null && project.activeFromAbs >= weekEndAbs) {
    return {
      text: `Its weekly hours don't start until ${fmt(dateOf(project.activeFromAbs, weekStart))}.`,
      fix: null,
      benign: true,
    };
  }
  if (project.activeUntilAbs != null && project.activeUntilAbs <= weekStartAbs) {
    return {
      text: `Its weekly hours stopped applying on ${fmt(dateOf(project.activeUntilAbs, weekStart))}.`,
      fix: null,
      benign: true,
    };
  }

  // Scaled to nothing by its label's share: a real and confusing outcome, since
  // the commitment looks configured and simply never appears.
  if (asked === 0 && label?.weeklyTargetPct) {
    return {
      text: `Its share of this week came out shorter than the ${label.name} label's minimum chunk, so it gets nothing rather than an unusable sliver.`,
      fix: `Raise its weekly hours, or lower ${label.name}'s minimum chunk.`,
      benign: false,
    };
  }

  if (project.timeOfDay) {
    const floor = project.minChunk ?? 30;
    const room = halfDayRoom(inputs, schedule, project.timeOfDay);
    if (room < floor) {
      return {
        text: `It's restricted to ${project.timeOfDay}s, and there's ${room === 0 ? "no" : `only ${hrs(room)} of`} free ${project.timeOfDay} time left — the other half of the day can't be used for it.`,
        fix: `Change that restriction to a preference so it can spill over.`,
        benign: false,
      };
    }
  }

  const missing = asked - placed;
  const { freeAheadMin, passedMin } = freeAheadInWeek(inputs, schedule, weekOffset, nowAbs);

  // The week is not over-full, it is over: its working days have gone by. Common
  // in a travel week where the one day at a desk was Monday.
  if (freeAheadMin === 0 && passedMin > 0) {
    return {
      text: `${hrs(missing)} of its ${hrs(asked)} this week has nowhere left to go — the week's working days have already passed.`,
      fix: null,
      benign: true,
    };
  }
  if (freeAheadMin < missing) {
    return {
      text: `${hrs(missing)} of its ${hrs(asked)} this week didn't fit — only ${hrs(freeAheadMin)} of the week is still ahead and unbooked.`,
      fix: "It will run short unless something moves.",
      benign: false,
    };
  }

  return {
    text: `${hrs(missing)} of its ${hrs(asked)} this week didn't fit, though ${hrs(freeAheadMin)} is still free — its own window or half-of-day setting is what it can't use.`,
    fix: "Check its time-of-day restriction and its label's.",
    benign: false,
  };
}
