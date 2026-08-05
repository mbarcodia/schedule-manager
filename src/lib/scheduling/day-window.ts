// Single source of truth for "what hours is this day open, if any" — used by
// both the engine (slot-finding) and the calendar UI (before/after-hours
// dimming, STARTS EARLY/LATE labels). Having two hand-rolled copies of this
// logic is exactly how the STARTS EARLY/LATE label bug happened — the UI's
// copy never compared against the real per-weekday default.

import type { DayOverrides, GDay, MinuteOfDay, WeeklyHours } from "./types";

export interface DayWindow {
  start: MinuteOfDay;
  end: MinuteOfDay;
}

const FALLBACK_WINDOW: DayWindow = { start: 9 * 60, end: 17 * 60 };

/** Resolves the effective working window for a given grid day, or null if
 * the day is off (no window at all — nothing gets scheduled, nothing
 * renders as "hours").
 *
 * allDayBlocks closes a day marked "away" by an all-day calendar entry. Days
 * marked "no_meetings" keep their hours: the point of that mode is that you're
 * unavailable to others but still working, so only the booking page excludes
 * them. Passing it is optional so a caller that genuinely only cares about
 * configured hours (the STARTS EARLY/LATE comparison) can leave it out. */
export function resolveDayWindow(
  gday: GDay,
  weeklyHours: WeeklyHours,
  dayOverrides: DayOverrides,
  allDayBlocks?: Record<GDay, "no_meetings" | "away">,
): DayWindow | null {
  if (allDayBlocks?.[gday] === "away") return null;

  // Normalised, because a gday is negative for a past day and `-1 % 7` is -1 in
  // JS — which looked up weeklyHours[-1], found nothing, and reported every day
  // before this week as a day off.
  const dow = ((gday % 7) + 7) % 7;
  const defaultWindow = weeklyHours[dow] ?? null;
  const override = dayOverrides[gday];

  if (override && (override.start != null || override.end != null || override.allowWeekend)) {
    const base = defaultWindow ?? FALLBACK_WINDOW;
    return {
      start: override.start ?? base.start,
      end: override.end ?? base.end,
    };
  }

  return defaultWindow;
}

/** The day's *default* window (ignoring any override) — used to tell
 * "starts early" from "starts late" against the account's normal hours for
 * that weekday, not just against the calendar's 7am-7pm render span. */
export function defaultDayWindow(gday: GDay, weeklyHours: WeeklyHours): DayWindow | null {
  return weeklyHours[gday % 7] ?? null;
}
