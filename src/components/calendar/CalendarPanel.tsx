"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  ArrowsClockwiseIcon,
  CaretDoubleLeftIcon,
  CaretDoubleRightIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckIcon,
  CopyIcon,
  GearSixIcon,
  PlusIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { WeekGrid } from "./WeekGrid";
import { ShortfallPanel } from "./ShortfallPanel";
import { EventPanel } from "./EventPanel";
import { dateForGday, WEEKDAY_LABELS, zonedNow } from "@/lib/scheduling/time";
import {
  DEFAULT_VIEW_DAYS,
  VIEW_DAY_OPTIONS,
  onViewDaysChange,
  readViewDays,
  writeViewDays,
  type ViewDays,
} from "@/lib/calendar/view-prefs";
import { HISTORY_WEEKS } from "@/lib/scheduling/horizon";
import type { UseScheduleDataResult } from "@/hooks/useScheduleData";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Where this panel's two halves sit in the page's grid. Explicit rather than
// auto-placed: auto-placement fills row-major, which would put the calendar's
// BODY next to its own header instead of under it. See app/page.tsx.
const HEADER_CELL: React.CSSProperties = { gridColumn: 1, gridRow: 1 };
const BODY_CELL: React.CSSProperties = { gridColumn: 1, gridRow: 2, display: "flex", flexDirection: "column" };

function CalendarMark() {
  return (
    <svg width={16} height={16} viewBox="0 0 256 256" fill="none">
      <rect x="32" y="48" width="192" height="168" rx="16" stroke="#9184d9" strokeWidth="14" />
      <line x1="32" y1="96" x2="224" y2="96" stroke="#9184d9" strokeWidth="14" />
      <line x1="80" y1="24" x2="80" y2="64" stroke="#9184d9" strokeWidth="14" strokeLinecap="round" />
      <line x1="176" y1="24" x2="176" y2="64" stroke="#9184d9" strokeWidth="14" strokeLinecap="round" />
    </svg>
  );
}

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
  /** A manual event id being edited, "new" for a fresh one, null for closed. */
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [viewDays, setViewDays] = useState<ViewDays>(DEFAULT_VIEW_DAYS);
  /** Null until the connections have been read — the Sync button stays hidden
   * until we know there is something to sync, rather than flashing in and out. */
  const [hasConnections, setHasConnections] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const { data, schedule, loading, error, writeError, dismissWriteError, refresh, setProgress, pinDone, unpinDone } =
    scheduleData;

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

  const readConnections = useCallback(async () => {
    const { data } = await createClient()
      .from("calendar_connections")
      .select("last_synced_at")
      .order("last_synced_at", { ascending: false, nullsFirst: false });
    setHasConnections((data ?? []).length > 0);
    const newest = data?.[0]?.last_synced_at;
    setLastSyncedAt(newest ? new Date(newest).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null);
  }, []);

  // Wrapped in an async IIFE like the booking-slug effect above it: the state
  // is set from the awaited result, not synchronously in the effect body, which
  // is the distinction the React Compiler lint is checking for.
  useEffect(() => {
    void (async () => {
      await readConnections();
    })();
  }, [readConnections]);

  /** Re-pull every connected feed, then re-derive the schedule from what landed.
   *
   * Settings' copy of this fires the same request and ignores what comes back,
   * so a feed whose URL has rotated reports nothing and the calendar quietly
   * keeps showing last week's meetings. The count is in the response; this one
   * reads it. */
  const syncNow = useCallback(async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await fetch("/api/calendar/sync", { method: "POST" });
      const body = (await res.json().catch(() => null)) as { synced?: number; failed?: number; error?: string } | null;
      if (!res.ok) {
        setSyncError(body?.error ?? `Couldn't sync your calendars (${res.status}).`);
      } else if (body?.failed) {
        setSyncError(
          `${body.failed} of ${(body.synced ?? 0) + body.failed} calendars didn't sync — check their links in Settings.`,
        );
      }
      // Refreshed even on a partial failure: whatever DID sync is now newer than
      // what's on screen, and leaving the old view up would be the worse lie.
      await refresh();
      await readConnections();
    } catch {
      setSyncError("Couldn't reach the server to sync your calendars.");
    } finally {
      setSyncing(false);
    }
  }, [refresh, readConnections]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setViewDays(readViewDays());
    return onViewDaysChange(setViewDays);
  }, []);

  // Loading and error still render the header row, empty. The page's grid sizes
  // that row to the taller of the two headers, so returning a single centred
  // message (as this used to) left the chat's header alone in the row and the
  // whole layout jumped the moment the schedule arrived.
  if (loading || error || !data || !schedule) {
    return (
      <>
        <div style={HEADER_CELL} className="min-h-14 flex items-center px-[22px] border-b border-border">
          <div className="flex items-center gap-2.5">
            <CalendarMark />
            <span className="font-medium text-base tracking-tight">Schedule</span>
          </div>
        </div>
        <div style={BODY_CELL} className="flex items-center justify-center min-w-0">
          {loading ? (
            <p className="text-sm text-muted">Loading your schedule…</p>
          ) : (
            <p className="text-sm text-accent-text">{error ?? "Couldn't load your schedule."}</p>
          )}
        </div>
      </>
    );
  }

  const timezone = data.inputs.timezone;
  const horizonDays = data.inputs.horizonWeeks * 7;
  // Scrollable into the past as well as the future. A past week is a record of
  // what was logged, not a re-derived plan — see historyBlocks in from-db.
  const minStart = -HISTORY_WEEKS * 7;
  // gday 0 is Monday of the current week, so today's index is its weekday.
  const todayGday = zonedNow(timezone).weekdayIdx;
  const maxStart = Math.max(0, horizonDays - viewDays);
  const shift = (delta: number) => setStartGday((g) => Math.min(maxStart, Math.max(minStart, g + delta)));
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
      return next < minStart || next > maxStart ? g : next;
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
  // A pin whose slot a meeting has taken since. Not lost time — the work is
  // auto-scheduled instead — but the user asked for that exact hour and no
  // longer has it, so it is said rather than quietly absorbed.
  const displacedPins = schedule.displacedPins ?? [];
  // Not a warning: work that starts beyond the planning horizon has no capacity
  // problem to report, so it gets a neutral note rather than a red flag.
  const beyondHorizon = schedule.beyondHorizon;
  const hasMissed = weekMissed.length > 0;
  const hasWarnings =
    hasRisk || hasNearDeadline || hasOverflow || hasMissed || beyondHorizon.length > 0 || displacedPins.length > 0;

  return (
    <>
      {/* Top bar. Wraps rather than overflowing: it holds three groups, and at
         narrow widths they used to collide into each other and push the
         right-hand links out of view entirely. Sizing is by CONTAINER width,
         since what makes this narrow is the chat panel taking room, which a
         viewport breakpoint can't see. */}
      <div
        style={HEADER_CELL}
        className="@container min-w-0 min-h-14 flex items-center justify-between flex-wrap gap-x-5 gap-y-2 px-[22px] py-2 border-b border-border"
      >
        <div className="flex items-center gap-2.5">
          <CalendarMark />
          <span className="font-medium text-base tracking-tight @max-[820px]:hidden">Schedule</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => shiftWeek(-1)}
            title="Back one week (same weekday)"
            disabled={startGday - 7 < minStart}
            className="inline-flex items-center justify-center border border-border rounded-md w-[30px] h-[30px] hover:bg-white/5 disabled:opacity-40"
          >
            <CaretDoubleLeftIcon size={13} weight="bold" />
          </button>
          <button
            onClick={() => shift(-1)}
            title="Back one day"
            disabled={startGday <= minStart}
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
                  // Staying put when already looking at a past week — changing how
                  // many days are shown shouldn't jump you back to today.
                  setStartGday((g) =>
                    g < 0 ? Math.max(minStart, g) : d === 7 ? 0 : Math.min(Math.max(0, horizonDays - d), todayGday),
                  );
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
          <button
            onClick={() => setOpenEvent("new")}
            title="Add a meeting or an away day"
            className="inline-flex items-center gap-1 border border-border rounded-md h-[30px] px-2.5 hover:bg-white/5 text-muted text-[12px] font-medium"
          >
            <PlusIcon size={12} /> Event
          </button>
          {/* Re-pull the connected calendars. It existed only in Settings, three
             clicks from the one screen where a missing meeting is actually
             noticed — and noticing it here is the entire trigger for wanting it.
             Hidden when nothing is connected, since it would do nothing. */}
          {hasConnections && (
            <button
              onClick={() => void syncNow()}
              disabled={syncing}
              title={
                lastSyncedAt
                  ? `Re-check your connected calendars now. Last synced ${lastSyncedAt}.`
                  : "Re-check your connected calendars now"
              }
              className="inline-flex items-center gap-1 border border-border rounded-md h-[30px] px-2.5 hover:bg-white/5 text-muted text-[12px] font-medium disabled:opacity-50"
            >
              <ArrowsClockwiseIcon size={12} className={syncing ? "animate-spin" : undefined} />
              <span className="@max-[1240px]:hidden">{syncing ? "Syncing…" : "Sync"}</span>
            </button>
          )}
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

      <div style={BODY_CELL} className="@container min-w-0 overflow-hidden">
      {/* A write that didn't land, or a sync that did. Deliberately a strip
         rather than the full-view error above: failing to save one tick is not a
         reason to take the calendar away. Every write refreshes afterwards, so
         without this the block simply un-ticked itself and said nothing. */}
      {(writeError || syncError) && (
        <div
          className="flex-none px-4 py-2 text-[11px] border-b border-border flex items-center gap-2"
          style={{ color: "#e5484d" }}
        >
          <span className="flex-1 min-w-0">{writeError ?? syncError}</span>
          <button
            onClick={() => (writeError ? dismissWriteError() : setSyncError(null))}
            className="flex-none text-muted-2 hover:text-text"
          >
            dismiss
          </button>
        </div>
      )}

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
          {displacedPins.length > 0 && (
            <span>
              Moved off its pinned time by a meeting, and rescheduled: {displacedPins.join(", ")}
            </span>
          )}
          {beyondHorizon.length > 0 && (
            <span className="text-muted">
              Starts beyond the planned six months, so not scheduled yet: {beyondHorizon.join(", ")}
            </span>
          )}
        </div>
      )}

      {/* Sits below the warning banner rather than inside it: that one names
         what fell short, this one says what could be done about it, and the
         second only makes sense once you have read the first. */}
      <ShortfallPanel inputs={data.inputs} schedule={schedule} />

      <WeekGrid
        startGday={startGday}
        viewDays={viewDays}
        timezone={timezone}
        weeklyHours={data.inputs.weeklyHours}
        dayOverrides={data.inputs.dayOverrides}
        allDayBlocks={data.inputs.allDayBlocks}
        schedule={{ ...schedule, blocks: weekBlocks }}
        categories={data.categories}
        projects={data.projects}
        onSetProgress={setProgress}
        onPinDone={pinDone}
        onUnpinDone={unpinDone}
        onRefresh={refresh}
        onOpenEvent={setOpenEvent}
      />

      {openEvent && (
        <EventPanel
          eventId={openEvent === "new" ? null : openEvent}
          onClose={() => setOpenEvent(null)}
          onSaved={refresh}
        />
      )}
      </div>
    </>
  );
}
