"use client";

import { useEffect, useRef, useState } from "react";
import { Block } from "./Block";
import { TaskDetailPopover } from "./TaskDetailPopover";
import { EventDetailPopover } from "./EventDetailPopover";
import { defaultDayWindow, resolveDayWindow } from "@/lib/scheduling/day-window";
import { DayHoursPopover } from "./DayHoursPopover";
import { dateKey as toDateKey } from "@/lib/calendar/day-hours";
import { describeDayFocus } from "@/lib/planner/day-focus-form";
import { computeBlockLanes, DAY_END_MIN, DAY_START_MIN, DEFAULT_SCROLL_MIN, PX_PER_MIN } from "@/lib/scheduling/render";
import { dateForGday, minToLabel, nowAbsMinute, WEEKDAY_LABELS } from "@/lib/scheduling/time";
import type { Category, ComputeScheduleResult, DayOverrides, Project, ScheduleBlock, WeeklyHours } from "@/lib/scheduling/types";

// Full 24h day, at PX_PER_MIN — scrolled to the working window by default.
const VIEW_HEIGHT = (DAY_END_MIN - DAY_START_MIN) * PX_PER_MIN;

interface WeekGridProps {
  /** First day shown, in grid days (0 = Monday of the current week). The view
   * is a sliding window, so this need not land on a Monday. */
  startGday: number;
  /** How many day columns to render (1, 3, 5 or 7). */
  viewDays: number;
  timezone: string;
  weeklyHours: WeeklyHours;
  dayOverrides: DayOverrides;
  /** Days claimed by an all-day calendar entry, and what it blocks. */
  allDayBlocks: Record<number, "no_meetings" | "away">;
  schedule: ComputeScheduleResult;
  categories: Category[];
  /** For the day-header control that hands a day's label time to one of them. */
  projects: Project[];
  onSetProgress: (block: ScheduleBlock, mode: "done" | "partial" | "none", minutes?: number) => void;
  onPinDone: (block: ScheduleBlock) => void;
  onUnpinDone: (block: ScheduleBlock) => void;
  /** Re-read after a day's hours change — the whole schedule reflows around them. */
  onRefresh: () => Promise<void>;
  /** Opens a manual event for editing, by its events-table id. */
  onOpenEvent: (eventId: string) => void;
}

const hourLabels = Array.from({ length: 24 }, (_, h) => ({ top: h * 60 * PX_PER_MIN, label: minToLabel(h * 60) }));

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
  startGday,
  viewDays,
  timezone,
  weeklyHours,
  dayOverrides,
  allDayBlocks,
  schedule,
  categories,
  projects,
  onSetProgress,
  onPinDone,
  onUnpinDone,
  onRefresh,
  onOpenEvent,
}: WeekGridProps) {
  const now = new Date();
  const NOW = nowAbsMinute(timezone, now);
  const todayGday = Math.floor(NOW / 1440);
  const [openKey, setOpenKey] = useState<string | null>(null);
  /** Which day's hours are open, by gday. */
  const [openDay, setOpenDay] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The grid spans the full 24h day so you can scroll to any hour, but most
  // days' actual activity is within the normal working window — land there
  // by default (today's current time if it's within the visible range,
  // otherwise the default morning start) rather than dropping at midnight.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const todayInView = todayGday >= startGday && todayGday < startGday + viewDays;
    const nowMinuteOfDay = NOW - todayGday * 1440;
    const targetMin = todayInView ? Math.max(0, nowMinuteOfDay - 90) : DEFAULT_SCROLL_MIN;
    el.scrollTop = targetMin * PX_PER_MIN;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startGday, viewDays]);

  return (
    <div
      ref={scrollRef}
      className="@container flex-1 flex flex-col min-w-0 overflow-y-auto [--cal-gutter:56px] @max-[720px]:[--cal-gutter:38px]"
    >
      {/* Sticky day header row */}
      <div className="flex-none grid sticky top-0 z-[5] bg-bg border-b border-border" style={{ gridTemplateColumns: `var(--cal-gutter,56px) repeat(${viewDays},1fr)` }}>
        <div />
        {Array.from({ length: viewDays }, (_, i) => {
          const gday = startGday + i;
          const isToday = gday === todayGday;
          const date = dateForGday(timezone, gday, now);
          // All-day entries are banners, not blocks: they'd otherwise cover
          // every hour and hide the tasks still scheduled underneath.
          const banners = schedule.blocks.filter((b) => b.gday === gday && b.allDay);
          const away = allDayBlocks?.[gday] === "away";
          return (
            <div
              key={i}
              className="relative py-2.5 pl-2.5 @max-[720px]:pl-1.5 border-l border-border-grid min-w-0"
              // A past day holds only what was logged, never a plan — dimmed so
              // it's clear at a glance that you're looking at a record.
              style={gday < 0 ? { opacity: 0.72 } : undefined}
            >
              <div className="text-[10px] @max-[720px]:text-[9px] tracking-wider @max-[720px]:tracking-wide text-muted uppercase truncate">
                {WEEKDAY_LABELS[((gday % 7) + 7) % 7]}
              </div>
              {/* The date opens this day's hours. Past days are a record of what
                 was worked and are never re-derived from hours, so changing them
                 would alter nothing — left as plain text rather than a control
                 that appears to do something. */}
              {gday < 0 ? (
                <div
                  className="mt-0.5 text-[15px] @max-[720px]:text-[13px] font-medium"
                  style={{ color: "var(--color-text)" }}
                >
                  {date.day}
                </div>
              ) : (
                <button
                  onClick={() => setOpenDay(openDay === gday ? null : gday)}
                  title={
                    resolveDayWindow(gday, weeklyHours, dayOverrides) == null
                      ? "Nothing is scheduled this day — click to change its hours"
                      : "Change this day's hours"
                  }
                  className="mt-0.5 text-[15px] @max-[720px]:text-[13px] font-medium hover:underline"
                  style={{ color: isToday ? "var(--color-accent)" : "var(--color-text)" }}
                >
                  {date.day}
                  {dayOverrides[gday] && <span className="ml-1 align-middle text-[9px] text-muted-2">·</span>}
                  {/* A second dot, in the label's own colour, for a day whose time
                     has been given to one commitment. Same idiom as the override
                     dot beside it; a focus that actually did nothing gets no dot,
                     since the day is not in fact different. */}
                  {schedule.dayFocus
                    .filter((f) => f.gday === gday && !f.skipped)
                    .map((f) => (
                      <span
                        key={f.labelId}
                        className="ml-0.5 align-middle text-[9px]"
                        style={{ color: categories.find((c) => c.id === f.labelId)?.color ?? "var(--color-muted-2)" }}
                        title={describeDayFocus(f)}
                      >
                        ·
                      </span>
                    ))}
                </button>
              )}
              {openDay === gday && (
                <DayHoursPopover
                  dateLabel={`${WEEKDAY_LABELS[((gday % 7) + 7) % 7]} ${date.day}`}
                  dateKey={toDateKey(date)}
                  override={dayOverrides[gday]}
                  standard={defaultDayWindow(gday, weeklyHours)}
                  gday={gday}
                  projects={projects}
                  categories={categories}
                  focuses={schedule.dayFocus.filter((f) => f.gday === gday)}
                  onClose={() => setOpenDay(null)}
                  onSaved={onRefresh}
                />
              )}
              {banners.map((b) => (
                <div
                  key={b.key ?? b.title}
                  title={`${b.title} — ${away ? "nothing is scheduled and nobody can book you" : "nobody can book you, but your own tasks are still scheduled"}`}
                  className="mt-1 mr-2 rounded px-1.5 py-0.5 text-[9.5px] leading-tight truncate"
                  style={{
                    background: away ? "rgba(229,72,77,0.18)" : "rgba(224,169,78,0.16)",
                    border: `1px solid ${away ? "rgba(229,72,77,0.5)" : "rgba(224,169,78,0.5)"}`,
                    color: away ? "#ffb4b6" : "#e0a94e",
                  }}
                >
                  {b.title}
                  <span className="opacity-70">{away ? " · away" : " · no meetings"}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* Grid body */}
      <div className="flex-none grid relative" style={{ gridTemplateColumns: `var(--cal-gutter,56px) repeat(${viewDays},1fr)` }}>
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

        {Array.from({ length: viewDays }, (_, i) => {
          const gday = startGday + i;
          const isToday = gday === todayGday;
          const defaultWindow = defaultDayWindow(gday, weeklyHours);
          const effWindow = resolveDayWindow(gday, weeklyHours, dayOverrides, allDayBlocks);
          const merged = mergeAdjacentTaskBlocks(schedule.blocks.filter((b) => b.gday === gday && !b.allDay));
          const dayBlocks = merged.filter((b) => b.end > DAY_START_MIN && b.start < DAY_END_MIN);
          const blockLanes = computeBlockLanes(dayBlocks);
          const showNow = isToday && NOW - todayGday * 1440 >= DAY_START_MIN && NOW - todayGday * 1440 <= DAY_END_MIN;
          const nowTop = (NOW - todayGday * 1440 - DAY_START_MIN) * PX_PER_MIN;

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
                backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${60 * PX_PER_MIN - 1}px, rgba(233,233,237,0.06) ${60 * PX_PER_MIN}px)`,
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
                      style={{ top: 0, height: (effStart - DAY_START_MIN) * PX_PER_MIN, background: "rgba(22,24,38,0.7)" }}
                    >
                      <span className="text-[9.5px] tracking-wide uppercase text-muted-2">
                        {startLabel(defaultWindow, effWindow.start)}
                      </span>
                    </div>
                  )}
                  {effEnd < DAY_END_MIN && (
                    <div
                      className="absolute left-0 right-0 flex items-center justify-center"
                      style={{
                        top: (effEnd - DAY_START_MIN) * PX_PER_MIN,
                        height: (DAY_END_MIN - effEnd) * PX_PER_MIN,
                        background: "rgba(22,24,38,0.7)",
                      }}
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
                    projects={projects}
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
                  const popoverTop = Math.min((clampStart - DAY_START_MIN) * PX_PER_MIN + 22, VIEW_HEIGHT - 180);
                  return openBlock.type === "synced" ? (
                    <EventDetailPopover
                      block={openBlock}
                      top={popoverTop}
                      onClose={() => setOpenKey(null)}
                      // Only a manual event: a synced one is a copy of a row that
                      // belongs to Google or an ICS feed, and the next sync would
                      // take any change back.
                      onEdit={
                        openBlock.eventSource === "manual" && openBlock.eventId
                          ? () => {
                              const id = openBlock.eventId!;
                              setOpenKey(null);
                              onOpenEvent(id);
                            }
                          : undefined
                      }
                    />
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
