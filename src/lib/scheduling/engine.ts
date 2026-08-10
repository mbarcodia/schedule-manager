// The scheduling engine — ported faithfully from the prototype's embedded
// `class Component` (Schedule Manager.dc.html), algorithm intact:
//   1. Fixed meetings claim their time first.
//   2. Recurring rules slide within their placement window around meetings.
//   3. Weekly research chunks are generated per project, fenced to their own
//      week, mornings first.
//   4. Remaining tasks are placed by priority → explicit order → deadline,
//      respecting dependencies, per-day pacing caps, and earliest-start
//      floors. A chunk that doesn't fit shrinks to fill gaps, down to its
//      category's min_chunk_min (or 30m if the category has none set).
//   5. Two-pass re-optimization: pass 1 plans the whole horizon ignoring
//      completions (to see where past chunks landed); past chunks are then
//      credited/re-fed and pass 2 reschedules everything from "now" forward.
//
// Production changes from the prototype (per the handoff README):
//   - Horizon is a parameter (12 weeks in production, was hardcoded to 8).
//   - Weekends are skipped unless a DayOverride explicitly allows one.
//   - "Now" and calendar-date conversions are timezone-aware (see time.ts).

import { fmtMin, nowAbsMinute } from "./time";
import { defaultDayWindow, resolveDayWindow } from "./day-window";
import { ROUTINE_TAG_LABEL } from "./types";
import type {
  AbsMinute,
  ComputeScheduleResult,
  GDay,
  MinuteOfDay,
  Priority,
  RoutineAnchor,
  ScheduleBlock,
  ScheduleInputs,
  Task,
  UnplacedWork,
} from "./types";

function priorityRank(p: Priority): number {
  return p === "high" ? 3 : p === "medium" ? 2 : 1;
}

/** The word in a block's corner: the name of its label, or nothing at all when
 * it has none. Deliberately no fallback — the built-in kind names this replaced
 * are what made "time block names" confusing enough to remove (migration
 * 0030), so an unlabelled block says nothing rather than something invented. */
function labelTag(inputs: ScheduleInputs, categoryId: string | null | undefined): string | null {
  return categoryId ? (inputs.labelNames[categoryId] ?? null) : null;
}

const FALLBACK_WINDOW = { start: 9 * 60, end: 17 * 60 };

interface AnchorDef {
  gday: GDay;
  winStart: MinuteOfDay;
  winEnd: MinuteOfDay;
  length: number;
  title: string;
  ruleId: string;
  /** Set when the routine holds an end of the day rather than a clock time; the
   * window above is then a placeholder, recomputed from the day's real hours
   * where they're resolved. See anchoredWindow. */
  anchor?: RoutineAnchor | null;
}

/** How tightly a routine's own definition pins it down — lowest goes first, so
 * a slot that can only be in one place isn't taken by one that could have gone
 * anywhere. Previously they were placed in whatever order the rows arrived in,
 * which decided contention arbitrarily.
 *
 * An anchored routine sits between fixed and flexible on purpose: it wants the
 * edge of the day but may drift, so a 9:00 lab meeting still beats it to 9:00,
 * while a "wherever it fits" block no longer takes the opening out from under
 * the thing that is meant to start the day. */
function anchorTightness(a: AnchorDef): number {
  if (a.anchor === "day_start") return 1;
  if (a.anchor === "day_end") return 3;
  return a.winEnd - a.winStart <= a.length ? 0 : 2;
}

function anchorDefs(inputs: ScheduleInputs): AnchorDef[] {
  const list: AnchorDef[] = [];
  for (let w = 0; w < inputs.horizonWeeks; w++) {
    inputs.recurringRules.forEach((r) => {
      r.days.forEach((d) => {
        if (d < 0 || d > 4) return;
        const gday = w * 7 + d;
        const dayDefault = defaultDayWindow(gday, inputs.weeklyHours) ?? FALLBACK_WINDOW;
        list.push({
          gday,
          winStart: r.winStart != null ? r.winStart : dayDefault.start,
          winEnd: r.winEnd != null ? r.winEnd : dayDefault.end,
          length: r.length,
          title: r.title,
          ruleId: r.id,
          anchor: r.anchor ?? null,
        });
      });
    });
  }
  return list.sort((a, b) => a.gday - b.gday || anchorTightness(a) - anchorTightness(b));
}

/** The window an anchored routine may be placed in on one day, given that day's
 * real working hours (overrides included).
 *
 * It starts at the edge it holds and reaches to the MIDPOINT of the day — the
 * generic form of "slide within the morning, or skip". Half the window rather
 * than literally noon: a day running 1pm-5pm has a first half too, and 12:00
 * would make an anchored routine on it either impossible (day_start) or free to
 * drift across the whole day (day_end). Always at least `length` wide, so a very
 * short day still places the routine at its edge instead of dropping it. */
function anchoredWindow(
  anchor: RoutineAnchor,
  win: { start: MinuteOfDay; end: MinuteOfDay },
  length: number,
): { start: MinuteOfDay; end: MinuteOfDay } {
  const mid = win.start + Math.round((win.end - win.start) / 2);
  return anchor === "day_start"
    ? { start: win.start, end: Math.min(win.end, Math.max(mid, win.start + length)) }
    : { start: Math.max(win.start, Math.min(mid, win.end - length)), end: win.end };
}

/** A task definition normalized for the scheduler's internal loop — includes
 * the auto-generated weekly research chunks alongside real tasks. */
interface TaskDef extends Task {
  ord: number;
}

/** The working minutes a label's percentage is a share OF, on one of two
 * readings the user picks per label (categories.target_basis, migration 0038).
 *
 * "week" — the week's whole working window. Days off and away days are out of
 * it, because those hours don't exist; MEETINGS ARE STILL IN. "40% of my
 * 40-hour week is 16 hours" is the stated meaning, and it stays 16 in a week
 * with six meetings in it. The consequence is deliberate: a week too full to
 * hold the target reports a shortfall rather than quietly lowering the bar,
 * which is the thing worth knowing about such a week.
 *
 * "after_meetings" — what is left once meetings are removed, so the goal shrinks
 * to fit and is almost always met. The right reading for work that only ever
 * happens in the gaps.
 *
 * NEITHER subtracts routines, on both readings. Some routines (a literature
 * scan, a proposal search) are the very work the target is about — taking them
 * off the top and then asking for 40% of the rest charges for them twice. A
 * labelled routine instead COUNTS TOWARD its share; see labelScaleForWeek.
 *
 * `busy` must be a snapshot taken after events and pins are marked but BEFORE
 * anchors, and long before any auto-placed work.
 *
 * Mon-Fri only, matching the fence weekly hours are generated inside. */
function weekCapacityMin(
  inputs: ScheduleInputs,
  busy: Set<AbsMinute>,
  w: number,
  basis: "week" | "after_meetings" = "week",
): number {
  let free = 0;
  for (let d = 0; d < 5; d++) {
    const gday = w * 7 + d;
    const win = resolveDayWindow(gday, inputs.weeklyHours, inputs.dayOverrides, inputs.allDayBlocks);
    if (!win) continue;
    const base = gday * 1440;
    if (basis === "week") {
      free += win.end - win.start;
      continue;
    }
    for (let m = win.start; m < win.end; m++) if (!busy.has(base + m)) free++;
  }
  return free;
}

/** Minutes of labelled ROUTINE time that land in week w, per label.
 *
 * A weekly literature scan wearing the Research label is research: it counts
 * toward the share, and so reduces what the commitments wearing that label are
 * asked to supply. Without this, "projects, proposals and literature reading
 * combined should get 40%" overshoots by however much the routines add.
 *
 * Counted from the rule rather than from placed blocks, because this feeds the
 * scaling that decides what to place. A routine that turns out not to fit is a
 * separate matter, and one the week view reports. */
function labelledRoutineMinForWeek(inputs: ScheduleInputs, w: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of inputs.recurringRules) {
    if (!r.categoryId) continue;
    for (const d of r.days) {
      if (d < 0 || d > 4) continue;
      const gday = w * 7 + d;
      if (!resolveDayWindow(gday, inputs.weeklyHours, inputs.dayOverrides, inputs.allDayBlocks)) continue;
      out[r.categoryId] = (out[r.categoryId] ?? 0) + r.length;
    }
  }
  return out;
}

/** How much a label's weekly hours should be multiplied by this week to hit its
 * percentage-of-capacity target, keyed by label id. 1 (or absent) = leave the
 * declared minutes alone.
 *
 * The declared per-commitment minutes become a RATIO under a target: 6h/4h/3h
 * stays 2:1.33:1 whatever the week holds. Scaling is per week, so a conference
 * week shrinks every project in step instead of the engine trying to force a
 * full week of research into it and reporting the remainder as not fitting. */
function labelScaleForWeek(
  inputs: ScheduleInputs,
  busy: Set<AbsMinute>,
  w: number,
): Record<string, number> {
  const targets = inputs.labelTargetPct ?? {};
  if (!Object.keys(targets).length) return {};
  const routineMin = labelledRoutineMinForWeek(inputs, w);
  const scale: Record<string, number> = {};
  for (const [labelId, pct] of Object.entries(targets)) {
    const declared = inputs.projects
      .filter((p) => p.weeklyMinMin && p.categoryId === labelId)
      .reduce((sum, p) => sum + p.weeklyMinMin!, 0);
    // Nothing wearing the label carries hours, so there is nothing to scale —
    // a target can't invent a project to spend the time on.
    if (!declared) continue;
    const capacity = weekCapacityMin(inputs, busy, w, inputs.labelTargetBasis?.[labelId] ?? "week");
    // Routines wearing this label have already met part of the share, so the
    // commitments are asked for the rest. Floored at zero: routines alone can
    // exceed a small target, and asking for negative hours is not a thing.
    const remaining = Math.max(0, (capacity * pct) / 100 - (routineMin[labelId] ?? 0));
    scale[labelId] = remaining / declared;
  }
  return scale;
}

/** The weekly minutes a commitment should get under a share target, chosen so it
 * decomposes into whole chunks with NO tail shorter than its minimum chunk.
 *
 * Rounding the scaled figure to 5 minutes was not enough: 6h scaled by 1.014
 * gives 365 minutes, and against a 120-minute chunk that lands as 120+120+120+5,
 * putting a 5-MINUTE research block on a Monday morning. The engine's
 * minimum-chunk floor doesn't catch it, because that floor governs shrinking a
 * block to fit a gap, not the leftover at the end of a duration.
 *
 * So the duration is snapped to a value that divides cleanly: a tail is either
 * zero, or at least one minimum chunk long. Where that means moving off the
 * exact target it moves to whichever clean value is nearer — a few minutes
 * either side of a percentage-derived goal is not meaningful, and a 5-minute
 * block is.
 *
 * Returns 0 when not even one placeable block fits the share, which is the
 * honest answer for a week mostly eaten by travel. */
export function scaledWeeklyMin(
  declaredMin: number,
  scale: number,
  chunkMin: number,
  floorMin: number,
): number {
  if (scale === 1) return declaredMin;
  const chunk = Math.max(1, chunkMin);
  const raw = declaredMin * scale;
  if (raw < floorMin) return 0;

  const whole = Math.floor(raw / chunk) * chunk;
  const tail = raw - whole;
  if (tail === 0) return whole;
  // A tail at or above the floor is a legitimate block in its own right, rounded
  // to the 15-minute grid findSlot actually places on — rounding to 5 produced
  // lengths like 65 minutes that can never start on a grid boundary and end on
  // one, and read as oddly precise for a goal derived from a percentage.
  if (tail >= floorMin) return whole + Math.round(tail / 15) * 15;
  // Otherwise it cannot stand alone: drop it, or grow it to the floor.
  const up = whole + floorMin;
  if (whole === 0) return up;
  return raw - whole <= up - raw ? whole : up;
}

/** Chunk lengths worth trying for a task's next block, longest first.
 *
 * Two rules, both about the minimum chunk:
 *   1. no length is below the floor
 *   2. no length leaves a remainder too small to place on its own — that
 *      remainder becomes the NEXT block, so allowing it just breaks rule 1 one
 *      iteration later
 *
 * Rule 1 is why a project with a 30-minute chunk under a label whose floor is 60
 * now gets 60-minute blocks. The preferred chunk size used to be applied first
 * and the floor only consulted when shrinking to fit a gap, so a chunk smaller
 * than the floor produced blocks below it without the floor ever being read —
 * silently breaking the guarantee the floor exists to make (migration 0013).
 *
 * Rule 2 is why a 150-minute task with a 60-minute floor is placed 60+90 rather
 * than 60+60+30. Greedy chunking hands the leftover to the final block, which is
 * precisely where a sliver appears.
 */
export function chunkLengthsToTry(remaining: number, chunk: number, floorMin: number): number[] {
  // A task shorter than the floor has nothing to honour — it is placed at its
  // real length rather than being made unschedulable.
  const floor = Math.min(floorMin, remaining);
  const viable = (len: number) => {
    if (len < floor || len > remaining) return false;
    const left = remaining - len;
    return left === 0 || left >= floor;
  };
  const preferred = Math.min(remaining, Math.max(chunk || remaining, floor));
  const lens: number[] = [];
  const add = (len: number) => {
    if (viable(len) && !lens.includes(len)) lens.push(len);
  };

  // When the preferred size would orphan a sliver, folding the tail into this
  // block comes first — better one longer block than a stranded remainder.
  if (remaining - preferred > 0 && remaining - preferred < floor) add(remaining);
  for (let len = preferred; len >= floor; len -= 30) add(len);
  add(floor);
  return lens;
}

function taskDefs(inputs: ScheduleInputs, labelScaleByWeek: Record<string, number>[] = []): TaskDef[] {
  const research: TaskDef[] = [];
  for (let w = 0; w < inputs.horizonWeeks; w++) {
    const labelScale = labelScaleByWeek[w] ?? {};
    // A week's chunk is fenced to Mon-Fri of that week. An active window
    // narrows that fence further, so a project that starts in December
    // simply generates nothing for the weeks before it and a partial chunk for
    // the week it begins mid-way through — rather than booking hours from today
    // the moment it's created.
    const weekFloor = w * 7 * 1440;
    const weekCeil = (w * 7 + 5) * 1440;
    inputs.projects
      .filter((p) => p.weeklyMinMin)
      .forEach((p) => {
        const floor = Math.max(weekFloor, p.activeFromAbs ?? weekFloor);
        const ceilAbs = Math.min(weekCeil, p.activeUntilAbs ?? weekCeil);
        // The window closes this project out of this week entirely, or
        // leaves too little of it to be worth a block.
        if (ceilAbs - floor < (p.minChunk ?? 30)) return;
        // `?? 1`, never `|| 1`: a scale of 0 is meaningful (a week with no
        // capacity at all, e.g. one entirely inside a conference) and `||`
        // silently promoted it to 1, so exactly the weeks that should generate
        // nothing instead asked for the full declared hours and reported every
        // project as not fitting.
        const scale = (p.categoryId ? labelScale[p.categoryId] : undefined) ?? 1;
        const scaled = scaledWeeklyMin(p.weeklyMinMin!, scale, p.chunk || 120, p.minChunk ?? 30);
        // Nothing placeable this week — the honest outcome in a week eaten by
        // travel, and the same "closed out of this week" case the active-window
        // check above handles. Emphatically NOT rounded up to a minimum block:
        // that forced one into a week with no room for it and reported every
        // project as "didn't fit".
        if (scaled <= 0) return;
        research.push({
          id: `research-${p.id}-w${w}`,
          title: p.title,
          priority: "high",
          duration: scaled,
          chunk: p.chunk || 120,
          minChunk: p.minChunk,
          dependsOn: null,
          floor,
          ceilAbs,
          deadline: 99999,
          projectId: p.id,
          categoryId: p.categoryId ?? null,
          ord: (p.researchOrd || 5) + w * 10,
          // Where these hours belong is the commitment's own business (or its
          // label's). It used to be decided for it: the scheduler keyed a
          // morning preference off an internal "research" tag, so every
          // weekly-hours block wanted mornings whatever the project said.
          timeOfDay: p.timeOfDay ?? null,
          preferMorning: !!p.preferMorning,
          preferAfternoon: !!p.preferAfternoon,
        });
      });
  }
  return [
    ...research,
    ...inputs.tasks.map((t) => ({ ...t, ord: t.ord ?? 99 })),
  ];
}

interface Slot {
  gday: GDay;
  start: MinuteOfDay;
  end: MinuteOfDay;
  abs: AbsMinute;
}

/** Everything findSlot needs of the busy set. Widened from `Set` so a
 * SPECULATIVE placement run — "could this whole task fit on Tuesday?" — can
 * layer its trial chunks over the real set without copying it per candidate day.
 * See placeAllOnOneDay. */
interface BusyView {
  has(minute: AbsMinute): boolean;
}

function findSlot(
  inputs: ScheduleInputs,
  floorAbs: AbsMinute,
  lengthMin: number,
  constrainNoon: boolean,
  busy: BusyView,
  dayOk: ((gday: GDay) => boolean) | null,
  ceilAbs?: AbsMinute,
  constrainAfternoon?: boolean,
): Slot | null {
  for (let g = 0; g < inputs.horizonWeeks * 7; g++) {
    if (ceilAbs != null && g * 1440 >= ceilAbs) break;
    const win = resolveDayWindow(g, inputs.weeklyHours, inputs.dayOverrides, inputs.allDayBlocks);
    if (win == null) continue; // day off, no override turning it on
    if (dayOk && !dayOk(g)) continue;
    const base = g * 1440;
    const end = constrainNoon ? Math.min(win.end, 720) : win.end;
    const start = constrainAfternoon ? Math.max(win.start, 720) : win.start;
    if (constrainAfternoon && start >= end) continue; // day's window doesn't reach into the afternoon
    for (let m = start; m + lengthMin <= end; m += 15) {
      const abs = base + m;
      if (abs < floorAbs) continue;
      // Checked minute-by-minute (not in 15-min steps) so an off-grid busy
      // range — e.g. an 11:59 "right now" pin — is actually seen as an
      // obstacle even though this candidate start is itself grid-aligned.
      let free = true;
      for (let k = 0; k < lengthMin; k += 1) {
        if (busy.has(abs + k)) {
          free = false;
          break;
        }
      }
      if (ceilAbs != null && abs + lengthMin > ceilAbs) break;
      if (free) return { gday: g, start: m, end: m + lengthMin, abs };
    }
  }
  return null;
}

// Marks every minute in the range busy (not 15-min steps) so a block whose
// start/end isn't itself grid-aligned — e.g. an 11:59 "right now" pin —
// still correctly blocks any grid-aligned candidate slot that overlaps it.
export function markBusy(abs: AbsMinute, len: number, busy: Set<AbsMinute>): void {
  for (let k = 0; k < len; k += 1) busy.add(abs + k);
}

interface RunSchedulerResult {
  chunks: ScheduleBlock[];
  overflow: string[];
  beyondHorizon: string[];
  unplaced: UnplacedWork[];
  risk: string[];
  nearDeadline: string[];
}

/** tasks[].deadline uses this to mean "no deadline" (see from-db.ts). */
const NO_DEADLINE = 99999;

function runScheduler(
  inputs: ScheduleInputs,
  taskList: TaskDef[],
  busy: Set<AbsMinute>,
  floorMin: number,
  preDone: string[] | null,
): RunSchedulerResult {
  const chunks: ScheduleBlock[] = [];
  const remaining: (TaskDef & { remaining: number; stuckAt?: number; finishedAbs?: number | null })[] = taskList.map((t) => ({
    ...t,
    remaining: t.duration,
    finishedAbs: null as number | null,
  }));
  const doneSet = new Set<string>(preDone || []);
  remaining.forEach((t) => {
    if (t.remaining <= 0) {
      doneSet.add(t.id);
      t.remaining = 0;
    }
  });
  const perDay: Record<string, Record<number, number>> = {};

  let guard = 0;
  while (guard < 2000) {
    guard++;
    const ready = remaining.filter(
      (t) => t.remaining > 0 && (!t.dependsOn || doneSet.has(t.dependsOn)),
    );
    if (!ready.length) break;
    ready.sort(
      (a, b) =>
        priorityRank(b.priority) - priorityRank(a.priority) ||
        a.ord - b.ord ||
        a.deadline - b.deadline,
    );
    const t = ready[0];
    const floor = Math.max(t.floor || 0, floorMin || 0);
    let chunkLen = 0; // set from the chosen placement below

    /** Finds a slot honouring the task's half-of-day rules.
     *
     * `view` and `extraDayOk` exist for the one-day trial run, which searches
     * against the real busy set PLUS its own provisional chunks and confines
     * every candidate to a single day. Both default to the live search. */
    const tryLen = (
      len: number,
      ceil: number | undefined,
      view: BusyView = busy,
      extraDayOk: ((gday: GDay) => boolean) | null = null,
      usedToday: Record<number, number> = perDay[t.id] || {},
    ): Slot | null => {
      const capOk = t.maxPerDayMin ? (d: GDay) => (usedToday[d] || 0) + len <= t.maxPerDayMin! : null;
      const dayOk =
        capOk && extraDayOk
          ? (d: GDay) => capOk(d) && extraDayOk(d)
          : (capOk ?? extraDayOk);
      if (t.timeOfDay === "afternoon") return findSlot(inputs, floor, len, false, view, dayOk, ceil, true);
      if (t.timeOfDay === "morning") return findSlot(inputs, floor, len, true, view, dayOk, ceil);
      // A soft nudge takes the wrong half of the day over leaving the work
      // unscheduled — that's the whole difference from the constraints above.
      if (t.preferMorning)
        return (
          findSlot(inputs, floor, len, true, view, dayOk, ceil) ||
          findSlot(inputs, floor, len, false, view, dayOk, ceil)
        );
      if (t.preferAfternoon)
        return (
          findSlot(inputs, floor, len, false, view, dayOk, ceil, true) ||
          findSlot(inputs, floor, len, false, view, dayOk, ceil)
        );
      return findSlot(inputs, floor, len, false, view, dayOk, ceil);
    };

    // Capped by maxPerDayMin as well: "no block under 90 minutes" and "at most
    // 60 minutes of this a day" are both hard constraints, and honouring only
    // the floor would make the pair unschedulable rather than picking the
    // tighter one.
    const chunkFloor = Math.min(t.minChunk ?? 30, t.duration, t.maxPerDayMin ?? Infinity);
    /** The lengths this task's next block may take, longest first.
     *
     * "One block" collapses that to a single candidate — the whole of what's
     * left. Not expressible as a very large minimum chunk, because
     * chunkLengthsToTry caps the floor at `remaining` and would go on offering
     * shorter lengths beneath it. */
    const lengthsFor = (left: number): number[] =>
      t.splitMode === "one_block" ? [left] : chunkLengthsToTry(left, t.chunk ?? 0, chunkFloor);

    /** Places the chunk under a ceiling, trying shorter viable lengths to fit. */
    const placeUnder = (ceil: number | undefined): { slot: Slot; len: number } | null => {
      for (const len of lengthsFor(t.remaining)) {
        const found = tryLen(len, ceil);
        if (found) return { slot: found, len };
      }
      return null;
    };

    // A deadline bounds where the work may go, not just the order it's
    // considered in. Without this the search walks forward for a gap the size
    // of the preferred chunk and takes the first one it finds — happily landing
    // past the deadline when the time before it was free but only in smaller
    // pieces. Two hours of prep for a Wednesday talk went to Thursday because
    // Monday and Tuesday offered 90-minute holes rather than 120-minute ones.
    const deadlineCeil = t.deadline === NO_DEADLINE ? undefined : t.deadline;
    const withinDeadline =
      deadlineCeil == null ? undefined : t.ceilAbs == null ? deadlineCeil : Math.min(t.ceilAbs, deadlineCeil);

    /** Every chunk of this task on ONE day, or nothing.
     *
     * Deliberately not "place the first chunk normally, then pin the rest to
     * whatever day it landed on": the first chunk goes wherever it fits
     * earliest, which is routinely a day with no room for the remainder, and
     * that would refuse work a later day could have taken whole. So each day is
     * TRIED IN FULL — provisionally, against a layered busy view — and only a
     * day that can hold the entire duration is committed to. */
    const placeAllOnOneDay = (ceil: number | undefined): { slot: Slot; len: number }[] | null => {
      for (let g = 0; g < inputs.horizonWeeks * 7; g++) {
        // A pinned chunk has already been placed on a fixed day and its minutes
        // taken out of what's left here. The REST has to join it, or the pin
        // itself becomes the thing that breaks the one-day rule — which is how
        // dragging a task to "In progress" would have scattered it: the board
        // pins one chunk to today and leaves the remainder to be placed freely.
        if (t.pin && g !== t.pin.gday) continue;
        if ((g + 1) * 1440 <= floor) continue; // whole day is before the earliest start
        if (ceil != null && g * 1440 >= ceil) break;
        const trial = new Set<AbsMinute>();
        const view: BusyView = { has: (m) => busy.has(m) || trial.has(m) };
        const onThisDay = (d: GDay) => d === g;
        const usedToday: Record<number, number> = { ...(perDay[t.id] || {}) };
        const placements: { slot: Slot; len: number }[] = [];
        let left = t.remaining;
        // Bounded by the shortest legal chunk, so a day can never be retried
        // forever; 15 is findSlot's placement grid, the smallest step possible.
        let dayGuard = 0;
        while (left > 0 && dayGuard++ < 200) {
          let got: { slot: Slot; len: number } | null = null;
          for (const len of lengthsFor(left)) {
            const found = tryLen(len, ceil, view, onThisDay, usedToday);
            if (found) {
              got = { slot: found, len };
              break;
            }
          }
          if (!got) break;
          markBusy(got.slot.abs, got.len, trial);
          usedToday[got.slot.gday] = (usedToday[got.slot.gday] || 0) + got.len;
          placements.push(got);
          left -= got.len;
        }
        if (left <= 0) return placements;
      }
      return null;
    };

    if (t.splitMode === "one_day") {
      // Same two-step as below: prefer a day before the deadline, and fall back
      // to a later one rather than refusing outright — being late is a reported
      // outcome, whereas being split is the thing this mode forbids.
      const spread = (withinDeadline != null ? placeAllOnOneDay(withinDeadline) : null) ?? placeAllOnOneDay(t.ceilAbs);
      if (!spread) {
        t.stuckAt = t.remaining;
        t.remaining = -1;
        continue;
      }
      let endAbs = 0;
      for (const { slot, len } of spread) {
        markBusy(slot.abs, len, busy);
        perDay[t.id] = perDay[t.id] || {};
        perDay[t.id][slot.gday] = (perDay[t.id][slot.gday] || 0) + len;
        chunks.push({
          type: "task",
          taskId: t.id,
          projectId: t.projectId || null,
          categoryId: t.categoryId ?? null,
          tagLabel: labelTag(inputs, t.categoryId),
          title: t.title,
          gday: slot.gday,
          start: slot.start,
          end: slot.start + len,
          priority: t.priority,
        });
        t.remaining -= len;
        endAbs = Math.max(endAbs, slot.abs + len);
      }
      doneSet.add(t.id);
      t.finishedAbs = endAbs;
      continue;
    }

    let placed = withinDeadline != null ? placeUnder(withinDeadline) : null;
    // Nothing fits before the deadline even in the smallest pieces allowed —
    // schedule it late rather than not at all, and let the risk report say so.
    if (!placed) placed = placeUnder(t.ceilAbs);
    if (!placed) {
      // -1 is loop control: it takes the task out of the ready set so the
      // scheduler stops retrying a chunk that has nowhere to go. It also
      // overwrote how much was left, which is the one number an explanation
      // needs — so remember it before the sentinel lands.
      t.stuckAt = t.remaining;
      t.remaining = -1;
      continue;
    }
    const slot = placed.slot;
    chunkLen = placed.len;
    markBusy(slot.abs, chunkLen, busy);
    perDay[t.id] = perDay[t.id] || {};
    perDay[t.id][slot.gday] = (perDay[t.id][slot.gday] || 0) + chunkLen;
    chunks.push({
      type: "task",
      taskId: t.id,
      projectId: t.projectId || null,
      categoryId: t.categoryId ?? null,
      tagLabel: labelTag(inputs, t.categoryId),
      title: t.title,
      gday: slot.gday,
      start: slot.start,
      end: slot.start + chunkLen,
      priority: t.priority,
    });
    t.remaining -= chunkLen;
    if (t.remaining <= 0) {
      doneSet.add(t.id);
      t.finishedAbs = slot.abs + chunkLen;
    }
  }

  const horizonAbs = inputs.horizonWeeks * 7 * 1440;
  const unplaced = remaining.filter((t) => t.remaining > 0 || t.remaining === -1);
  const startsAfterHorizon = (t: { floor?: number }) => (t.floor ?? 0) >= horizonAbs;

  return {
    chunks,
    // Work that cannot START until after the horizon ends is not work that
    // didn't fit — there is no capacity question to answer about it yet, and
    // reporting it as overflow made "your week is too full" indistinguishable
    // from "this begins later than we plan". Split so the two can be worded
    // differently wherever they surface.
    overflow: [
      ...new Set(
        unplaced.filter((t) => !startsAfterHorizon(t)).map((t) => t.title),
      ),
    ],
    beyondHorizon: [...new Set(unplaced.filter(startsAfterHorizon).map((t) => t.title))],
    // The same facts keyed by id and carrying the shortfall, because a title
    // can't be matched back to a row (two tasks may share one) and "didn't fit"
    // is not actionable without knowing how much and from when. Feeds why-not.ts.
    unplaced: unplaced.map((t) => ({
      id: t.id,
      title: t.title,
      remainingMin: t.remaining === -1 ? (t.stuckAt ?? 0) : t.remaining,
      floorAbs: t.floor ?? 0,
      deadlineAbs: t.deadline ?? null,
      startsAfterHorizon: startsAfterHorizon(t),
    })),
    risk: remaining
      .filter(
        (t) =>
          t.finishedAbs != null &&
          t.deadline != null &&
          t.deadline !== NO_DEADLINE &&
          t.finishedAbs > t.deadline,
      )
      .map((t) => t.title),
    // Finishes on time but on the same calendar day as the deadline — no
    // buffer day left, worth flagging even though it's not technically late.
    nearDeadline: remaining
      .filter(
        (t) =>
          t.finishedAbs != null &&
          t.deadline != null &&
          t.deadline !== NO_DEADLINE &&
          t.finishedAbs <= t.deadline &&
          Math.floor(t.finishedAbs / 1440) === Math.floor(t.deadline / 1440),
      )
      .map((t) => t.title),
  };
}

export function computeSchedule(
  inputs: ScheduleInputs,
  now: Date = new Date(),
): ComputeScheduleResult {
  const blocks: ScheduleBlock[] = [];
  const baseBusy = new Set<AbsMinute>();
  const NOW = nowAbsMinute(inputs.timezone, now);

  inputs.events.forEach((e) => {
    // An all-day entry covers 00:00-24:00, so marking it busy would erase the
    // day. It's a banner: what it actually blocks is decided per calendar and
    // applied through allDayBlocks (an "away" day turns its hours off in
    // resolveDayWindow; "no_meetings" only affects the booking page).
    if (!e.allDay) markBusy(e.gday * 1440 + e.start, e.end - e.start, baseBusy);
    blocks.push({
      type: "synced",
      eventId: e.id,
      eventSource: e.source,
      tagLabel: e.allDay ? "All day" : "Meeting",
      allDay: e.allDay,
      title: e.title,
      gday: e.gday,
      start: e.start,
      end: e.end,
      priority: null,
      key: `event-${e.id}`,
      description: e.description,
      location: e.location,
      meetingUrl: e.meetingUrl,
      connectionColor: e.connectionColor,
      connectionLabel: e.connectionLabel,
    });
  });

  // Task pins are marked busy before anchors are placed (not after) so an
  // anchor's free-slot search actually sees a pinned task chunk as occupied
  // instead of placing straight on top of it — pins are a fixed project
  // exactly like an event from this point of view.
  const pinReduction: Record<string, number> = {};
  const taskPinChunks: ScheduleBlock[] = [];
  inputs.tasks.forEach((t) => {
    if (!t.pin) return;
    const abs = t.pin.gday * 1440 + t.pin.start;
    markBusy(abs, t.pin.length, baseBusy);
    pinReduction[t.id] = t.pin.length;
    taskPinChunks.push({
      type: "task",
      taskId: t.id,
      projectId: t.projectId || null,
      categoryId: t.categoryId ?? null,
      tagLabel: labelTag(inputs, t.categoryId),
      title: t.title,
      gday: t.pin.gday,
      start: t.pin.start,
      end: t.pin.start + t.pin.length,
      priority: t.priority,
    });
  });

  // Research pins work the same way, but the target isn't a task row — it's
  // the synthesized weekly chunk for that project (`research-<id>-w<N>`), so
  // the reduction has to be keyed to the def id taskDefs() will generate for
  // the pin's own week. Everything downstream (done-checkbox, progress
  // logging via subjectFromTaskId, weekly credit) then treats it exactly
  // like an auto-placed research block.
  const projectById = new Map(inputs.projects.map((p) => [p.id, p]));
  inputs.researchPins.forEach((rp) => {
    const project = projectById.get(rp.projectId);
    if (!project) return;
    const abs = rp.gday * 1440 + rp.start;
    markBusy(abs, rp.length, baseBusy);
    const defId = `research-${rp.projectId}-w${Math.floor(rp.gday / 7)}`;
    pinReduction[defId] = (pinReduction[defId] ?? 0) + rp.length;
    taskPinChunks.push({
      type: "task",
      taskId: defId,
      projectId: rp.projectId,
      categoryId: project.categoryId ?? null,
      tagLabel: labelTag(inputs, project.categoryId),
      title: project.title,
      gday: rp.gday,
      start: rp.start,
      end: rp.start + rp.length,
      priority: "high",
    });
  });

  // Snapshot before anchors are placed — see weekCapacityMin on why routines
  // are not netted out of the pool a share target claims from.
  const busyBeforeAnchors = new Set(baseBusy);

  anchorDefs(inputs).forEach((a) => {
    const dayWindow = resolveDayWindow(a.gday, inputs.weeklyHours, inputs.dayOverrides, inputs.allDayBlocks);
    if (dayWindow == null) return; // day off entirely
    // An anchored routine ignores its stored window (it has none) and takes its
    // half of the day as the day actually runs — including a day an override has
    // shortened, which is the case a clock time gets wrong.
    const anchored = a.anchor ? anchoredWindow(a.anchor, dayWindow, a.length) : null;
    let ws = anchored ? anchored.start : Math.max(a.winStart, dayWindow.start);
    let we = anchored ? anchored.end : Math.min(a.winEnd, dayWindow.end);

    // A routine whose whole window sits before the day opens slides to the
    // day's first moment instead of vanishing. A 9:00-9:15 email block used to
    // disappear entirely on a day starting at 11:00 — and "start work after
    // emails" is a rule about order, not about nine o'clock. It keeps its
    // original duration of window, so a fixed slot stays a fixed slot, just
    // later. Deliberately NOT applied to a window that falls after the day
    // closes: an evening routine on a day that already ended should be skipped,
    // not dragged to the morning.
    // (Anchored routines are exempt: their window is already the day's own, so
    // there is nothing stranded before it. This fix-up is the workaround that
    // rule needed before anchoring existed — see migration 0039.)
    if (!anchored && we - ws < a.length && a.winEnd <= dayWindow.start) {
      ws = dayWindow.start;
      we = Math.min(dayWindow.end, dayWindow.start + Math.max(a.length, a.winEnd - a.winStart));
    }

    if (we - ws < a.length) return; // day shortened past this window
    let placed: number | null = null;
    // Every other routine takes the EARLIEST free slot in its window; a day_end
    // one takes the latest, starting flush with the day's close and working
    // back. Searching forward would leave "the last thing in the day" sitting at
    // the middle of it the moment the final slot is taken.
    const candidates: MinuteOfDay[] = [];
    if (a.anchor === "day_end") {
      for (let m = we - a.length; m >= ws; m -= 15) candidates.push(m);
    } else {
      for (let m = ws; m + a.length <= we; m += 15) candidates.push(m);
    }
    for (const m of candidates) {
      const abs = a.gday * 1440 + m;
      let free = true;
      for (let k = 0; k < a.length; k += 1) {
        if (baseBusy.has(abs + k)) {
          free = false;
          break;
        }
      }
      if (free) {
        placed = m;
        break;
      }
    }
    // No free slot in the window this day (e.g. events/a pin fill it) — skip
    // placing this instance entirely rather than forcing it on top of
    // whatever's already there. Matches the "just don't schedule it for that
    // day" rule these blocks are meant to honor.
    if (placed == null) return;
    markBusy(a.gday * 1440 + placed, a.length, baseBusy);

    // Anchors don't go through the greedy scheduler's kept/missed
    // reconciliation (they're placed deterministically above, not fit in by
    // runScheduler), so past/current instances get their done/missed status
    // resolved directly here against the same completed-map progress_log
    // feeds tasks from — see from-db.ts's "anchor-" subjectId prefix.
    const abs = a.gday * 1440 + placed;
    const absEnd = abs + a.length;
    const rule = inputs.recurringRules.find((r) => r.id === a.ruleId);
    const taskId = `anchor-${a.ruleId}`;
    const key = `${taskId}@${a.gday}-${placed}`;
    let status: ScheduleBlock["status"];
    if (abs < NOW) {
      status = inputs.completed[key] ? "done" : absEnd <= NOW ? "missed" : "active";
    }
    blocks.push({
      type: "anchor",
      taskId,
      key,
      abs,
      status,
      // Still "Routine" in the corner even when it carries a label: "this
      // repeats on its own" is worth seeing at a glance, and which share it
      // counts toward is a separate fact the colour carries.
      tagLabel: ROUTINE_TAG_LABEL,
      categoryId: rule?.categoryId ?? null,
      title: a.title,
      gday: a.gday,
      start: placed,
      end: placed + a.length,
      priority: null,
    });
  });

  const labelScaleByWeek = Array.from({ length: inputs.horizonWeeks }, (_, w) =>
    labelScaleForWeek(inputs, busyBeforeAnchors, w),
  );
  // Two capacities per week, since a label's percentage is a share of whichever
  // its basis names. Both are cheap and reporting needs the one that matches.
  const weekCapacity = Array.from({ length: inputs.horizonWeeks }, (_, w) =>
    weekCapacityMin(inputs, busyBeforeAnchors, w, "week"),
  );
  const weekCapacityAfterMeetings = Array.from({ length: inputs.horizonWeeks }, (_, w) =>
    weekCapacityMin(inputs, busyBeforeAnchors, w, "after_meetings"),
  );

  const defs = taskDefs(inputs, labelScaleByWeek).map((t) =>
    pinReduction[t.id] ? { ...t, duration: Math.max(0, t.duration - pinReduction[t.id]) } : t,
  );
  const plan = runScheduler(inputs, defs, new Set(baseBusy), 0, null);

  const kept: ScheduleBlock[] = [];
  const futurePins: ScheduleBlock[] = [];
  [...taskPinChunks, ...plan.chunks].forEach((c) => {
    const abs = c.gday * 1440 + c.start;
    const absEnd = c.gday * 1440 + c.end;
    if (abs >= NOW && taskPinChunks.includes(c)) {
      futurePins.push(c);
      return;
    }
    if (abs < NOW) {
      const key = `${c.taskId}@${c.gday}-${c.start}`;
      const done = !!inputs.completed[key];
      const part = inputs.partial[key];
      // A block whose time has passed with nothing logged is "grace" while it's
      // recent enough that the user may just not have ticked it, then "missed".
      // Both are excluded from credit below, so the hours re-place immediately
      // either way — the distinction is whether the original block is still
      // shown in place and completable.
      const graceMinutes = (inputs.graceHours ?? 4) * 60;
      const status =
        done || inputs.pinned[key]
          ? "done"
          : part != null
            ? "partial"
            : absEnd > NOW
              ? "active"
              : NOW - absEnd <= graceMinutes
                ? "grace"
                : "missed";
      kept.push({
        ...c,
        key,
        abs,
        status,
        partMin: part != null ? Math.min(part, c.end - c.start) : null,
      });
    }
  });

  const credit: Record<string, number> = {};
  kept.forEach((c) => {
    if (c.status === "partial") {
      credit[c.taskId!] = (credit[c.taskId!] || 0) + (c.partMin ?? 0);
    } else if (c.status !== "missed" && c.status !== "grace") {
      // Grace counts as un-done for scheduling: the time re-places right away
      // and ticking the box later credits it, removing the replacement.
      credit[c.taskId!] = (credit[c.taskId!] || 0) + (c.end - c.start);
    }
  });

  const pinnedList: ScheduleBlock[] = Object.entries(inputs.pinned)
    .filter(([k]) => !kept.some((c) => c.key === k))
    .map(([k, v]) => ({
      type: "task",
      taskId: v.taskId,
      projectId: v.projectId ?? null,
      categoryId:
        (v.projectId ? inputs.projects.find((p) => p.id === v.projectId)?.categoryId : null) ??
        inputs.tasks.find((t) => t.id === v.taskId)?.categoryId ??
        null,
      tagLabel: v.tagLabel,
      title: v.title,
      gday: v.gday,
      start: v.start,
      end: v.end,
      priority: v.priority,
      key: k,
      abs: v.gday * 1440 + v.start,
      status: "done",
      pinned: true,
    }));
  pinnedList.forEach((c) => {
    credit[c.taskId!] = (credit[c.taskId!] || 0) + (c.end - c.start);
  });

  const preDone: string[] = [];
  const defs2: TaskDef[] = defs.map((t) => {
    const rem = t.duration - (credit[t.id] || 0);
    if (rem <= 0) preDone.push(t.id);
    return { ...t, duration: Math.max(rem, 0) };
  });

  // Answering "I did it, just now" on an un-ticked past slot pins the work at
  // the moment of ticking. That pin carries the credit, so leaving the original
  // slot in place — still asking DID YOU?, and calling itself MISSED once the
  // grace window lapses — would contradict what the user just told us. Drop it
  // and free its time, but only when a pin is what settled the task: a plainly
  // missed slot on a task finished some other way is still real history.
  const pinCredited = new Set(pinnedList.map((c) => c.taskId!));
  const settledByPin = new Set(preDone.filter((id) => pinCredited.has(id)));
  const live = kept.filter(
    (c) => !((c.status === "grace" || c.status === "missed") && settledByPin.has(c.taskId!)),
  );

  const busy2 = new Set(baseBusy);
  live.forEach((c) => markBusy(c.abs!, c.end - c.start, busy2));
  pinnedList.forEach((c) => markBusy(c.abs!, c.end - c.start, busy2));

  const nowCeil = Math.ceil(NOW / 15) * 15;
  const res = runScheduler(inputs, defs2, busy2, nowCeil, preDone);

  live.forEach((c) => blocks.push(c));
  pinnedList.forEach((c) => blocks.push(c));
  futurePins.forEach((c) => blocks.push(c));
  res.chunks.forEach((c) => blocks.push(c));

  const missed = [
    ...new Set(live.filter((c) => c.status === "missed").map((c) => c.title)),
  ];
  live
    .filter((c) => c.status === "partial" && (c.partMin ?? 0) < c.end - c.start)
    .forEach((c) => {
      const shortMin = c.end - c.start - (c.partMin ?? 0);
      missed.push(`${c.title} (${fmtMin(shortMin)} short)`);
    });

  // A pin that fully consumes a task's duration never enters runScheduler's
  // ready queue, so its own deadline-risk check never runs — evaluate it
  // here from the pin's own end time instead.
  const risk = [...res.risk];
  const nearDeadline = [...res.nearDeadline];
  inputs.tasks.forEach((t) => {
    if (!t.pin || t.deadline === 99999) return;
    if ((defs.find((d) => d.id === t.id)?.duration ?? 0) > 0) return; // more work remains beyond the pin
    const finishedAbs = t.pin.gday * 1440 + t.pin.start + t.pin.length;
    if (finishedAbs > t.deadline) risk.push(t.title);
    else if (Math.floor(finishedAbs / 1440) === Math.floor(t.deadline / 1440)) nearDeadline.push(t.title);
  });

  // The target against reality ("Research 4.7h of a 4.7h target"), so the chat
  // and the board can state it instead of the user working out from five
  // per-project numbers whether a rule they gave in percentages is being met.
  //
  // Reported per week, not just this one. The scaling that produces it already
  // runs for every week in the horizon (labelScaleForWeek), so a week broken up
  // by travel has a smaller target and always did — only the reporting stopped
  // at week 0. Next week's figure is what makes it a plan rather than a
  // scorecard. Nothing here affects placement; it reads what was placed.
  // `?? {}` for the same reason labelScaleForWeek has it: an account with no
  // share target set has no such field, and reading it unguarded threw for every
  // caller that builds ScheduleInputs by hand. That crashed seven sanity checks
  // silently from the commit that introduced share targets until this one.
  const targetsForWeek = (w: number) =>
    Object.entries(inputs.labelTargetPct ?? {}).map(([labelId, pct]) => {
      const plannedMin = blocks
        .filter((b) => b.categoryId === labelId && Math.floor(b.gday / 7) === w && b.status !== "missed")
        .reduce((sum, b) => sum + (b.end - b.start), 0);

      // What was actually asked for, alongside what the percentage comes to.
      // These differ by the rounding each commitment's share goes through, and
      // without both figures a week with hours to spare still reports a
      // shortfall with nothing to explain it.
      const scale = labelScaleByWeek[w]?.[labelId];
      const mine = inputs.projects.filter((p) => p.categoryId === labelId && p.weeklyMinMin);
      let askedMin = 0;
      const belowFloor: string[] = [];
      for (const p of mine) {
        const asked =
          scale == null ? p.weeklyMinMin! : scaledWeeklyMin(p.weeklyMinMin!, scale, p.chunk || 120, p.minChunk ?? 30);
        askedMin += asked;
        if (asked === 0) belowFloor.push(p.title);
      }

      // Routines wearing this label are part of the share, so they belong in
      // both figures — otherwise a week met entirely by a literature scan reads
      // as a total failure.
      const routineMin = labelledRoutineMinForWeek(inputs, w)[labelId] ?? 0;
      const basis = inputs.labelTargetBasis?.[labelId] ?? "week";
      const capacityMin = (basis === "week" ? weekCapacity[w] : weekCapacityAfterMeetings[w]) ?? 0;

      return {
        label: inputs.labelNames[labelId] ?? labelId,
        pct,
        basis,
        capacityMin,
        targetMin: Math.round((capacityMin * pct) / 100),
        plannedMin: plannedMin + routineMin,
        askedMin: askedMin + routineMin,
        routineMin,
        belowFloor,
      };
    });
  const labelTargetsByWeek = Array.from({ length: inputs.horizonWeeks }, (_, w) => targetsForWeek(w));
  const labelTargets = labelTargetsByWeek[0] ?? [];

  // This week's scaled goal per commitment, for anything under a share target.
  // The chips used to print the DECLARED weekly minimum, which stopped being a
  // weekly total the moment a label target turned those numbers into a ratio —
  // so a commitment showing "3h wk" could correctly be given 3.08h in a normal
  // week and nothing at all in a conference week, and the chip called both wrong.
  const weeklyTargetMinByProject: Record<string, number> = {};
  const scale0 = labelScaleByWeek[0] ?? {};
  inputs.projects.forEach((p) => {
    if (!p.weeklyMinMin || !p.categoryId) return;
    const scale = scale0[p.categoryId];
    if (scale == null) return; // no share target — the declared figure still stands
    weeklyTargetMinByProject[p.id] = scaledWeeklyMin(p.weeklyMinMin, scale, p.chunk || 120, p.minChunk ?? 30);
  });

  // Past days, exactly as they happened. Appended rather than computed: nothing
  // in the scheduler ever looks at a gday below 0, which is what keeps a past
  // week a record instead of a re-derivation.
  blocks.push(...(inputs.historyBlocks ?? []));

  return {
    blocks,
    overflow: res.overflow,
    beyondHorizon: res.beyondHorizon,
    unplaced: res.unplaced,
    risk,
    nearDeadline,
    missed,
    labelTargets,
    labelTargetsByWeek,
    weeklyTargetMinByProject,
  };
}
