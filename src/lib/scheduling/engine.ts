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

const FALLBACK_WINDOW = { start: 9 * 60, end: 17 * 60 };

interface AnchorDef {
  gday: GDay;
  winStart: MinuteOfDay;
  winEnd: MinuteOfDay;
  length: number;
  title: string;
  tag: string;
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
          tag: r.tag || "anchor",
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
    inputs.projects
      .filter((p) => p.weeklyMinMin)
      .forEach((p) => {
        research.push({
          id: `research-${p.id}-w${w}`,
          title: p.title,
          priority: "high",
          duration: p.weeklyMinMin!,
          chunk: p.chunk || 120,
          minChunk: p.minChunk,
          tag: "research",
          dependsOn: null,
          floor: w * 7 * 1440,
          ceilAbs: (w * 7 + 5) * 1440,
          deadline: 99999,
          projectId: p.id,
          categoryId: p.categoryId ?? null,
          ord: (p.researchOrd || 5) + w * 10,
          preferMorning: !!p.preferMorning,
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
    const win = resolveDayWindow(g, inputs.weeklyHours, inputs.dayOverrides);
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

    const tryLen = (len: number): Slot | null => {
      const dayOk = t.maxPerDayMin
        ? (d: GDay) => ((perDay[t.id] || {})[d] || 0) + len <= t.maxPerDayMin!
        : null;
      if (t.timeOfDay === "afternoon") return findSlot(inputs, floor, len, false, busy, dayOk, t.ceilAbs, true);
      if (t.timeOfDay === "morning" || t.tag === "deep-focus") return findSlot(inputs, floor, len, true, busy, dayOk, t.ceilAbs);
      if (t.tag === "research" || t.preferMorning)
        return (
          findSlot(inputs, floor, len, true, busy, dayOk, t.ceilAbs) ||
          findSlot(inputs, floor, len, false, busy, dayOk, t.ceilAbs)
        );
      return findSlot(inputs, floor, len, false, busy, dayOk, t.ceilAbs);
    };

    const shrinkFloor = t.minChunk ?? 30;
    let slot = tryLen(chunkLen);
    while (!slot && chunkLen > shrinkFloor) {
      chunkLen = Math.max(shrinkFloor, chunkLen - 30);
      slot = tryLen(chunkLen);
    }
    if (!slot) {
      t.remaining = -1;
      continue;
    }
    markBusy(slot.abs, chunkLen, busy);
    perDay[t.id] = perDay[t.id] || {};
    perDay[t.id][slot.gday] = (perDay[t.id][slot.gday] || 0) + chunkLen;
    chunks.push({
      type: "task",
      taskId: t.id,
      projectId: t.projectId || null,
      categoryId: t.categoryId ?? null,
      tagLabel:
        t.tag === "research"
          ? inputs.tagLabels.research
          : t.tag === "deep-focus"
            ? inputs.tagLabels.deepFocus
            : inputs.tagLabels.task,
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
          t.deadline !== 99999 &&
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
          t.deadline !== 99999 &&
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
    markBusy(e.gday * 1440 + e.start, e.end - e.start, baseBusy);
    blocks.push({
      type: "synced",
      tagLabel: "Meeting",
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
  // instead of placing straight on top of it — pins are a fixed commitment
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
      tagLabel: t.tag === "research" ? inputs.tagLabels.research : t.tag === "deep-focus" ? inputs.tagLabels.deepFocus : inputs.tagLabels.task,
      title: t.title,
      gday: t.pin.gday,
      start: t.pin.start,
      end: t.pin.start + t.pin.length,
      priority: t.priority,
    });
  });

  anchorDefs(inputs).forEach((a) => {
    const dayWindow = resolveDayWindow(a.gday, inputs.weeklyHours, inputs.dayOverrides);
    if (dayWindow == null) return; // day off entirely
    const ws = Math.max(a.winStart, dayWindow.start);
    const we = Math.min(a.winEnd, dayWindow.end);
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
      tagLabel: inputs.tagLabels.block,
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
      const status =
        done || inputs.pinned[key]
          ? "done"
          : part != null
            ? "partial"
            : absEnd <= NOW
              ? "missed"
              : "active";
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
    } else if (c.status !== "missed") {
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

  const busy2 = new Set(baseBusy);
  kept.forEach((c) => markBusy(c.abs!, c.end - c.start, busy2));
  pinnedList.forEach((c) => markBusy(c.abs!, c.end - c.start, busy2));

  const nowCeil = Math.ceil(NOW / 15) * 15;
  const res = runScheduler(inputs, defs2, busy2, nowCeil, preDone);

  kept.forEach((c) => blocks.push(c));
  pinnedList.forEach((c) => blocks.push(c));
  futurePins.forEach((c) => blocks.push(c));
  res.chunks.forEach((c) => blocks.push(c));

  const missed = [
    ...new Set(kept.filter((c) => c.status === "missed").map((c) => c.title)),
  ];
  kept
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
