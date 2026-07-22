"use client";

import { useEffect, useRef, useState } from "react";
import { Block } from "./Block";
import { TaskDetailPopover } from "./TaskDetailPopover";
import { EventDetailPopover } from "./EventDetailPopover";
import { defaultDayWindow, resolveDayWindow } from "@/lib/scheduling/day-window";
import { computeBlockLanes, DAY_END_MIN, DAY_START_MIN, DEFAULT_SCROLL_MIN } from "@/lib/scheduling/render";
import { dateForGday, minToLabel, nowAbsMinute, WEEKDAY_LABELS } from "@/lib/scheduling/time";
import type { Category, ComputeScheduleResult, DayOverrides, ScheduleBlock, WeeklyHours } from "@/lib/scheduling/types";

const VIEW_HEIGHT = DAY_END_MIN - DAY_START_MIN; // full 24h, 1px/min — scrolled to the working window by default

interface WeekGridProps {
  weekOffset: number;
  timezone: string;
  weeklyHours: WeeklyHours;
  dayOverrides: DayOverrides;
  schedule: ComputeScheduleResult;
  categories: Category[];
  onSetProgress: (block: ScheduleBlock, mode: "done" | "partial" | "none", minutes?: number) => void;
  onPinDone: (block: ScheduleBlock) => void;
  onUnpinDone: (block: ScheduleBlock) => void;
}

const hourLabels = Array.from({ length: 24 }, (_, h) => ({ top: h * 60, label: minToLabel(h * 60) }));

/** Compares the effective (possibly overridden) window for a day against
 * that weekday's own default, so the label reflects "earlier/later than
 * your normal Tuesday", not just "earlier/later than 7am". */
function startLabel(defaultWindow: { start: number; end: number } | null, effStart: number): string {
  if (!defaultWindow) return "Starts early";
  if (effStart < defaultWindow.start) return "Starts early";
  if (effStart > defaultWindow.start) return "Starts late";
  return "Before hours";
}
function endLabel(defaultWindow: { start: number; end: number } | null, effEnd: number): string {
  if (!defaultWindow) return "Ends early";
  if (effEnd < defaultWindow.end) return "Day ended early";
  if (effEnd > defaultWindow.end) return "Day extended";
  return "After hours";
}

/** Back-to-back chunks of the same task (e.g. a 3-hour research block split
 * into three 1-hour pieces) read as one continuous block visually — the
 * underlying chunks still exist individually (pacing, progress-logging) but
 * there's no reason to show seams between them when nothing else is in the
 * way. Only merges chunks that share a status, so a partially-completed run
 * (some chunks done, one in progress, one still future) naturally stays
 * split at the real boundary instead of misrepresenting partial progress. */
function mergeAdjacentTaskBlocks(blocks: ScheduleBlock[]): ScheduleBlock[] {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  const out: ScheduleBlock[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    const canMerge =
      last &&
      last.type === "task" &&
      b.type === "task" &&
      last.taskId === b.taskId &&
      last.end === b.start &&
      (last.status ?? null) === (b.status ?? null) &&
      !!last.pinned === !!b.pinned;
    if (canMerge) {
      out[out.length - 1] = { ...last, end: b.end, mergedChunks: [...(last.mergedChunks ?? [last]), b] };
    } else {
      out.push(b);
    }
  }
  return out;
}

/** Applies a done/partial/none action across a merged block's original
 * chunks — each one logs against its own progress_log key (keyed by exact
 * start minute), so this can't be done as a single write against the
 * merged span. Partial credit fills sequentially from the start. */
function applyProgress(
  onSetProgress: (block: ScheduleBlock, mode: "done" | "partial" | "none", minutes?: number) => void,
  block: ScheduleBlock,
  mode: "done" | "partial" | "none",
  minutes?: number,
) {
  const chunks = block.mergedChunks ?? [block];
  if (mode !== "partial") {
    chunks.forEach((c) => onSetProgress(c, mode));
    return;
  }
  let remaining = minutes ?? 0;
  chunks.forEach((c) => {
    const len = c.end - c.start;
    if (remaining >= len) {
      onSetProgress(c, "done");
      remaining -= len;
    } else if (remaining > 0) {
      onSetProgress(c, "partial", remaining);
      remaining = 0;
    } else {
      onSetProgress(c, "none");
    }
  });
}

export function WeekGrid({
  weekOffset,
  timezone,
  weeklyHours,
  dayOverrides,
  schedule,
  categories,
  onSetProgress,
  onPinDone,
  onUnpinDone,
}: WeekGridProps) {
  const now = new Date();
  const NOW = nowAbsMinute(timezone, now);
  const todayGday = Math.floor(NOW / 1440);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The grid spans the full 24h day so you can scroll to any hour, but most
  // days' actual activity is within the normal working window — land there
  // by default (today's current time if it's within the visible range,
  // otherwise the default morning start) rather than dropping at midnight.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const todayInView = todayGday >= weekOffset * 7 && todayGday < weekOffset * 7 + 7;
    const nowMinuteOfDay = NOW - todayGday * 1440;
    const target = todayInView ? Math.max(0, nowMinuteOfDay - 90) : DEFAULT_SCROLL_MIN;
    el.scrollTop = target;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekOffset]);

  return (
    <div ref={scrollRef} className="flex-1 flex flex-col min-w-0 overflow-y-auto">
      {/* Sticky day header row */}
      <div className="flex-none grid sticky top-0 z-[5] bg-bg border-b border-border" style={{ gridTemplateColumns: "56px repeat(7,1fr)" }}>
        <div />
        {Array.from({ length: 7 }, (_, i) => {
          const gday = weekOffset * 7 + i;
          const isToday = gday === todayGday;
          const date = dateForGday(timezone, gday, now);
          return (
            <div key={i} className="py-2.5 pl-2.5 border-l border-border-grid">
              <div className="text-[10px] tracking-wider text-muted uppercase">{WEEKDAY_LABELS[i]}</div>
              <div className="mt-0.5 text-[15px] font-medium" style={{ color: isToday ? "var(--color-accent)" : "var(--color-text)" }}>
                {date.day}
              </div>
            </div>
          );
        })}
      </div>

      {/* Grid body */}
      <div className="flex-none grid relative" style={{ gridTemplateColumns: "56px repeat(7,1fr)" }}>
        <div className="relative" style={{ height: VIEW_HEIGHT }}>
          {hourLabels.map((hl) => (
            <div
              key={hl.top}
              className="absolute right-2 text-[10px] text-muted-2"
              style={{ top: hl.top, transform: "translateY(-6px)", fontVariantNumeric: "tabular-nums" }}
            >
              {hl.label}
            </div>
          ))}
        </div>

        {Array.from({ length: 7 }, (_, i) => {
          const gday = weekOffset * 7 + i;
          const isToday = gday === todayGday;
          const defaultWindow = defaultDayWindow(gday, weeklyHours);
          const effWindow = resolveDayWindow(gday, weeklyHours, dayOverrides);
          const allDayBlocks = mergeAdjacentTaskBlocks(schedule.blocks.filter((b) => b.gday === gday));
          const dayBlocks = allDayBlocks.filter((b) => b.end > DAY_START_MIN && b.start < DAY_END_MIN);
          const blockLanes = computeBlockLanes(dayBlocks);
          const showNow = isToday && NOW - todayGday * 1440 >= DAY_START_MIN && NOW - todayGday * 1440 <= DAY_END_MIN;
          const nowTop = NOW - todayGday * 1440 - DAY_START_MIN;

          const openBlock = dayBlocks.find((b) => (b.key ?? `${b.type}@${b.gday}-${b.start}`) === openKey);

          const effStart = effWindow ? Math.max(effWindow.start, DAY_START_MIN) : DAY_START_MIN;
          const effEnd = effWindow ? Math.min(effWindow.end, DAY_END_MIN) : DAY_START_MIN;

          return (
            <div
              key={i}
              onClick={() => setOpenKey(null)}
              className="relative border-l border-border-grid"
              style={{
                height: VIEW_HEIGHT,
                backgroundImage:
                  "repeating-linear-gradient(to bottom, transparent 0, transparent 59px, rgba(233,233,237,0.06) 60px)",
                backgroundColor: isToday ? "rgba(145,132,217,0.05)" : "transparent",
              }}
            >
              {effWindow == null ? (
                <div
                  className="absolute left-0 right-0 flex items-center justify-center"
                  style={{ top: 0, height: VIEW_HEIGHT, background: "rgba(22,24,38,0.7)" }}
                >
                  <span className="text-[9.5px] tracking-wide uppercase text-muted-2">Day off</span>
                </div>
              ) : (
                <>
                  {effStart > DAY_START_MIN && (
                    <div
                      className="absolute left-0 right-0 flex items-center justify-center"
                      style={{ top: 0, height: effStart - DAY_START_MIN, background: "rgba(22,24,38,0.7)" }}
                    >
                      <span className="text-[9.5px] tracking-wide uppercase text-muted-2">
                        {startLabel(defaultWindow, effWindow.start)}
                      </span>
                    </div>
                  )}
                  {effEnd < DAY_END_MIN && (
                    <div
                      className="absolute left-0 right-0 flex items-center justify-center"
                      style={{ top: effEnd - DAY_START_MIN, height: DAY_END_MIN - effEnd, background: "rgba(22,24,38,0.7)" }}
                    >
                      <span className="text-[9.5px] tracking-wide uppercase text-muted-2">
                        {endLabel(defaultWindow, effWindow.end)}
                      </span>
                    </div>
                  )}
                </>
              )}

              {showNow && (
                <div className="absolute left-0 right-0 z-[4]" style={{ top: nowTop, height: 2, background: "#9184d9" }}>
                  <div className="absolute rounded-full" style={{ left: -3, top: -3, width: 8, height: 8, background: "#9184d9" }} />
                </div>
              )}

              {dayBlocks.map((b) => {
                const key = b.key ?? `${b.type}@${b.gday}-${b.start}`;
                return (
                  <Block
                    key={key}
                    block={b}
                    atRiskTitles={schedule.risk}
                    nearDeadlineTitles={schedule.nearDeadline}
                    categories={categories}
                    layout={blockLanes.get(b)}
                    onSetProgress={(mode, minutes) => onSetProgress(b, mode, minutes)}
                    onPinDone={() => onPinDone(b)}
                    onUnpinDone={() => onUnpinDone(b)}
                    onBodyClick={() => setOpenKey((k) => (k === key ? null : key))}
                  />
                );
              })}

              {openBlock &&
                (() => {
                  const clampStart = Math.max(openBlock.start, DAY_START_MIN);
                  const popoverTop = Math.min(clampStart - DAY_START_MIN + 22, VIEW_HEIGHT - 180);
                  return openBlock.type === "synced" ? (
                    <EventDetailPopover block={openBlock} top={popoverTop} onClose={() => setOpenKey(null)} />
                  ) : (
                    <TaskDetailPopover
                      block={openBlock}
                      top={popoverTop}
                      onClose={() => setOpenKey(null)}
                      onSetProgress={(mode, minutes) => applyProgress(onSetProgress, openBlock, mode, minutes)}
                    />
                  );
                })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}
