"use client";

import { useState } from "react";
import Link from "next/link";
import { CaretLeftIcon, CaretRightIcon, GearSixIcon, WarningIcon } from "@phosphor-icons/react";
import { WeekGrid } from "./WeekGrid";
import { dateForGday } from "@/lib/scheduling/time";
import type { UseScheduleDataResult } from "@/hooks/useScheduleData";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

interface CalendarPanelProps {
  scheduleData: UseScheduleDataResult;
}

export function CalendarPanel({ scheduleData }: CalendarPanelProps) {
  const [weekOffset, setWeekOffset] = useState(0);
  const { data, schedule, loading, error, setProgress, pinDone, unpinDone } = scheduleData;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted">Loading your schedule…</p>
      </div>
    );
  }
  if (error || !data || !schedule) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-accent-text">{error ?? "Couldn't load your schedule."}</p>
      </div>
    );
  }

  const timezone = data.inputs.timezone;
  const monday = dateForGday(timezone, weekOffset * 7);
  const sunday = dateForGday(timezone, weekOffset * 7 + 6);
  const weekLabel =
    monday.month === sunday.month
      ? `${MONTH_NAMES[monday.month - 1]} ${monday.day}–${sunday.day}, ${sunday.year}`
      : `${MONTH_NAMES[monday.month - 1]} ${monday.day} – ${MONTH_NAMES[sunday.month - 1]} ${sunday.day}, ${sunday.year}`;

  const weekBlocks = schedule.blocks.filter((b) => Math.floor(b.gday / 7) === weekOffset);
  const weekMissed = weekOffset === 0 ? schedule.missed : [];
  const hasRisk = schedule.risk.length > 0;
  const hasNearDeadline = schedule.nearDeadline.length > 0;
  const hasOverflow = schedule.overflow.length > 0;
  const hasMissed = weekMissed.length > 0;
  const hasWarnings = hasRisk || hasNearDeadline || hasOverflow || hasMissed;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Top bar */}
      <div className="flex-none h-14 flex items-center justify-between px-[22px] border-b border-border">
        <div className="flex items-center gap-2.5 min-w-[170px]">
          <svg width={16} height={16} viewBox="0 0 256 256" fill="none">
            <rect x="32" y="48" width="192" height="168" rx="16" stroke="#9184d9" strokeWidth="14" />
            <line x1="32" y1="96" x2="224" y2="96" stroke="#9184d9" strokeWidth="14" />
            <line x1="80" y1="24" x2="80" y2="64" stroke="#9184d9" strokeWidth="14" strokeLinecap="round" />
            <line x1="176" y1="24" x2="176" y2="64" stroke="#9184d9" strokeWidth="14" strokeLinecap="round" />
          </svg>
          <span className="font-medium text-base tracking-tight">Schedule</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setWeekOffset((w) => w - 1)}
            className="inline-flex items-center justify-center border border-border rounded-md w-[30px] h-[30px] hover:bg-white/5"
          >
            <CaretLeftIcon size={14} weight="bold" />
          </button>
          <span className="text-[13px] text-neutral-300 min-w-[150px] text-center" style={{ fontVariantNumeric: "tabular-nums" }}>
            {weekLabel}
          </span>
          <button
            onClick={() => setWeekOffset((w) => w + 1)}
            className="inline-flex items-center justify-center border border-border rounded-md w-[30px] h-[30px] hover:bg-white/5"
          >
            <CaretRightIcon size={14} weight="bold" />
          </button>
          <button
            onClick={() => setWeekOffset(0)}
            className="border border-accent text-accent rounded-md h-[30px] px-3.5 text-xs font-medium hover:bg-accent/10"
          >
            Today
          </button>
        </div>
        <div className="flex items-center gap-2.5 justify-end">
          <div className="flex items-center gap-1.5 text-[10.5px] text-muted">
            {data.categories.map((c) => (
              <span key={c.id} className="inline-flex items-center gap-1">
                <span className="inline-block rounded-full" style={{ width: 7, height: 7, background: c.color, border: "1px solid rgba(233,233,237,0.3)" }} />
                {c.name}
              </span>
            ))}
          </div>
          <span
            className="inline-flex items-center text-[10.5px] tracking-wide px-2 py-0.5 rounded-md border"
            style={{ borderColor: "#e0a94e", color: "#e0a94e" }}
          >
            At risk
          </span>
          <span
            className="inline-flex items-center text-[10.5px] tracking-wide px-2 py-0.5 rounded-md border"
            style={{ borderColor: "#e5484d", color: "#e5484d" }}
          >
            Will miss
          </span>
          <Link
            href="/planner"
            title="Planner"
            className="inline-flex items-center border border-border rounded-md h-[30px] px-2.5 hover:bg-white/5 text-muted text-[12px] font-medium"
          >
            Planner
          </Link>
          <Link
            href="/settings"
            title="Settings"
            className="inline-flex items-center justify-center border border-border rounded-md w-[30px] h-[30px] hover:bg-white/5 text-muted"
          >
            <GearSixIcon size={16} />
          </Link>
        </div>
      </div>

      {/* Warning banner */}
      {hasWarnings && (
        <div className="flex-none px-[22px] py-2 bg-panel border-b border-border text-xs text-accent-text flex items-center gap-4 flex-wrap">
          <WarningIcon size={14} weight="fill" className="flex-none text-accent" />
          {hasMissed && <span>Missed &amp; rescheduled: {weekMissed.join(", ")}</span>}
          {hasRisk && (
            <span style={{ color: "#ffb4b6" }}>Will miss deadline: {schedule.risk.join(", ")}</span>
          )}
          {hasNearDeadline && (
            <span style={{ color: "#ffd9a0" }}>Cutting it close: {schedule.nearDeadline.join(", ")}</span>
          )}
          {hasOverflow && <span>Didn&apos;t fit this week: {schedule.overflow.join(", ")}</span>}
        </div>
      )}

      <WeekGrid
        weekOffset={weekOffset}
        timezone={timezone}
        weeklyHours={data.inputs.weeklyHours}
        dayOverrides={data.inputs.dayOverrides}
        schedule={{ ...schedule, blocks: weekBlocks }}
        categories={data.categories}
        onSetProgress={setProgress}
        onPinDone={pinDone}
        onUnpinDone={unpinDone}
      />
    </div>
  );
}
