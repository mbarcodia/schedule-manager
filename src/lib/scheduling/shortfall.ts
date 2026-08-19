// What would have to give, when a week cannot hold everything asked of it.
//
// The engine already answers "what fits" — it maximises against every rule it
// has (deadlines first, then priority, then pace slack) and reports the
// leftovers through `overflow` and `unplaced`. What it never answered is the
// question the user is actually left holding: WHICH OF MY RULES SHOULD I BEND,
// AND WHAT WOULD IT BUY ME. A list of names that didn't fit is a problem
// statement; this turns it into a set of costed choices.
//
// Two things this deliberately does NOT do:
//
//   IT NEVER APPLIES ANYTHING. Every option here is a proposal with a number
//   attached. Trimming a weekly minimum or moving a deadline is a decision
//   about someone's work, not an optimisation the scheduler gets to make on
//   their behalf, and an app that quietly rewrote its own targets to look
//   green would be worse than useless.
//
//   IT DOES NOT INVENT CAPACITY. `freesMin` is measured against what the
//   engine actually placed, so an option that would free four hours says four
//   hours because four hours of that commitment really are sitting unplaced —
//   not because four hours were asked for in the abstract.
//
// A shortfall here means the week was asked for more than it can hold. That is
// not automatically a failure: a week broken up by travel legitimately holds
// less, and the label share target already scales for it. It becomes worth
// reporting when work is left OWED — the hours are still on the books and have
// to land somewhere or be given up on purpose.

import { resolveDayWindow } from "./day-window";
import type { ComputeScheduleResult, ScheduleInputs } from "./types";

/** One thing the user could change, and what it would buy. */
export interface ShortfallOption {
  kind: "defer" | "trim_weekly" | "lower_label_target" | "move_deadline";
  /** One sentence, already carrying its own numbers — quote it rather than
   * rephrasing, the way the day-focus outcomes are quoted. */
  label: string;
  /** Minutes this frees in the week it applies to. Measured, not estimated. */
  freesMin: number;
  /** What it costs, said plainly. Every one of these has a cost; an option
   * presented without one reads as free and gets taken by default. */
  cost: string;
  /** Enough to act on without re-resolving anything by title. */
  target: { projectId?: string; taskId?: string; labelId?: string };
}

export interface WeekShortfall {
  /** 0 = the current week, 1 = next. */
  weekIndex: number;
  weekLabel: string;
  /** Working minutes left in the week, after meetings, routines and
   * everything already placed. */
  freeMin: number;
  /** Hours still owed per commitment, after the engine did its best. */
  owed: { projectId: string; title: string; owedMin: number }[];
  /** Label share targets that came up short, with what was asked vs placed. */
  labels: { labelId: string; label: string; targetMin: number; plannedMin: number; shortfallMin: number }[];
  totalOwedMin: number;
  /** Ranked, biggest saving first. Empty when the week holds everything. */
  options: ShortfallOption[];
}

const fmtH = (min: number): string => `${(min / 60).toFixed(1).replace(/\.0$/, "")}h`;

/** Working minutes left on one grid day, after everything already placed. */
function freeMinutesOnDay(inputs: ScheduleInputs, schedule: ComputeScheduleResult, gday: number): number {
  const win = resolveDayWindow(gday, inputs.weeklyHours, inputs.dayOverrides, inputs.allDayBlocks);
  if (!win) return 0;
  const taken = new Set<number>();
  for (const b of schedule.blocks) {
    if (b.gday !== gday || b.allDay) continue;
    for (let m = Math.max(b.start, win.start); m < Math.min(b.end, win.end); m++) taken.add(m);
  }
  let free = 0;
  for (let m = win.start; m < win.end; m++) if (!taken.has(m)) free++;
  return free;
}

/** Free working minutes across one whole week. */
export function freeMinutesInWeek(inputs: ScheduleInputs, schedule: ComputeScheduleResult, week: number): number {
  let total = 0;
  for (let g = week * 7; g < week * 7 + 7; g++) total += freeMinutesOnDay(inputs, schedule, g);
  return total;
}

/** The weeks to report on. Two: this one and the next.
 *
 * One week is not enough to act on — the commonest fix is "push it to next
 * week", and recommending that into a week which is already worse is how a
 * shortfall gets moved around instead of resolved. The full horizon is the
 * other extreme: distant weeks are the least reliable (meetings not yet
 * booked, hours not yet set) and reporting them turns a live warning into
 * noise. */
const WEEKS_REPORTED = 2;

export function computeShortfall(
  inputs: ScheduleInputs,
  schedule: ComputeScheduleResult,
): WeekShortfall[] {
  const out: WeekShortfall[] = [];
  const projectById = new Map(inputs.projects.map((p) => [p.id, p]));

  for (let week = 0; week < WEEKS_REPORTED; week++) {
    // What the engine still says it owes for this week's weekly-hours work.
    // `unplaced` carries the synthesized per-week research def ids, which is
    // the only place the leftover minutes survive as a number rather than a
    // name — overflow dedupes by title and loses the amount.
    const owed: WeekShortfall["owed"] = [];
    for (const u of schedule.unplaced) {
      const m = /^research-(.+)-w(\d+)$/.exec(u.id);
      if (!m || Number(m[2]) !== week) continue;
      const project = projectById.get(m[1]);
      if (!project || u.remainingMin <= 0) continue;
      owed.push({ projectId: m[1], title: project.title, owedMin: u.remainingMin });
    }
    owed.sort((a, b) => b.owedMin - a.owedMin);
    const totalOwedMin = owed.reduce((n, o) => n + o.owedMin, 0);

    // Label targets for this week. labelTargetsByWeek is per-week where the
    // engine computed it; labelTargets is week 0 only.
    const perWeek = schedule.labelTargetsByWeek?.[week] ?? (week === 0 ? schedule.labelTargets : []);
    const labels = (perWeek ?? [])
      .map((t) => ({
        labelId: t.labelId,
        label: t.label,
        targetMin: t.targetMin,
        plannedMin: t.plannedMin,
        shortfallMin: Math.max(0, t.targetMin - t.plannedMin),
      }))
      .filter((l) => l.shortfallMin > 0);

    const freeMin = freeMinutesInWeek(inputs, schedule, week);

    // Nothing owed means the week held what it was asked for. Say nothing —
    // a banner that is always up is a banner nobody reads.
    if (totalOwedMin <= 0) {
      out.push({
        weekIndex: week,
        weekLabel: week === 0 ? "This week" : "Next week",
        freeMin,
        owed,
        labels,
        totalOwedMin,
        options: [],
      });
      continue;
    }

    const options: ShortfallOption[] = [];

    // 1. DEFER — push a commitment's owed hours to a later week. Only offered
    // when a later week actually has room for them; "move it to next week"
    // into a week with no space is the advice that makes this whole report
    // untrustworthy.
    const laterFree = freeMinutesInWeek(inputs, schedule, week + 1);
    for (const o of owed) {
      if (o.owedMin > laterFree) continue;
      options.push({
        kind: "defer",
        label: `Defer ${o.title}'s ${fmtH(o.owedMin)} to ${week === 0 ? "next week" : `week ${week + 2}`}`,
        freesMin: o.owedMin,
        cost: `That week has ${fmtH(laterFree)} free now, so it would absorb this — but it then owes its own hours on top.`,
        target: { projectId: o.projectId },
      });
    }

    // 2. TRIM A WEEKLY MINIMUM — permanently ask for less, rather than going
    // short every week and reporting it every week. The honest option when a
    // rate was set against a week the user does not actually have.
    //
    // THE RATE HAS TO BE CONVERTED BACK THROUGH THE LABEL SCALE. The number on
    // the commitment is a RATIO, not a total: with a label share target set,
    // the engine scales every rate under that label to hit the target, so a
    // 6h/wk commitment can be asked for 7.5h. Proposing a new rate from the
    // scaled figures gives a number that means nothing in the field the user
    // would actually edit — this divides back out, so "cut to 2.8h/wk" is the
    // number to type into the panel.
    for (const o of owed) {
      const project = projectById.get(o.projectId);
      const rate = project?.weeklyMinMin ?? project?.weeklyMinMinOnHold;
      if (!rate) continue;
      const scaledTarget = schedule.weeklyTargetMinByProject?.[o.projectId] ?? rate;
      const placedMin = Math.max(0, scaledTarget - o.owedMin);
      // Back through the scale: placed is a scaled figure, the rate is not.
      const achievable = Math.round(((placedMin * rate) / (scaledTarget || rate)) / 15) * 15;
      if (achievable >= rate) continue;
      options.push({
        kind: "trim_weekly",
        label: `Cut ${o.title} from ${fmtH(rate)}/wk to ${fmtH(achievable)}/wk`,
        freesMin: o.owedMin,
        cost:
          achievable === 0
            ? `Only ${fmtH(placedMin)} of it fits, so this parks it entirely — putting it on hold instead keeps the rate for when it resumes.`
            : `${fmtH(placedMin)} of its ${fmtH(scaledTarget)} ask fits this week. Its own dates get further away at the lower rate; check its pace first.`,
        target: { projectId: o.projectId },
      });
    }

    // 3. LOWER A LABEL'S SHARE TARGET — the root-cause option. A percentage is
    // a share of the week's AVAILABLE time, so a target set against a notional
    // 40-hour week asks for hours a meeting-heavy week never had.
    for (const l of labels) {
      const capacityMin = (perWeek ?? []).find((t) => t.label === l.label)?.capacityMin ?? 0;
      if (!capacityMin) continue;
      const fittablePct = Math.floor((l.plannedMin / capacityMin) * 100);
      const currentPct = (perWeek ?? []).find((t) => t.label === l.label)?.pct;
      if (currentPct == null || fittablePct >= currentPct) continue;
      options.push({
        kind: "lower_label_target",
        label: `Lower the ${l.label} target from ${currentPct}% to about ${fittablePct}% of the week`,
        freesMin: l.shortfallMin,
        cost: `${currentPct}% of ${fmtH(capacityMin)} available asks ${fmtH(l.targetMin)}; only ${fmtH(l.plannedMin)} fits. This makes the target honest rather than making the week bigger.`,
        target: { labelId: l.labelId },
      });
    }

    // 4. MOVE A DEADLINE — dated work is the one thing weekly minimums can
    // never outrank, so it is also the only thing whose removal reliably frees
    // the contested slots. Offered last and always as a question: a deadline
    // is the user's commitment to someone else, not a scheduling parameter.
    const weekStart = week * 7 * 1440;
    const weekEnd = weekStart + 7 * 1440;
    const datedInWeek = new Map<string, number>();
    for (const b of schedule.blocks) {
      if (b.gday < week * 7 || b.gday >= week * 7 + 7 || !b.taskId || b.projectId) continue;
      const t = inputs.tasks.find((x) => x.id === b.taskId);
      if (!t || t.deadline === 99999) continue;
      datedInWeek.set(b.taskId, (datedInWeek.get(b.taskId) ?? 0) + (b.end - b.start));
    }
    for (const [taskId, min] of [...datedInWeek].sort((a, z) => z[1] - a[1]).slice(0, 3)) {
      const t = inputs.tasks.find((x) => x.id === taskId);
      if (!t) continue;
      const dueDay = Math.floor(t.deadline / 1440);
      const thatWeek = week === 0 ? "this week" : "next week";
      options.push({
        kind: "move_deadline",
        label: `Move "${t.title}" (${fmtH(min)}) out of ${thatWeek}`,
        freesMin: min,
        cost:
          dueDay >= weekEnd / 1440
            ? `It is already due after ${thatWeek} and only sits there because it fits — moving it costs nothing but its own slack.`
            : `It is really due ${thatWeek}, so this means renegotiating the date.`,
        target: { taskId },
      });
    }

    options.sort((a, b) => b.freesMin - a.freesMin);

    out.push({
      weekIndex: week,
      weekLabel: week === 0 ? "This week" : "Next week",
      freeMin,
      owed,
      labels,
      totalOwedMin,
      options,
    });
  }

  return out;
}

/** A compact, quotable summary — the form the chat snapshot and the calendar
 * banner both want. Null when both weeks hold what they were asked for. */
export function describeShortfall(weeks: WeekShortfall[]): string | null {
  const live = weeks.filter((w) => w.totalOwedMin > 0);
  if (!live.length) return null;
  return live
    .map((w) => {
      const owed = w.owed.map((o) => `${o.title} ${fmtH(o.owedMin)}`).join(", ");
      return `${w.weekLabel}: ${fmtH(w.totalOwedMin)} owed and ${fmtH(w.freeMin)} free — ${owed}.`;
    })
    .join(" ");
}
