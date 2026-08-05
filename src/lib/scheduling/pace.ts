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
  | "slipping";

export interface CommitmentPace {
  projectId: string;
  title: string;
  important: boolean;
  status: PaceStatus;
  /** Why pace can't be computed — shown so the gap is fixable rather than a shrug. */
  missing: ("estimate" | "date" | "weekly hours")[];
  estimateMin: number | null;
  loggedMin: number;
  remainingMin: number | null;
  /** 0-1, or null without an estimate. */
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

  return projects.map((p) => {
    const estimateMin = p.effortEstimateMin ?? null;
    const loggedMin = loggedByProject[p.id] ?? 0;
    const weeklyRateMin = p.weeklyMinMin ?? null;
    const remainingMin = estimateMin == null ? null : Math.max(0, estimateMin - loggedMin);
    const fractionDone = estimateMin == null ? null : Math.min(1, loggedMin / estimateMin);

    // The soonest date still to be met. An unmet target comes before the
    // commitment's own deadline, because that's the one pace is against now.
    const openTargets = targets
      .filter((t) => t.projectId === p.id && !t.completedAt && t.date.getTime() > now.getTime())
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    const nextTarget = openTargets[0];
    const deadline = p.deadlineDate && p.deadlineDate.getTime() > now.getTime() ? p.deadlineDate : null;
    const useTarget = nextTarget && (!deadline || nextTarget.date.getTime() <= deadline.getTime());
    const nextDate = useTarget ? nextTarget.date : deadline;
    const nextDateKind = nextDate ? (useTarget ? (nextTarget.dateKind ?? "goal") : (p.deadlineKind ?? "hard")) : null;
    const nextDateLabel = nextDate ? (useTarget ? nextTarget.title : "deadline") : null;

    const missing: CommitmentPace["missing"] = [];
    if (estimateMin == null) missing.push("estimate");
    if (!nextDate) missing.push("date");
    if (!weeklyRateMin) missing.push("weekly hours");

    const base = {
      projectId: p.id,
      title: p.title,
      important: !!p.important,
      missing,
      estimateMin,
      loggedMin,
      remainingMin,
      fractionDone,
      weeklyRateMin,
      nextDate,
      nextDateKind,
      nextDateLabel,
    };

    if (missing.length) {
      return { ...base, status: "unmeasurable" as PaceStatus, weeksNeeded: null, weeksAvailable: null, slipWeeks: null, rateToHitMin: null };
    }

    const weeksNeeded = remainingMin! / weeklyRateMin!;
    // Never below a fraction of a week: a date two days out still has some time
    // in it, and dividing by zero would report everything as slipping.
    const weeksAvailable = Math.max(0.1, (nextDate!.getTime() - now.getTime()) / MS_PER_WEEK);
    const rateToHitMin = Math.ceil(remainingMin! / weeksAvailable);

    // Already finished the estimated effort — nothing left to be late for.
    if (remainingMin === 0) {
      return { ...base, status: "ahead" as PaceStatus, weeksNeeded: 0, weeksAvailable, slipWeeks: null, rateToHitMin: 0 };
    }
    if (loggedMin === 0) {
      return { ...base, status: "not_started" as PaceStatus, weeksNeeded, weeksAvailable, slipWeeks: null, rateToHitMin };
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
    };
  });
}

/** One line a person can act on. Kept here so the board, the chat snapshot and
 * the timeline all say the same thing about the same commitment. */
export function paceSentence(p: CommitmentPace): string {
  const hrs = (min: number) => `${+(min / 60).toFixed(1)}h`;
  if (p.status === "unmeasurable") {
    const list =
      p.missing.length > 1 ? `${p.missing.slice(0, -1).join(", ")} and ${p.missing[p.missing.length - 1]}` : p.missing[0];
    return `Pace unknown — needs ${list} to be measurable.`;
  }
  const progress = p.estimateMin ? `${hrs(p.loggedMin)} of ${hrs(p.estimateMin)}` : hrs(p.loggedMin);
  const on = p.nextDate!.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const by = p.nextDateLabel === "deadline" ? `the ${p.nextDateKind} deadline, ${on}` : `“${p.nextDateLabel}” on ${on}`;
  if (p.status === "not_started") return `${progress} — nothing logged yet, ${by}.`;
  if (p.status === "slipping") {
    const late = Math.max(1, Math.round(p.slipWeeks!));
    const push = p.nextDateKind === "hard" ? "needs" : "move the date, or go";
    return `${progress}. At ${hrs(p.weeklyRateMin!)}/wk this lands about ${late} week${late > 1 ? "s" : ""} past ${by} — ${push} ${hrs(p.rateToHitMin!)}/wk.`;
  }
  if (p.status === "ahead") return `${progress} — comfortably ahead of ${by}.`;
  return `${progress} — on pace for ${by}, without much slack.`;
}
