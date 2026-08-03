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
  ScheduleBlock,
  ScheduleInputs,
  Task,
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
        });
      });
    });
  }
  return list;
}

/** A task definition normalized for the scheduler's internal loop — includes
 * the auto-generated weekly research chunks alongside real tasks. */
interface TaskDef extends Task {
  ord: number;
}

function taskDefs(inputs: ScheduleInputs): TaskDef[] {
  const research: TaskDef[] = [];
  for (let w = 0; w < inputs.horizonWeeks; w++) {
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
        research.push({
          id: `research-${p.id}-w${w}`,
          title: p.title,
          priority: "high",
          duration: p.weeklyMinMin!,
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

function findSlot(
  inputs: ScheduleInputs,
  floorAbs: AbsMinute,
  lengthMin: number,
  constrainNoon: boolean,
  busy: Set<AbsMinute>,
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
  const remaining = taskList.map((t) => ({
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
    let chunkLen = Math.min(t.chunk || t.remaining, t.remaining);

    const tryLen = (len: number, ceil: number | undefined): Slot | null => {
      const dayOk = t.maxPerDayMin
        ? (d: GDay) => ((perDay[t.id] || {})[d] || 0) + len <= t.maxPerDayMin!
        : null;
      if (t.timeOfDay === "afternoon") return findSlot(inputs, floor, len, false, busy, dayOk, ceil, true);
      if (t.timeOfDay === "morning") return findSlot(inputs, floor, len, true, busy, dayOk, ceil);
      // A soft nudge takes the wrong half of the day over leaving the work
      // unscheduled — that's the whole difference from the constraints above.
      if (t.preferMorning)
        return (
          findSlot(inputs, floor, len, true, busy, dayOk, ceil) ||
          findSlot(inputs, floor, len, false, busy, dayOk, ceil)
        );
      if (t.preferAfternoon)
        return (
          findSlot(inputs, floor, len, false, busy, dayOk, ceil, true) ||
          findSlot(inputs, floor, len, false, busy, dayOk, ceil)
        );
      return findSlot(inputs, floor, len, false, busy, dayOk, ceil);
    };

    const shrinkFloor = t.minChunk ?? 30;
    /** Places the chunk under a ceiling, shrinking toward minChunk to fit. */
    const placeUnder = (ceil: number | undefined): { slot: Slot; len: number } | null => {
      let len = Math.min(t.chunk || t.remaining, t.remaining);
      let found = tryLen(len, ceil);
      while (!found && len > shrinkFloor) {
        len = Math.max(shrinkFloor, len - 30);
        found = tryLen(len, ceil);
      }
      return found ? { slot: found, len } : null;
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

    let placed = withinDeadline != null ? placeUnder(withinDeadline) : null;
    // Nothing fits before the deadline even in the smallest pieces allowed —
    // schedule it late rather than not at all, and let the risk report say so.
    if (!placed) placed = placeUnder(t.ceilAbs);
    if (!placed) {
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

  return {
    chunks,
    overflow: [
      ...new Set(
        remaining.filter((t) => t.remaining > 0 || t.remaining === -1).map((t) => t.title),
      ),
    ],
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

  anchorDefs(inputs).forEach((a) => {
    const dayWindow = resolveDayWindow(a.gday, inputs.weeklyHours, inputs.dayOverrides, inputs.allDayBlocks);
    if (dayWindow == null) return; // day off entirely
    let ws = Math.max(a.winStart, dayWindow.start);
    let we = Math.min(a.winEnd, dayWindow.end);

    // A routine whose whole window sits before the day opens slides to the
    // day's first moment instead of vanishing. A 9:00-9:15 email block used to
    // disappear entirely on a day starting at 11:00 — and "start work after
    // emails" is a rule about order, not about nine o'clock. It keeps its
    // original duration of window, so a fixed slot stays a fixed slot, just
    // later. Deliberately NOT applied to a window that falls after the day
    // closes: an evening routine on a day that already ended should be skipped,
    // not dragged to the morning.
    if (we - ws < a.length && a.winEnd <= dayWindow.start) {
      ws = dayWindow.start;
      we = Math.min(dayWindow.end, dayWindow.start + Math.max(a.length, a.winEnd - a.winStart));
    }

    if (we - ws < a.length) return; // day shortened past this window
    let placed: number | null = null;
    for (let m = ws; m + a.length <= we; m += 15) {
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
      tagLabel: ROUTINE_TAG_LABEL,
      title: a.title,
      gday: a.gday,
      start: placed,
      end: placed + a.length,
      priority: null,
    });
  });

  const defs = taskDefs(inputs).map((t) =>
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

  return { blocks, overflow: res.overflow, risk, nearDeadline, missed };
}
