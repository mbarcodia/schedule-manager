// Free-slot enumeration for the public booking page. Runs entirely on the
// engine's OUTPUT: synced meetings + anchors are hard-busy, task blocks in
// the link's protected categories are busy, all other task time is bookable
// (the engine reflows it around a new meeting automatically). Day windows
// come from resolveDayWindow (single source of truth) intersected with the
// link's own per-weekday window — the link can only ever narrow availability,
// never widen past working hours.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { queryScheduleRows } from "./query-rows";
import { buildScheduleInputs } from "./from-db";
import { computeSchedule, markBusy } from "./engine";
import { resolveDayWindow } from "./day-window";
import { dateForGday, gdayForDate, nowAbsMinute, zonedTimeToUtc } from "./time";
import type { AbsMinute } from "./types";

type BookingLink = Database["public"]["Tables"]["booking_links"]["Row"];

export interface FreeSlot {
  startIso: string;
  durationMin: number;
}

/** Visitors pick from a 30-minute start grid (Calendly-standard; the busy
 * set is minute-accurate underneath, so odd-shaped meetings still block
 * correctly). */
const START_GRID_MIN = 30;

/** How long a calendar feed may go unsynced before the booking link stops
 * trusting it.
 *
 * Sized to the sync cadence, not to taste: /api/cron/sync-calendars runs once a
 * day (Vercel's plan allows one cron job, daily), so the data is routinely 23
 * hours old in normal operation. 26 gives that a couple of hours of slack —
 * tight enough to catch a feed that has actually stopped, loose enough that a
 * healthy calendar never trips it. Shortening this without also making the sync
 * run more often would pause the booking link most of every day. */
export const FEED_STALE_HOURS = 26;

/** Whether the stored calendar data is fresh enough to be worth trusting.
 *
 * The booking link is the one surface where being wrong costs someone else
 * their time: a stranger picks a slot the owner is actually busy in, and both
 * of them find out at the meeting. Every other view of bad data is merely
 * confusing to the person who can already see it is wrong.
 *
 * So this fails SAFE. If a feed is erroring or has gone quiet, the link offers
 * nothing rather than offering times it cannot vouch for. */
export interface FeedHealth {
  ok: boolean;
  /** Owner-facing explanation; never shown to a visitor. */
  reason: string | null;
}

async function assessFeeds(
  admin: SupabaseClient<Database>,
  userId: string,
  now: Date,
): Promise<FeedHealth> {
  const { data: connections, error } = await admin
    .from("calendar_connections")
    .select("label,last_synced_at,last_sync_error")
    .eq("user_id", userId);

  // A failed lookup is not evidence of health. Treating an error as "all fine"
  // is how a guardrail quietly stops guarding.
  if (error) return { ok: false, reason: "could not check calendar sync status" };
  if (!connections || connections.length === 0) return { ok: true, reason: null };

  const broken = connections.filter((c) => c.last_sync_error);
  if (broken.length > 0) {
    return { ok: false, reason: `${broken.map((c) => c.label).join(", ")} failed to sync` };
  }

  const cutoff = now.getTime() - FEED_STALE_HOURS * 3600000;
  const stale = connections.filter((c) => !c.last_synced_at || new Date(c.last_synced_at).getTime() < cutoff);
  if (stale.length > 0) {
    return { ok: false, reason: `${stale.map((c) => c.label).join(", ")} hasn't synced in over ${FEED_STALE_HOURS} hours` };
  }

  return { ok: true, reason: null };
}

export interface AvailabilityContext {
  busy: Set<AbsMinute>;
  /** Whether the busy set above can be trusted at all. */
  feeds: FeedHealth;
  timezone: string;
  weeklyHours: ReturnType<typeof buildScheduleInputs>["inputs"]["weeklyHours"];
  dayOverrides: ReturnType<typeof buildScheduleInputs>["inputs"]["dayOverrides"];
  minNoticeAbs: number;
  bookingsPerGday: Map<number, number>;
  horizonWeeks: number;
  /** Days an all-day calendar entry has claimed. BOTH modes make a day
   * unbookable — the difference between them is only whether the owner's own
   * work still gets scheduled, which is none of a visitor's business. Without
   * this, a week away at a conference was offered to strangers as free. */
  allDayBlocks: Record<number, "no_meetings" | "away">;
}

/** One fetch+compute shared by the slots GET (whole week) and the booking
 * POST's re-validation (single instant). */
export async function buildAvailability(
  admin: SupabaseClient<Database>,
  link: BookingLink,
  now: Date = new Date(),
): Promise<AvailabilityContext> {
  const rows = await queryScheduleRows(admin, link.user_id, now);
  const feeds = await assessFeeds(admin, link.user_id, now);
  const { inputs } = buildScheduleInputs(rows, now);
  const schedule = computeSchedule(inputs, now);
  const blocking = new Set(link.blocking_category_ids);

  const busy = new Set<AbsMinute>();
  for (const b of schedule.blocks) {
    if (b.gday < 0) continue; // past weeks are a record; nothing there is bookable
    const hard = b.type === "synced" || b.type === "anchor";
    const protectedTask = b.type === "task" && b.categoryId != null && blocking.has(b.categoryId);
    if (!hard && !protectedTask) continue;
    // Buffer pads meetings only — protected task time blocks exactly itself.
    const pad = b.type === "synced" ? link.buffer_min : 0;
    const from = Math.max(0, b.gday * 1440 + b.start - pad);
    const to = b.gday * 1440 + b.end + pad;
    markBusy(from, to - from, busy);
  }

  // Existing bookings per grid day, for the per-day cap. Booked meetings are
  // also events rows (already hard-busy above); this only counts them.
  const horizonEnd = new Date(now.getTime() + inputs.horizonWeeks * 7 * 86400000);
  const { data: existing } = await admin
    .from("bookings")
    .select("starts_at")
    .eq("user_id", link.user_id)
    .eq("link_id", link.id)
    .gte("starts_at", now.toISOString())
    .lte("starts_at", horizonEnd.toISOString());
  const bookingsPerGday = new Map<number, number>();
  for (const b of existing ?? []) {
    const d = new Date(b.starts_at);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: inputs.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
    const [y, m, day] = parts.split("-").map(Number);
    const gday = gdayForDate(inputs.timezone, { year: y, month: m, day }, now);
    bookingsPerGday.set(gday, (bookingsPerGday.get(gday) ?? 0) + 1);
  }

  return {
    busy,
    feeds,
    timezone: inputs.timezone,
    weeklyHours: inputs.weeklyHours,
    dayOverrides: inputs.dayOverrides,
    minNoticeAbs: nowAbsMinute(inputs.timezone, now) + link.min_notice_hours * 60,
    bookingsPerGday,
    horizonWeeks: inputs.horizonWeeks,
    allDayBlocks: inputs.allDayBlocks,
  };
}

function windowFor(ctx: AvailabilityContext, link: BookingLink, gday: number): { start: number; end: number } | null {
  // An all-day entry closes the day to bookings whichever mode it is.
  if (ctx.allDayBlocks[gday]) return null;
  const work = resolveDayWindow(gday, ctx.weeklyHours, ctx.dayOverrides, ctx.allDayBlocks);
  const linkWin = link.day_windows[String(gday % 7)] ?? null;
  if (!work || !linkWin) return null;
  const start = Math.max(work.start, linkWin.start);
  const end = Math.min(work.end, linkWin.end);
  return end > start ? { start, end } : null;
}

/** Whether one exact slot is offerable. Shared by the week listing and the
 * booking POST's re-validation: these two disagreeing is how a slot gets shown
 * and then rejected, so they run the same checks rather than parallel copies. */
export function slotIsOffered(
  ctx: AvailabilityContext,
  link: BookingLink,
  gday: number,
  startMin: number,
  durationMin: number,
): boolean {
  // First, because nothing below means anything if the busy set is stale: a
  // "free" answer computed from a broken feed is exactly the wrong answer.
  if (!ctx.feeds.ok) return false;
  const win = windowFor(ctx, link, gday);
  if (!win || startMin < win.start || startMin + durationMin > win.end) return false;
  // null = no maximum, which is not the same as a big number: a number is a
  // guess that silently becomes wrong when a day has more room than expected.
  // It must not be read as zero, which would close every day.
  if (link.max_per_day != null && (ctx.bookingsPerGday.get(gday) ?? 0) >= link.max_per_day) return false;
  const abs = gday * 1440 + startMin;
  if (abs < ctx.minNoticeAbs) return false;
  return rangeFree(ctx.busy, abs, durationMin);
}

function rangeFree(busy: Set<AbsMinute>, abs: number, len: number): boolean {
  for (let k = 0; k < len; k += 1) if (busy.has(abs + k)) return false;
  return true;
}

/** All bookable slots of the given duration in grid week `weekIndex` (0 =
 * current week), as UTC instants. */
export async function computeFreeSlots(
  admin: SupabaseClient<Database>,
  link: BookingLink,
  durationMin: number,
  weekIndex: number,
  now: Date = new Date(),
): Promise<{ slots: FreeSlot[]; timezone: string; unavailable: boolean }> {
  const ctx = await buildAvailability(admin, link, now);
  const slots: FreeSlot[] = [];

  // Distinguished from "a full week" on purpose. An empty grid reads as "try a
  // later week", which would send visitors hunting through a link that cannot
  // answer them; the page says the link is paused instead.
  if (!ctx.feeds.ok) {
    console.warn(`[booking] slots withheld for link ${link.slug}: ${ctx.feeds.reason}`);
    return { slots: [], timezone: ctx.timezone, unavailable: true };
  }

  for (let gday = weekIndex * 7; gday < weekIndex * 7 + 7; gday += 1) {
    const win = windowFor(ctx, link, gday);
    if (!win || win.end - win.start < durationMin) continue;

    const firstStart = Math.ceil(win.start / START_GRID_MIN) * START_GRID_MIN;
    for (let m = firstStart; m + durationMin <= win.end; m += START_GRID_MIN) {
      if (!slotIsOffered(ctx, link, gday, m, durationMin)) continue;
      const d = dateForGday(ctx.timezone, gday, now);
      const startUtc = zonedTimeToUtc(d.year, d.month, d.day, Math.floor(m / 60), m % 60, ctx.timezone);
      slots.push({ startIso: startUtc.toISOString(), durationMin });
    }
  }

  return { slots, timezone: ctx.timezone, unavailable: false };
}

/** Authoritative re-validation for the booking POST: is this exact instant
 * still bookable? Recomputes availability from fresh data. */
export async function isSlotFree(
  admin: SupabaseClient<Database>,
  link: BookingLink,
  startIso: string,
  durationMin: number,
  now: Date = new Date(),
): Promise<boolean> {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime()) || start.getTime() < now.getTime()) return false;

  const ctx = await buildAvailability(admin, link, now);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ctx.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(start);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const gday = gdayForDate(ctx.timezone, { year: get("year"), month: get("month"), day: get("day") }, now);
  const minute = get("hour") * 60 + get("minute");

  if (gday < 0 || gday >= ctx.horizonWeeks * 7) return false;
  if (minute % START_GRID_MIN !== 0) return false;
  return slotIsOffered(ctx, link, gday, minute, durationMin);
}
