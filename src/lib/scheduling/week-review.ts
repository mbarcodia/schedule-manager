// One week, summarised: where the time went, and whether the week matched what
// you said you wanted from it.
//
// The board could say what is scheduled and what is late, and nothing could say
// how the week as a whole was spent. That is the question a weekly rhythm
// actually turns on — "did research get its share, or did meetings eat it" — and
// answering it needed three numbers this app already holds separately:
//
//   TARGET   what a label's share of the week comes to, given the capacity that
//            week really has (engine: labelTargetsByWeek — a travel week has a
//            smaller target, which is the point).
//   BOOKED   what the scheduler actually managed to place for it.
//   DONE     what was ticked off, from progress_log.
//
// Keeping them apart is the whole value. Target vs booked is a CAPACITY problem —
// the week could not hold what you asked of it. Booked vs done is a FOLLOW-THROUGH
// problem — the time was there and the work didn't happen. They have opposite
// fixes, and a single "hours this week" figure hides which one you have.
//
// Pure over its inputs so it can be checked without a browser or a database.

import { resolveDayWindow } from "./day-window";
import type {
  Category,
  ComputeScheduleResult,
  DayOverrides,
  GDay,
  LabelTargetReport,
  Project,
  ScheduleBlock,
  WeeklyHours,
} from "./types";

export interface LabelWeek {
  labelId: string | null;
  label: string;
  color: string | null;
  /** Null when this label carries no share target — most of them. */
  targetMin: number | null;
  /** What the engine set out to place, which is below the target whenever the
   * per-commitment roundings don't cancel. Null without a target. */
  askedMin: number | null;
  /** Commitments that got nothing this week because their share fell below their
   * own minimum chunk. */
  belowFloor: string[];
  bookedMin: number;
  doneMin: number;
}

export interface DayWeek {
  gday: GDay;
  /** 0=Mon .. 6=Sun. */
  dow: number;
  bookedMin: number;
  doneMin: number;
  /** Minutes the day is open for at all — the denominator for its bar. */
  windowMin: number;
}

export interface WeekReview {
  /** 0 = this week, -1 = last week, 1 = next week. */
  offset: number;
  /** A past week is a record of what was worked, never a plan — nothing back
   * there is re-derived, so it has no targets and its "booked" is its history. */
  isPast: boolean;
  meetingsMin: number;
  routinesMin: number;
  /** Flexible work the scheduler placed: tasks and weekly-hours blocks. */
  workBookedMin: number;
  /** Of that, what has been ticked off. */
  workDoneMin: number;
  /** Meeting minutes that fall OUTSIDE the working window, or on a day the week
   * doesn't open at all. Counted apart rather than dropped: a conference week is
   * mostly this, and it is the explanation for a week that looks empty. */
  outOfHoursMeetingsMin: number;
  /** Working minutes in the week that nothing is scheduled in. */
  freeMin: number;
  /** Total working minutes the week's hours open up. */
  capacityMin: number;
  /** What the same week would open if nothing were closed or away — the figure
   * capacityMin is compared against to say "this week is smaller than usual".
   * A threshold picked by hand ("under 8 hours") would be wrong for anyone whose
   * normal week isn't 40. */
  standardCapacityMin: number;
  byLabel: LabelWeek[];
  byDay: DayWeek[];
}

const OTHER_LABEL = "No label";

export interface WeekReviewInputs {
  schedule: ComputeScheduleResult;
  projects: Project[];
  categories: Category[];
  weeklyHours: WeeklyHours;
  dayOverrides: DayOverrides;
  allDayBlocks: Record<GDay, "no_meetings" | "away">;
  /** From progressFacts — what was actually logged, by day. */
  logged: { occurredDate: Date; projectId: string | null; minutes: number }[];
  /** Monday of the current week, for turning a logged date into a gday. */
  weekStart: Date;
  offset: number;
}

const DAY_MS = 86400000;

/** Which gday a logged date falls on, relative to this week's Monday. Built from
 * local date parts: the difference in whole days, not in milliseconds, so a
 * daylight-saving boundary inside the week doesn't shift a day. */
function gdayOf(date: Date, weekStart: Date): GDay {
  const a = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const b = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate()).getTime();
  return Math.round((a - b) / DAY_MS);
}

export function buildWeekReview(inputs: WeekReviewInputs): WeekReview {
  const { schedule, projects, categories, weeklyHours, dayOverrides, allDayBlocks, logged, weekStart, offset } = inputs;

  const first = offset * 7;
  const last = first + 7;
  const inWeek = (gday: GDay) => gday >= first && gday < last;

  const blocks = schedule.blocks.filter((b) => inWeek(b.gday) && !b.allDay);
  // A missed block is time that did NOT happen, so it counts toward neither what
  // was booked nor what was done. Counting it as booked would make a week of
  // missed research look identical to a week of finished research.
  const live = blocks.filter((b) => b.status !== "missed");

  // Everything is measured INSIDE the working window, because the week's capacity
  // is. A 7pm meeting and a conference on a day you aren't working are both real,
  // but neither competes with the work this week was supposed to hold — and
  // counting them against it produced "28.9h of meetings in a week that opens 8h",
  // which reads as a broken number rather than as a conference.
  const windowOf = (gday: GDay) => resolveDayWindow(gday, weeklyHours, dayOverrides, allDayBlocks);
  const inHours = (b: ScheduleBlock): number => {
    const win = windowOf(b.gday);
    if (!win) return 0;
    return Math.max(0, Math.min(b.end, win.end) - Math.max(b.start, win.start));
  };
  const minutes = (list: ScheduleBlock[]) => list.reduce((sum, b) => sum + inHours(b), 0);

  const meetingBlocks = live.filter((b) => b.type === "synced");
  const meetingsMin = minutes(meetingBlocks);
  const outOfHoursMeetingsMin = meetingBlocks.reduce((sum, b) => sum + (b.end - b.start) - inHours(b), 0);
  const routinesMin = minutes(live.filter((b) => b.type === "anchor"));
  const workBlocks = live.filter((b) => b.type === "task");
  const workBookedMin = minutes(workBlocks);
  const workDoneMin = minutes(workBlocks.filter((b) => b.status === "done"));

  let capacityMin = 0;
  let standardCapacityMin = 0;
  const byDay: DayWeek[] = [];
  for (let d = 0; d < 7; d++) {
    const gday = first + d;
    const win = windowOf(gday);
    const windowMin = win ? win.end - win.start : 0;
    capacityMin += windowMin;
    const standard = weeklyHours[d] ?? null;
    standardCapacityMin += standard ? standard.end - standard.start : 0;
    const dayWork = workBlocks.filter((b) => b.gday === gday);
    byDay.push({
      gday,
      dow: d,
      bookedMin: minutes(dayWork),
      doneMin: minutes(dayWork.filter((b) => b.status === "done")),
      windowMin,
    });
  }

  const freeMin = Math.max(0, capacityMin - meetingsMin - routinesMin - workBookedMin);

  // Logged hours are attributed through the commitment they belong to, because
  // progress_log records research against a commitment id and a task's minutes
  // against the task. Anything with no commitment can't be given a label.
  const labelOfProject = new Map(projects.map((p) => [p.id, p.categoryId ?? null]));
  const colorOf = new Map(categories.map((c) => [c.id, c.color]));
  const nameOf = new Map(categories.map((c) => [c.id, c.name]));

  const doneByLabel = new Map<string | null, number>();
  // A ticked-off labelled routine is done time for that label too. Its minutes
  // aren't in progress_log against a commitment, so they come from the block.
  for (const b of live) {
    if (b.type !== "anchor" || !b.categoryId || b.status !== "done") continue;
    doneByLabel.set(b.categoryId, (doneByLabel.get(b.categoryId) ?? 0) + inHours(b));
  }
  for (const entry of logged) {
    const gday = gdayOf(entry.occurredDate, weekStart);
    if (!inWeek(gday)) continue;
    const labelId = entry.projectId ? (labelOfProject.get(entry.projectId) ?? null) : null;
    doneByLabel.set(labelId, (doneByLabel.get(labelId) ?? 0) + entry.minutes);
  }

  // Labelled ROUTINES count toward their label alongside flexible work: a weekly
  // literature scan wearing Research is research time, and the engine already
  // reduces what the commitments are asked for by exactly this much. Leaving it
  // out here would report the share as missed while the engine considered it met.
  // Unlabelled routines belong to no share and are only in the routines tile.
  const bookedByLabel = new Map<string | null, number>();
  const towardLabels = [...workBlocks, ...live.filter((b) => b.type === "anchor" && b.categoryId)];
  for (const b of towardLabels) {
    const labelId = b.categoryId ?? null;
    bookedByLabel.set(labelId, (bookedByLabel.get(labelId) ?? 0) + inHours(b));
  }

  // Targets come from the engine rather than being recomputed here: the capacity
  // a percentage is a share OF is the engine's own figure for that week, and a
  // second implementation of it is how two views come to disagree.
  const targets: LabelTargetReport[] = offset >= 0 ? (schedule.labelTargetsByWeek[offset] ?? []) : [];
  const targetByName = new Map(targets.map((t) => [t.label, t]));

  const labelIds = new Set<string | null>([...bookedByLabel.keys(), ...doneByLabel.keys()]);
  for (const c of categories) if (targetByName.has(c.name)) labelIds.add(c.id);

  const byLabel: LabelWeek[] = [...labelIds]
    .map((labelId) => {
      const name = labelId ? (nameOf.get(labelId) ?? OTHER_LABEL) : OTHER_LABEL;
      const report = targetByName.get(name);
      return {
        labelId,
        label: name,
        color: labelId ? (colorOf.get(labelId) ?? null) : null,
        targetMin: report?.targetMin ?? null,
        askedMin: report?.askedMin ?? null,
        belowFloor: report?.belowFloor ?? [],
        bookedMin: bookedByLabel.get(labelId) ?? 0,
        doneMin: doneByLabel.get(labelId) ?? 0,
      };
    })
    // A label with a target always shows, even at zero — that IS the news.
    .filter((l) => l.targetMin != null || l.bookedMin > 0 || l.doneMin > 0)
    .sort((a, b) => (b.targetMin ?? 0) - (a.targetMin ?? 0) || b.bookedMin - a.bookedMin);

  return {
    offset,
    isPast: offset < 0,
    meetingsMin,
    outOfHoursMeetingsMin,
    routinesMin,
    workBookedMin,
    workDoneMin,
    freeMin,
    capacityMin,
    standardCapacityMin,
    byLabel,
    byDay,
  };
}

/** The cumulative target line a day-by-day chart is read against: a week's target
 * spread over the days that are actually open, so a Wednesday off doesn't make
 * the line imply work that couldn't have happened. */
export function cumulativeTarget(review: WeekReview, weeklyTargetMin: number): number[] {
  const openMin = review.byDay.reduce((sum, d) => sum + d.windowMin, 0);
  let run = 0;
  return review.byDay.map((d) => {
    run += openMin ? (weeklyTargetMin * d.windowMin) / openMin : 0;
    return Math.round(run);
  });
}
