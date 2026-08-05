"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  CaretDoubleLeftIcon,
  CaretDoubleRightIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckIcon,
  CopyIcon,
  GearSixIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { WeekGrid } from "./WeekGrid";
import { dateForGday, WEEKDAY_LABELS, zonedNow } from "@/lib/scheduling/time";
import {
  DEFAULT_VIEW_DAYS,
  VIEW_DAY_OPTIONS,
  onViewDaysChange,
  readViewDays,
  writeViewDays,
  type ViewDays,
} from "@/lib/calendar/view-prefs";
import type { UseScheduleDataResult } from "@/hooks/useScheduleData";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

interface CalendarPanelProps {
  scheduleData: UseScheduleDataResult;
}

export function CalendarPanel({ scheduleData }: CalendarPanelProps) {
  // The view is a sliding window of days, not a fixed Mon-Sun week: startGday
  // can land on any weekday so you can look at, say, Tue-Mon.
  const [startGday, setStartGday] = useState(0);
  /** The slug of an active booking link, so the calendar can offer the public
   * page directly — sharing it is a frequent errand, and it lived three clicks
   * deep in Settings. Null while loading or when none is set up. */
  const [bookingSlug, setBookingSlug] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [viewDays, setViewDays] = useState<ViewDays>(DEFAULT_VIEW_DAYS);
  const { data, schedule, loading, error, setProgress, pinDone, unpinDone } = scheduleData;

  useEffect(() => {
    void (async () => {
      const { data } = await createClient()
        .from("booking_links")
        .select("slug")
        .eq("active", true)
        .order("created_at")
        .limit(1);
      setBookingSlug(data?.[0]?.slug ?? null);
    })();
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setViewDays(readViewDays());
    return onViewDaysChange(setViewDays);
  }, []);

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
  const horizonDays = data.inputs.horizonWeeks * 7;
  // gday 0 is Monday of the current week, so today's index is its weekday.
  const todayGday = zonedNow(timezone).weekdayIdx;
  const maxStart = Math.max(0, horizonDays - viewDays);
  const shift = (delta: number) => setStartGday((g) => Math.min(maxStart, Math.max(0, g + delta)));
  /** A week at a time, keeping the weekday you're looking at.
   *
   * The double arrows used to move by viewDays, so in a 5-day view Monday–Friday
   * jumped to Saturday–Wednesday and every press walked the weekday further
   * round. Clamped in WHOLE weeks rather than to maxStart, because landing on
   * maxStart would change the starting weekday — the one thing this button
   * exists to preserve. */
  const shiftWeek = (weeks: number) =>
    setStartGday((g) => {
      const next = g + weeks * 7;
      return next < 0 || next > maxStart ? g : next;
    });

  const first = dateForGday(timezone, startGday);
  const last = dateForGday(timezone, startGday + viewDays - 1);
  const weekLabel =
    viewDays === 1
      ? `${WEEKDAY_LABELS[((startGday % 7) + 7) % 7]} ${MONTH_NAMES[first.month - 1]} ${first.day}, ${first.year}`
      : first.month === last.month
        ? `${MONTH_NAMES[first.month - 1]} ${first.day}–${last.day}, ${last.year}`
        : `${MONTH_NAMES[first.month - 1]} ${first.day} – ${MONTH_NAMES[last.month - 1]} ${last.day}, ${last.year}`;

  // Only blocks inside the visible window reach the grid.
  const weekBlocks = schedule.blocks.filter((b) => b.gday >= startGday && b.gday < startGday + viewDays);
  // "Missed" is a this-week concept, so only surface it when this week is in view.
  const weekMissed = startGday < 7 ? schedule.missed : [];
  const hasRisk = schedule.risk.length > 0;
  const hasNearDeadline = schedule.nearDeadline.length > 0;
  const hasOverflow = schedule.overflow.length > 0;
  // Not a warning: work that starts beyond the planning horizon has no capacity
  // problem to report, so it gets a neutral note rather than a red flag.
  const beyondHorizon = schedule.beyondHorizon;
  const hasMissed = weekMissed.length > 0;
  const hasWarnings = hasRisk || hasNearDeadline || hasOverflow || hasMissed || beyondHorizon.length > 0;

  return (
    <div className="@container flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Top bar. Wraps rather than overflowing: it holds three groups, and at
         narrow widths they used to collide into each other and push the
         right-hand links out of view entirely. Sizing is by CONTAINER width,
         since what makes this narrow is the chat panel taking room, which a
         viewport breakpoint can't see. */}
      <div className="flex-none min-h-14 flex items-center justify-between flex-wrap gap-x-5 gap-y-2 px-[22px] py-2 border-b border-border">
        <div className="flex items-center gap-2.5">
          <svg width={16} height={16} viewBox="0 0 256 256" fill="none">
            <rect x="32" y="48" width="192" height="168" rx="16" stroke="#9184d9" strokeWidth="14" />
            <line x1="32" y1="96" x2="224" y2="96" stroke="#9184d9" strokeWidth="14" />
            <line x1="80" y1="24" x2="80" y2="64" stroke="#9184d9" strokeWidth="14" strokeLinecap="round" />
            <line x1="176" y1="24" x2="176" y2="64" stroke="#9184d9" strokeWidth="14" strokeLinecap="round" />
          </svg>
          <span className="font-medium text-base tracking-tight @max-[820px]:hidden">Schedule</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => shiftWeek(-1)}
            title="Back one week (same weekday)"
            disabled={startGday - 7 < 0}
            className="inline-flex items-center justify-center border border-border rounded-md w-[30px] h-[30px] hover:bg-white/5 disabled:opacity-40"
          >
            <CaretDoubleLeftIcon size={13} weight="bold" />
          </button>
          <button
            onClick={() => shift(-1)}
            title="Back one day"
            disabled={startGday === 0}
            className="inline-flex items-center justify-center border border-border rounded-md w-[30px] h-[30px] hover:bg-white/5 disabled:opacity-40"
          >
            <CaretLeftIcon size={14} weight="bold" />
          </button>
          <span
            className="text-[13px] text-neutral-300 min-w-[150px] @max-[900px]:min-w-[104px] text-center whitespace-nowrap"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {weekLabel}
          </span>
          <button
            onClick={() => shift(1)}
            title="Forward one day"
            disabled={startGday >= maxStart}
            className="inline-flex items-center justify-center border border-border rounded-md w-[30px] h-[30px] hover:bg-white/5 disabled:opacity-40"
          >
            <CaretRightIcon size={14} weight="bold" />
          </button>
          <button
            onClick={() => shiftWeek(1)}
            title="Forward one week (same weekday)"
            disabled={startGday + 7 > maxStart}
            className="inline-flex items-center justify-center border border-border rounded-md w-[30px] h-[30px] hover:bg-white/5 disabled:opacity-40"
          >
            <CaretDoubleRightIcon size={13} weight="bold" />
          </button>
          <button
            onClick={() => setStartGday(viewDays === 7 ? 0 : todayGday)}
            title={viewDays === 7 ? "Back to this week" : "Start at today"}
            className="border border-accent text-accent rounded-md h-[30px] px-3.5 text-xs font-medium hover:bg-accent/10"
          >
            Today
          </button>
          <div className="flex items-center gap-1 border-l border-border pl-3 ml-1">
            <span className="text-[10px] tracking-wide uppercase text-muted-2 mr-0.5 @max-[1080px]:hidden">Viewer</span>
            {VIEW_DAY_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => {
                  writeViewDays(d);
                  // Keep today in frame when narrowing the window.
                  setStartGday(d === 7 ? 0 : Math.min(Math.max(0, horizonDays - d), todayGday));
                }}
                title={`Show ${d} day${d > 1 ? "s" : ""} at a time`}
                className="rounded-md w-[26px] h-[26px] text-[11px] font-medium border"
                style={{
                  borderColor: viewDays === d ? "var(--color-accent)" : "var(--color-border)",
                  background: viewDays === d ? "rgba(145,132,217,0.1)" : "transparent",
                }}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3 justify-end flex-wrap">
          <div className="flex items-center gap-1.5 text-[10.5px] text-muted @max-[1180px]:hidden">
            {data.categories.map((c) => (
              <span key={c.id} className="inline-flex items-center gap-1">
                <span className="inline-block rounded-full" style={{ width: 7, height: 7, background: c.color, border: "1px solid rgba(233,233,237,0.3)" }} />
                {c.name}
              </span>
            ))}
          </div>
          <span
            className="inline-flex items-center text-[10.5px] tracking-wide px-2 py-0.5 rounded-md border @max-[1000px]:hidden"
            style={{ borderColor: "#e0a94e", color: "#e0a94e" }}
          >
            At risk
          </span>
          <span
            className="inline-flex items-center text-[10.5px] tracking-wide px-2 py-0.5 rounded-md border @max-[1000px]:hidden"
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
          {bookingSlug ? (
            <span className="inline-flex items-stretch border border-border rounded-md h-[30px] overflow-hidden">
              <a
                href={`/book/${bookingSlug}`}
                target="_blank"
                rel="noreferrer"
                title="Open your public booking page in a new tab"
                className="inline-flex items-center px-2.5 hover:bg-white/5 text-muted text-[12px] font-medium"
              >
                Booking
              </a>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(`${window.location.origin}/book/${bookingSlug}`);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                title="Copy the link to send to someone"
                className="inline-flex items-center px-2 border-l border-border hover:bg-white/5 text-muted"
              >
                {copied ? <CheckIcon size={13} weight="bold" /> : <CopyIcon size={13} />}
              </button>
            </span>
          ) : (
            <Link
              href="/settings#booking"
              title="Set up a booking page so people can book time with you"
              className="inline-flex items-center border border-border rounded-md h-[30px] px-2.5 hover:bg-white/5 text-muted text-[12px] font-medium"
            >
              Booking
            </Link>
          )}
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
          {beyondHorizon.length > 0 && (
            <span className="text-muted">
              Starts beyond the planned six months, so not scheduled yet: {beyondHorizon.join(", ")}
            </span>
          )}
        </div>
      )}

      <WeekGrid
        startGday={startGday}
        viewDays={viewDays}
        timezone={timezone}
        weeklyHours={data.inputs.weeklyHours}
        dayOverrides={data.inputs.dayOverrides}
        allDayBlocks={data.inputs.allDayBlocks}
        schedule={{ ...schedule, blocks: weekBlocks }}
        categories={data.categories}
        onSetProgress={setProgress}
        onPinDone={pinDone}
        onUnpinDone={unpinDone}
      />
    </div>
  );
}
