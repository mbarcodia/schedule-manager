"use client";

import { useState } from "react";
import { Block } from "./Block";
import { TaskDetailPopover } from "./TaskDetailPopover";
import { EventDetailPopover } from "./EventDetailPopover";
import { defaultDayWindow, resolveDayWindow } from "@/lib/scheduling/day-window";
import { DAY_END_MIN, DAY_START_MIN } from "@/lib/scheduling/render";
import { dateForGday, minToLabel, nowAbsMinute, WEEKDAY_LABELS } from "@/lib/scheduling/time";
import type { Category, ComputeScheduleResult, DayOverrides, ScheduleBlock, WeeklyHours } from "@/lib/scheduling/types";

const VIEW_HEIGHT = DAY_END_MIN - DAY_START_MIN; // 720px, 1px/min

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

const hourLabels = Array.from({ length: 12 }, (_, i) => {
  const h = 7 + i;
  return { top: (h - 7) * 60, label: minToLabel(h * 60) };
});

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

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
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
          const dayBlocks = schedule.blocks.filter((b) => b.gday === gday && b.end > DAY_START_MIN && b.start < DAY_END_MIN);
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
                      onSetProgress={(mode, minutes) => onSetProgress(openBlock, mode, minutes)}
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
