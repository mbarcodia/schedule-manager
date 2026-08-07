// Is a commitment keeping up?
//
// The question the app could not answer. It knew the RATE (weekly hours) and the
// DATE, which between them say how fast you are going and when you want to be
// finished — but nothing about how far there is to go, so "on track" was decided
// by summing the tasks linked to a commitment and came out true whenever there
// were none.
//
// Three numbers make it answerable, and all three already exist or are cheap:
//
//   estimate   total expected effort (projects.effort_estimate_min)
//   logged     what's actually been done (progress_log, which already records
//              research hours against the commitment id)
//   rate       weekly hours the engine defends (projects.weekly_min_min)
//
// Then: remaining ÷ rate = weeks of work left, against weeks until the next
// date. The ratio between those two is the whole signal.
//
// Deliberately reports "unmeasurable" rather than guessing when a piece is
// missing. A confident-looking pace derived from an absent estimate is what the
// old chip did, and it is worse than admitting the input isn't there.
//
// SCOPE. "Remaining" has to mean remaining BEFORE THE DATE BEING MEASURED. The
// next date is usually an interim target, and measuring the whole commitment
// against it invents a crisis: an 80h proposal with a notice-of-intent two
// weeks out reported 27 weeks of work due before a date that wants four hours
// of it, and advised 38h/wk. So when the targets up to that date carry their own
// hours (targets.effort_estimate_min, written by plan_phases), pace measures the
// cumulative slice due by then. Without them it measures the whole thing, which
// is right for a commitment that hasn't been broken into phases and is also
// exactly the old behaviour.

import { typicalBookableWeekMin, type WeeklyReserve } from "./reserve";
import type { Project, Target, WeeklyHours } from "./types";

export type PaceStatus =
  /** No estimate, or no date to aim at — pace cannot be computed. */
  | "unmeasurable"
  /** Measurable, but nothing has been logged yet. */
  | "not_started"
  /** Comfortably inside the time available. */
  | "ahead"
  /** Fits, without much room. */
  | "on_pace"
  /** Will not fit at the current rate. */
  | "slipping"
  /** Recorded, deliberately not being worked on. Nothing is scheduled for it.
   * Reported as its own state rather than as "needs weekly hours", which is what
   * a paused commitment looked like before — a decision misread as an omission. */
  | "on_hold";

export interface CommitmentPace {
  projectId: string;
  title: string;
  important: boolean;
  status: PaceStatus;
  /** Why pace can't be computed — shown so the gap is fixable rather than a shrug. */
  missing: ("estimate" | "date" | "weekly hours")[];
  /** The commitment's TOTAL expected effort. The progress bar and fractionDone
   * are against this, whatever pace is measuring. */
  estimateMin: number | null;
  /** The effort due by nextDate — the cumulative phase hours up to it, or the
   * whole estimate when the phases carry no hours. What pace divides. */
  scopeMin: number | null;
  loggedMin: number;
  /** Of scopeMin, not of estimateMin. */
  remainingMin: number | null;
  /** 0-1 against the total estimate, or null without one. */
  fractionDone: number | null;
  weeklyRateMin: number | null;
  /** The date pace is measured against: the soonest unmet target, else the
   * commitment's own deadline. */
  nextDate: Date | null;
  nextDateKind: "hard" | "goal" | null;
  nextDateLabel: string | null;
  weeksNeeded: number | null;
  weeksAvailable: number | null;
  /** How many weeks late the current rate lands, when slipping. */
  slipWeeks: number | null;
  /** Weekly minutes that would still hit nextDate — the "or go faster" option. */
  rateToHitMin: number | null;
  /** ON HOLD ONLY: the rate it would have to run at, from today, to still make
   * its date — set only once that rate exceeds the rate it was paused at, i.e.
   * once resuming as before would no longer be enough. Null while there is still
   * time, which is what keeps a hold quiet until it matters.
   *
   * The whole risk of putting something down is forgetting to pick it up in
   * time, and a state that never speaks would carry that risk silently. */
  holdRateNeededMin: number | null;
  /** Set when that "or go faster" rate is more than a normal week has room for,
   * once meetings, routines and the reserve are taken off (see reserve.ts).
   * "Go 38h/wk" is not advice when no week has ever held 38 hours of anything —
   * it is a date that has to move, and saying so is the point. Null when the
   * account keeps no capacity assumptions, since there is then nothing to
   * compare against. */
  exceedsWeekMin: number | null;
}

/** Above this share of the available time, there's no meaningful slack left, so
 * "on pace" rather than "ahead". Not a cliff — just the line between "fine" and
 * "fine as long as nothing goes wrong". */
const TIGHT = 0.85;

const MS_PER_WEEK = 7 * 86400000;

export interface PaceInputs {
  projects: Project[];
  targets: Target[];
  /** Minutes logged per commitment id. See loggedMinutesByCommitment. */
  loggedByProject: Record<string, number>;
  weeklyHours: WeeklyHours;
  now: Date;
  /** What a normal week can actually be asked for — typicalBookableWeekMin.
   * Omitted (or null) leaves every rate unchecked, exactly as before. */
  bookableWeekMin?: number | null;
}

/** Minutes actually worked, per commitment.
 *
 * progress_log records research hours against the COMMITMENT id
 * (subject_type 'research') and one-off work against the TASK id — so a task's
 * minutes have to be attributed through its project_id. A row with
 * minutes_done null means the whole block was completed. */
export function loggedMinutesByCommitment(
  progressLog: { subject_type: string; subject_id: string; start_min: number; end_min: number; minutes_done: number | null }[],
  tasks: { id: string; project_id: string | null }[],
): Record<string, number> {
  const projectOfTask = new Map(tasks.map((t) => [t.id, t.project_id]));
  const out: Record<string, number> = {};
  for (const row of progressLog) {
    const minutes = row.minutes_done ?? row.end_min - row.start_min;
    if (minutes <= 0) continue;
    const projectId =
      row.subject_type === "research"
        ? row.subject_id
        : row.subject_type === "task"
          ? (projectOfTask.get(row.subject_id) ?? null)
          : null; // anchors are routines — they belong to no commitment
    if (!projectId) continue;
    out[projectId] = (out[projectId] ?? 0) + minutes;
  }
  return out;
}

export function computePace(inputs: PaceInputs): CommitmentPace[] {
  const { projects, targets, loggedByProject, now } = inputs;
  const bookableWeekMin = inputs.bookableWeekMin ?? null;
  /** Only asked about a rate that would have to be sustained — a rate the week
   * can hold says nothing worth saying. */
  const overWeek = (rateMin: number | null): number | null =>
    bookableWeekMin != null && bookableWeekMin > 0 && rateMin != null && rateMin > bookableWeekMin
      ? bookableWeekMin
      : null;

  return projects.map((p) => {
    const estimateMin = p.effortEstimateMin ?? null;
    const loggedMin = loggedByProject[p.id] ?? 0;
    const weeklyRateMin = p.weeklyMinMin ?? null;
    const fractionDone = estimateMin == null ? null : Math.min(1, loggedMin / estimateMin);

    const mine = targets.filter((t) => t.projectId === p.id);

    // The soonest date still to be met. An unmet target comes before the
    // commitment's own deadline, because that's the one pace is against now.
    const openTargets = mine
      .filter((t) => !t.completedAt && t.date.getTime() > now.getTime())
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    const nextTarget = openTargets[0];
    const deadline = p.deadlineDate && p.deadlineDate.getTime() > now.getTime() ? p.deadlineDate : null;
    const useTarget = nextTarget && (!deadline || nextTarget.date.getTime() <= deadline.getTime());
    const nextDate = useTarget ? nextTarget.date : deadline;
    const nextDateKind = nextDate ? (useTarget ? (nextTarget.dateKind ?? "goal") : (p.deadlineKind ?? "hard")) : null;
    const nextDateLabel = nextDate ? (useTarget ? nextTarget.title : "deadline") : null;

    // What's due by that date. Every target up to and including it counts, hit or
    // missed: a phase whose date has passed unfinished is still work owed before
    // the next one. All of them have to carry hours — a single undimensioned
    // phase in the run makes the cumulative figure an undercount, and quietly
    // reporting an undercount is worse than measuring the whole commitment.
    const upTo = useTarget ? mine.filter((t) => t.date.getTime() <= nextTarget.date.getTime()) : [];
    const phased = upTo.length > 0 && upTo.every((t) => t.effortEstimateMin != null);
    const scopeMin = phased ? upTo.reduce((sum, t) => sum + t.effortEstimateMin!, 0) : estimateMin;
    const remainingMin = scopeMin == null ? null : Math.max(0, scopeMin - loggedMin);

    const missing: CommitmentPace["missing"] = [];
    // Phase hours are an estimate too: a commitment with no total but a costed
    // next phase has everything this calculation needs.
    if (scopeMin == null) missing.push("estimate");
    if (!nextDate) missing.push("date");
    if (!weeklyRateMin) missing.push("weekly hours");

    const base = {
      projectId: p.id,
      title: p.title,
      important: !!p.important,
      missing,
      estimateMin,
      scopeMin,
      loggedMin,
      remainingMin,
      fractionDone,
      weeklyRateMin,
      nextDate,
      nextDateKind,
      nextDateLabel,
    };

    // ON HOLD short-circuits everything below. A paused commitment is not
    // "unmeasurable" — nothing is missing, it is simply not running — and its
    // rate is the one it will RESUME at, which is remembered rather than blank.
    if (p.onHold) {
      const holdRate = p.weeklyMinMinOnHold ?? null;
      const weeksLeft = nextDate ? Math.max(0.1, (nextDate.getTime() - now.getTime()) / MS_PER_WEEK) : null;
      const needed = remainingMin != null && weeksLeft != null ? Math.ceil(remainingMin / weeksLeft) : null;
      // Silent until resuming as before would no longer make the date. Without a
      // remembered rate there is nothing to compare against, so a normal week's
      // bookable hours stand in — and failing that, it stays quiet rather than
      // inventing a threshold.
      const bar = holdRate ?? bookableWeekMin;
      const tight = needed != null && bar != null && bar > 0 && needed > bar;
      return {
        ...base,
        weeklyRateMin: holdRate,
        status: "on_hold" as PaceStatus,
        missing: [],
        weeksNeeded: holdRate && remainingMin != null ? remainingMin / holdRate : null,
        weeksAvailable: weeksLeft,
        slipWeeks: null,
        rateToHitMin: needed,
        holdRateNeededMin: tight ? needed : null,
        exceedsWeekMin: tight ? overWeek(needed) : null,
      };
    }


    if (missing.length) {
      return {
        ...base,
        status: "unmeasurable" as PaceStatus,
        weeksNeeded: null,
        weeksAvailable: null,
        slipWeeks: null,
        rateToHitMin: null,
        holdRateNeededMin: null,
        exceedsWeekMin: null,
      };
    }

    const weeksNeeded = remainingMin! / weeklyRateMin!;
    // Never below a fraction of a week: a date two days out still has some time
    // in it, and dividing by zero would report everything as slipping.
    const weeksAvailable = Math.max(0.1, (nextDate!.getTime() - now.getTime()) / MS_PER_WEEK);
    const rateToHitMin = Math.ceil(remainingMin! / weeksAvailable);

    // Already finished the estimated effort — nothing left to be late for.
    if (remainingMin === 0) {
      return {
        ...base,
        status: "ahead" as PaceStatus,
        weeksNeeded: 0,
        weeksAvailable,
        slipWeeks: null,
        rateToHitMin: 0,
        holdRateNeededMin: null,
        exceedsWeekMin: null,
      };
    }
    if (loggedMin === 0) {
      return {
        ...base,
        status: "not_started" as PaceStatus,
        weeksNeeded,
        weeksAvailable,
        slipWeeks: null,
        rateToHitMin,
        holdRateNeededMin: null,
        exceedsWeekMin: overWeek(rateToHitMin),
      };
    }

    const ratio = weeksNeeded / weeksAvailable;
    const status: PaceStatus = ratio > 1 ? "slipping" : ratio > TIGHT ? "on_pace" : "ahead";
    return {
      ...base,
      status,
      weeksNeeded,
      weeksAvailable,
      slipWeeks: status === "slipping" ? weeksNeeded - weeksAvailable : null,
      rateToHitMin,
      holdRateNeededMin: null,
      exceedsWeekMin: overWeek(rateToHitMin),
    };
  });
}

/** The gaps as a readable list. Shared with the card that offers to fill them,
 * so "estimate, date and weekly hours" doesn't become "estimate and date and
 * weekly hours" in one of the two places. */
export const missingList = (missing: CommitmentPace["missing"]): string =>
  missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}` : (missing[0] ?? "");

/** One line a person can act on. Kept here so the board, the chat snapshot and
 * the timeline all say the same thing about the same commitment. */
export function paceSentence(p: CommitmentPace): string {
  const hrs = (min: number) => `${+(min / 60).toFixed(1)}h`;
  if (p.status === "unmeasurable") {
    return `Pace unknown — needs ${missingList(p.missing)} to be measurable.`;
  }
  // On hold speaks in two registers: quiet while there is time, specific once
  // resuming as before would no longer make the date. The quiet form still names
  // what it will resume at, because "on hold" alone doesn't say whether picking
  // it up is a small thing or a large one.
  if (p.status === "on_hold") {
    const rate = p.weeklyRateMin ? ` It resumes at ${hrs(p.weeklyRateMin)}/wk.` : "";
    const left = p.remainingMin != null ? `${hrs(p.remainingMin)} left` : "nothing scheduled";
    if (!p.nextDate) return `On hold — ${left}, no date.${rate}`;
    const when = p.nextDate.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const weeks = Math.max(1, Math.round(p.weeksAvailable ?? 0));
    if (p.holdRateNeededMin == null) {
      return `On hold — ${left}, ${p.nextDateKind === "hard" ? "due" : "aiming at"} ${when}.${rate}`;
    }
    const cannot = p.exceedsWeekMin != null ? `, more than a normal week's ${hrs(p.exceedsWeekMin)} of free time` : "";
    return `On hold, and the date is getting tight — ${left} before ${when}, ${weeks} week${weeks > 1 ? "s" : ""} away. Starting now would take ${hrs(p.holdRateNeededMin)}/wk${cannot}.`;
  }

  const on = p.nextDate!.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const date = p.nextDateLabel === "deadline" ? `the ${p.nextDateKind} deadline, ${on}` : `“${p.nextDateLabel}” on ${on}`;

  // When pace is against a phase rather than the whole commitment, the figures
  // have to say so: "3h of 12h" next to a bar reading 3h/80h is otherwise read
  // as a contradiction. Naming the date inside the progress phrase also stops it
  // being repeated at the end of every branch.
  const scoped = p.scopeMin != null && p.estimateMin != null && p.scopeMin < p.estimateMin;
  const progress = scoped
    ? `${hrs(p.loggedMin)} of the ${hrs(p.scopeMin!)} due by ${date}`
    : p.scopeMin
      ? `${hrs(p.loggedMin)} of ${hrs(p.scopeMin)}`
      : hrs(p.loggedMin);
  const by = scoped ? "" : ` ${date}`;

  // A rate no week can hold is not a rate — the honest reading is that the date
  // has to move, and the sentence has to say so or it advises the impossible.
  const impossible = p.exceedsWeekMin != null ? `, which is more than the ${hrs(p.exceedsWeekMin)} a normal week has free` : "";

  if (p.status === "not_started") return `${progress} — nothing logged yet${scoped ? "" : `,${by}`}.`;
  if (p.status === "slipping") {
    const late = Math.max(1, Math.round(p.slipWeeks!));
    const push = p.nextDateKind === "hard" ? "needs" : "move the date, or go";
    const past = scoped ? "late" : `past${by}`;
    return `${progress}. At ${hrs(p.weeklyRateMin!)}/wk this lands about ${late} week${late > 1 ? "s" : ""} ${past} — ${push} ${hrs(p.rateToHitMin!)}/wk${impossible}.`;
  }
  if (p.status === "ahead") return `${progress} — comfortably ahead${scoped ? "" : ` of${by}`}.`;
  return `${progress} — on pace${scoped ? "" : ` for${by}`}, without much slack.`;
}

/** Pace from the shape the UI already holds, so the four places that need it
 * don't each rebuild the argument list — and can't drift apart in what they pass. */
export function paceFromData(
  data: {
    projects: Project[];
    targets: Target[];
    progressFacts: { byProject: Record<string, number> };
    inputs: { weeklyHours: WeeklyHours; recurringRules: { days: number[]; length: number }[] };
    reserve?: WeeklyReserve;
  },
  now: Date,
): CommitmentPace[] {
  return computePace({
    projects: data.projects,
    targets: data.targets,
    loggedByProject: data.progressFacts.byProject,
    weeklyHours: data.inputs.weeklyHours,
    // A normal week rather than this one: the question "is that rate even
    // possible" is about every week between now and the date.
    bookableWeekMin: data.reserve
      ? typicalBookableWeekMin(data.inputs.weeklyHours, data.inputs.recurringRules, data.reserve)
      : null,
    now,
  });
}
