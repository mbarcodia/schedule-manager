// Giving one day's worth of one label's time to one project.
//
// "I want my research blocks tomorrow to all be ACE2-S2S." Migration 0046 has the
// story; this is the half that runs.
//
// IT IS MEASURED, NOT GUESSED. "Give this day's research to X" needs to know what
// the day would have held otherwise, and that answer comes from a real unfocused
// scheduler run from `now` — the caller hands its chunks in. A focus is then
// applied by rewriting the defs the final run will use.
//
// It must NOT be measured off computeSchedule's pass 1. Pass 1 replans the whole
// week from Monday with floorMin 0, so by Thursday it has already spent Mon-Wed and
// its Thursday is nearly empty; measuring off it reported "nothing to reassign" for
// a day that visibly had two projects on it. The current week is the whole point of
// this feature, so that was not a corner case. The engine therefore runs one extra
// unfocused pass, and only when a focus exists.
//
// IT IS ORDERING, NOT EXCLUSION, and this is the design's load-bearing choice. The
// user's rule for this app is "these shouldn't be hard rules unless specified", so
// the focused project is given the BEST CLAIM among its label's chunks for that
// day rather than the others being forbidden from it. Three things fall out for
// free:
//
//   - the day fills with the focused project, because it picks first and is fenced
//     to that one day, so it takes those slots before anything else can;
//   - a slot it genuinely cannot use — its minimum chunk won't fit, or it has no
//     work left against its estimate — goes to the next project instead of sitting
//     empty, which is what the user asked for;
//   - no new placement machinery. `findSlot`, `dayOk` and `perDay` are untouched.
//
// A hard exclusion would have needed a new TaskDef field and an edit to the slot
// search, and would have left the day part-empty in exactly the case above.
//
// NO DISPLACED DEF EVER HAS ITS DURATION REDUCED. This is the invariant the whole
// module serves and the reason it is written the way it is. `research_pins` reduce
// a def's duration (`pinReduction` in engine.ts), and the consequence is that the
// missing minutes stop being asked for at all: `remaining` reaches 0, the project
// never enters `unplaced`/`overflow`, and the hours are silently un-owed. Here the
// displaced projects keep every minute they were asked for. They re-place
// elsewhere in their own week, or they surface as a shortfall the user is told
// about. There is no third outcome, and no code has to remember to report it.
//
// The one reduction anywhere is the focused project's OWN weekly def, by exactly
// the minutes it already held on that day — because the focus def re-asks for
// those same minutes on that same day. The arithmetic closes: the project is asked
// for its quota plus whatever was transferred to it, and nothing else moves.
//
// A CONSEQUENCE WORTH KNOWING: the label's total ask therefore GROWS by the
// transferred minutes, and a label's planned minutes can now exceed its asked
// minutes for the first time. That is the honest arithmetic of "the others still
// owe their hours" rather than a leak, and the sanity check pins it so nobody
// "fixes" it back into silently un-owing them.
//
// ONE MEASUREMENT SERVES EVERY FOCUS IN A CALL, so a focus cannot claim time that exists only BECAUSE another focus
// displaced something onto its day: focus two on a day that was empty before
// focus one ran reports `nothing_to_reassign` rather than inventing an amount.
// That is deliberate (the alternative is a fixpoint over an unstable measurement),
// and it means focuses are best set on days that already carry that label's work.

import { resolveDayWindow } from "./day-window";
import type {
  DayFocusOutcome,
  DayFocusSkip,
  Project,
  ScheduleBlock,
  ScheduleInputs,
} from "./types";

/** The id a project's weekly-hours chunk carries for a given week.
 *
 * ⚠️ The focus def REUSES this id rather than taking one of its own, and that is
 * not cosmetic. from-db.ts reconstructs exactly this string from a progress_log or
 * pinned_chunks row (`research-${subject_id}-w${week}`) to decide whether a block
 * has been ticked off. A distinct id would make the done-checkbox on a focused
 * block write a key nothing reads: the tick would appear to do nothing and the
 * block would show "missed" forever.
 *
 * Two defs sharing an id is safe here, and each way it could bite was checked:
 *   - `doneSet` is read only by the dependsOn filter, and research defs never set
 *     dependsOn (tasks.depends_on points at task rows);
 *   - `perDay[t.id]` is read only through maxPerDayMin, which taskDefs never sets
 *     on a research def;
 *   - `credit` and `preDone` are computed BEFORE this runs, so they land on the
 *     main def, and runScheduler zeroes an entry only when its OWN remaining hits
 *     0 — a preDone id does not neuter the focus def;
 *   - `overflow` dedupes by title, and `unplaced` entries are matched by task-row
 *     uuid, which never equals a `research-` id.
 * If any of those four stops being true, this becomes a live bug. */
export function researchDefId(projectId: string, week: number): string {
  return `research-${projectId}-w${week}`;
}

/** The minimal shape this module needs from a def, so it can be used against the
 * engine's TaskDef without importing it (TaskDef is engine-private). */
export interface FocusableDef {
  id: string;
  title: string;
  duration: number;
  chunk: number;
  minChunk?: number;
  ord: number;
  priority: "high" | "medium" | "low";
  deadline: number;
  floor?: number;
  ceilAbs?: number;
  projectId?: string | null;
  categoryId?: string | null;
  timeOfDay?: "morning" | "afternoon" | null;
  preferMorning?: boolean;
  preferAfternoon?: boolean;
  dependsOn?: string | null;
  excludeDays?: number[];
  /** Set only on a def this module creates for one focused day. Distinguishes
   * it from the project's real weekly def even though both carry the SAME id
   * (see researchDefId) — without this marker, a second focus on the same
   * project later in the same week would match the first day's fenced def via
   * `d.id === focusId` and drain its duration by the second day's own-minutes,
   * zeroing out a day that was already correctly sized. */
  isDayFocusChunk?: boolean;
}

const NO_DEADLINE = 99999;

/** How much work the project still has against its own estimate, or null when it
 * has no estimate to measure against.
 *
 * This is what makes "ACE2 only has three hours left, so the last slot goes to
 * NCAR" true rather than aspirational: without it a focus would happily book a
 * project for a whole day of work it does not have. Absent an estimate there is
 * nothing to cap against, and the honest default is to let it take the day. */
function remainingNeedMin(project: Project, loggedMin: number): number | null {
  if (project.effortEstimateMin == null) return null;
  return Math.max(0, project.effortEstimateMin - loggedMin);
}

export interface ApplyDayFocusResult<T extends FocusableDef> {
  defs: T[];
  outcomes: DayFocusOutcome[];
}

/** Rewrites the defs pass 2 will use, so that each focused day's label time goes
 * to its chosen project. Returns the outcomes so the chat and the UI can report
 * with numbers rather than asserting success. */
export function applyDayFocus<T extends FocusableDef>(
  inputs: ScheduleInputs,
  defs: T[],
  /** Chunks from an UNFOCUSED run made from the same `nowCeil` — the measurement
   * of what each day would hold if nothing were focused. See the header for why
   * this must not be computeSchedule's pass 1. */
  unfocusedChunks: ScheduleBlock[],
  /** Absolute minute pass 2 plans from. Minutes before it are history. */
  nowCeil: number,
  /** Lifetime minutes logged per project, for the remaining-need cap. Optional;
   * without it a project is treated as having done none of its estimate, which
   * only ever makes the cap more generous. */
  loggedByProject: Record<string, number> = {},
): ApplyDayFocusResult<T> {
  const focuses = inputs.dayFocus ?? [];
  if (!focuses.length) return { defs, outcomes: [] };

  const projectById = new Map(inputs.projects.map((p) => [p.id, p]));
  const outcomes: DayFocusOutcome[] = [];
  let working = defs.slice();

  for (const focus of focuses) {
    const { gday: D, categoryId: L, projectId: P } = focus;
    const week = Math.floor(D / 7);
    const project = projectById.get(P);

    const skip = (reason: DayFocusSkip) => {
      outcomes.push({
        gday: D,
        projectId: P,
        projectTitle: project?.title ?? "unknown",
        labelId: L,
        labelName: inputs.labelNames[L] ?? "unknown",
        heldMin: 0,
        focusMin: 0,
        placedMin: 0,
        transferredMin: 0,
        displaced: [],
        leftoverTo: [],
        pinnedOthers: [],
        skipped: reason,
      });
    };

    // Weekly hours are only ever generated Mon-Fri (taskDefs fences a week to
    // gday w*7..w*7+4), so a weekend focus has nothing to act on. Said rather
    // than silently ignored — a control that quietly does nothing is the failure
    // this codebase keeps finding.
    if (D % 7 > 4) {
      skip("weekend");
      continue;
    }
    if (!project) {
      skip("unknown_project");
      continue;
    }
    // An on-hold commitment schedules nothing by design; handing it a day would
    // contradict the hold rather than override it.
    if (project.onHold) {
      skip("project_on_hold");
      continue;
    }
    if (project.categoryId !== L) {
      skip("label_mismatch");
      continue;
    }
    if (!resolveDayWindow(D, inputs.weeklyHours, inputs.dayOverrides, inputs.allDayBlocks)) {
      skip("day_off");
      continue;
    }
    const dayStart = D * 1440;
    const dayEnd = dayStart + 1440;
    if (
      (project.activeFromAbs != null && project.activeFromAbs >= dayEnd) ||
      (project.activeUntilAbs != null && project.activeUntilAbs <= dayStart)
    ) {
      skip("outside_active_window");
      continue;
    }

    // ---- measure from pass 1 -------------------------------------------------
    // Built from the project list, never by parsing ids: an id is a formatting
    // detail and a label is the thing being redirected.
    const labelProjects = inputs.projects.filter((p) => p.categoryId === L && p.weeklyMinMin);
    const idToProject = new Map(labelProjects.map((p) => [researchDefId(p.id, week), p]));
    const focusId = researchDefId(P, week);

    let heldMin = 0;
    let pOwnMin = 0;
    const displacedMin: Record<string, number> = {};
    for (const c of unfocusedChunks) {
      if (c.gday !== D || !c.taskId) continue;
      const owner = idToProject.get(c.taskId);
      if (!owner) continue;
      // Only the part still plannable. Two reasons, both load-bearing: a focus on
      // TODAY must not ask for a morning that has already gone, and the minutes
      // before now have already been taken out of these defs by `credit`, so
      // counting them would subtract them twice.
      const abs = c.gday * 1440 + c.start;
      if (abs < nowCeil) continue;
      const len = c.end - c.start;
      heldMin += len;
      if (c.taskId === focusId) pOwnMin += len;
      else displacedMin[owner.id] = (displacedMin[owner.id] ?? 0) + len;
    }

    // Nothing of that label was going to happen on that day anyway. An honest
    // no-op with a reason, so the chat can say "there is no research time on
    // Thursday to reassign — pin it instead" rather than claiming success.
    if (heldMin === 0) {
      skip("nothing_to_reassign");
      continue;
    }

    // ---- size the focus -----------------------------------------------------
    const need = remainingNeedMin(project, loggedByProject[P] ?? 0);
    const focusMin = need == null ? heldMin : Math.min(heldMin, need);
    const transferredMin = Math.max(0, focusMin - pOwnMin);

    // ---- rewrite the defs ---------------------------------------------------
    const labelDefs = working.filter((d) => d.projectId && idToProject.has(d.id) && !d.isDayFocusChunk);
    // Best claim among the chunks it replaces — not best overall. In pass 1 those
    // defs won this day's slots only AFTER losing to everything that outranked
    // them, so inheriting the best of their claims is a clean substitution:
    // whatever beat them still beats the focus, and whatever they beat still
    // loses. Reaching for a better rank than that (or a fake deadline) would let
    // a discretionary focus outrank genuinely dated work.
    const bestOrd = labelDefs.length ? Math.min(...labelDefs.map((d) => d.ord)) : 0;

    working = working.map((d) => {
      // A previous day's own fenced focus chunk shares this SAME id (by design —
      // see researchDefId) but is not the project's real weekly def, and must not
      // be touched by a later day's focus: it already got its own correctly-sized
      // duration when IT was processed, fenced to its own single day.
      if (d.isDayFocusChunk) return d;
      // The focused project's own weekly def gives up exactly what it already held
      // on this day, because the focus def re-asks for those minutes below.
      if (d.id === focusId) return { ...d, duration: Math.max(0, d.duration - pOwnMin) };
      // Everything else keeps its FULL duration — that is the invariant — and only
      // loses its claim on this day.
      if (idToProject.has(d.id)) {
        // Closed out of the focused day only when the focused project can actually
        // absorb what the day held. Two cases, and the difference is the whole of
        // the "preference, not a lock" reading:
        //
        //   focusMin >= heldMin — the project takes everything the day was going to
        //     hold, so there is no leftover and the others must stay off it.
        //     WITHOUT this they flow straight back in: displacing them frees their
        //     hours, that opens room on this very day, and one of them re-places
        //     into it, half-undoing the instruction.
        //   focusMin < heldMin — the project is capped by the work it actually has
        //     left, so there IS genuine leftover, and the others are welcome to it
        //     rather than the day sitting part-empty.
        const closed = focusMin >= heldMin;
        // Slack decides who gives up hours when the week cannot hold them all: the
        // commitment furthest ahead of its own goal loses first, one already behind
        // keeps the better claim. Projects with no measurable pace keep their
        // existing order rather than being guessed at.
        const slack = inputs.paceSlackWeeksByProject?.[d.projectId!];
        return {
          ...d,
          ...(closed ? { excludeDays: [...(d.excludeDays ?? []), D] } : {}),
          ...(slack == null ? {} : { ord: d.ord + Math.max(0, Math.round(slack)) }),
        };
      }
      return d;
    });

    if (focusMin > 0) {
      // Built from the PROJECT, not cloned from its weekly def — that def may have
      // zero duration (or effectively not exist) when the project's weekly minimum
      // is already met, which is precisely the case this feature has to handle.
      const focusDef = {
        id: focusId,
        title: project.title,
        duration: focusMin,
        chunk: project.chunk || 120,
        minChunk: project.minChunk,
        dependsOn: null,
        // Fenced to this one day, clamped to the project's own active window.
        floor: Math.max(dayStart, project.activeFromAbs ?? dayStart),
        ceilAbs: Math.min(dayEnd, project.activeUntilAbs ?? dayEnd),
        // Identical to the defs it stands in for. Deliberately NOT given a real
        // deadline: that would put it in deadlinePressure's urgent band and let a
        // preference outrank work that is actually due.
        priority: "high" as const,
        deadline: NO_DEADLINE,
        projectId: P,
        categoryId: L,
        ord: bestOrd - 1,
        timeOfDay: project.timeOfDay ?? null,
        preferMorning: !!project.preferMorning,
        preferAfternoon: !!project.preferAfternoon,
        isDayFocusChunk: true,
      };
      // Not `splitMode: "one_day"`: it is already confined to one day by the fence
      // above, and one_day is all-or-nothing — if focusMin could not be placed
      // whole, nothing would be, and the day would go empty.
      working = [...working, focusDef as unknown as T];
    }

    outcomes.push({
      gday: D,
      projectId: P,
      projectTitle: project.title,
      labelId: L,
      labelName: inputs.labelNames[L] ?? "unknown",
      heldMin,
      focusMin,
      placedMin: 0, // filled in after pass 2 by recordFocusPlacement
      transferredMin,
      displaced: Object.entries(displacedMin).map(([projectId, min]) => ({
        projectId,
        title: projectById.get(projectId)?.title ?? "unknown",
        min,
      })),
      leftoverTo: [],
      pinnedOthers: [],
      skipped: null,
    });
  }

  return { defs: working, outcomes };
}

/** Fills in what actually happened, once pass 2 has run.
 *
 * Kept separate from applyDayFocus because it can only be known afterwards, and
 * because the difference between what was asked for and what landed is the whole
 * of the honest reporting: `placedMin < focusMin` means the slots would not take
 * it, and `leftoverTo` names who used the day instead. */
export function recordFocusPlacement(
  inputs: ScheduleInputs,
  outcomes: DayFocusOutcome[],
  /** Pass 2's chunks only. History from a partly-elapsed day carries the same ids
   * but was placed unfocused and must not be counted as focus output. */
  pass2Chunks: ScheduleBlock[],
  pinnedTitlesByDay: Record<number, string[]> = {},
): DayFocusOutcome[] {
  if (!outcomes.length) return outcomes;
  const projectById = new Map(inputs.projects.map((p) => [p.id, p]));
  return outcomes.map((o) => {
    if (o.skipped) return o;
    const week = Math.floor(o.gday / 7);
    const focusId = researchDefId(o.projectId, week);
    let placedMin = 0;
    const leftover: Record<string, number> = {};
    for (const c of pass2Chunks) {
      if (c.gday !== o.gday || !c.taskId || c.categoryId !== o.labelId) continue;
      const len = c.end - c.start;
      if (c.taskId === focusId) placedMin += len;
      else if (c.projectId && c.projectId !== o.projectId) {
        leftover[c.projectId] = (leftover[c.projectId] ?? 0) + len;
      }
    }
    return {
      ...o,
      placedMin,
      leftoverTo: Object.entries(leftover).map(([projectId, min]) => ({
        projectId,
        title: projectById.get(projectId)?.title ?? "unknown",
        min,
      })),
      pinnedOthers: pinnedTitlesByDay[o.gday] ?? [],
    };
  });
}
