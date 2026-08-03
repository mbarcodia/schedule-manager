// The date-only deadline convention, in one place.
//
// A deadline or due date that is a DAY rather than a moment ("AMS Abstract, due
// August 11") still lives in a timestamptz column, with a boolean beside it
// saying the clock time isn't meaningful — see migration 0032 for why that
// shape rather than a separate date column.
//
// The instant stored is the END of that day in the account's timezone, so the
// row still sorts, filters and compares as "that day" everywhere without any
// caller needing to know about the flag. Callers that DO care derive what they
// actually need from the date:
//
//   the engine    — the end of that day's working window, so the work may use
//                   the whole day it's due (see from-db.ts)
//   reminders     — the START of that day's working window, so "one day before"
//                   lands in a morning rather than near midnight
//   display       — the date alone, with no invented hour
//
// Everything here works from civil date parts via zonedTimeToUtc rather than
// arithmetic on instants, so a due date doesn't drift across a DST boundary.

import { zonedNow, zonedTimeToUtc } from "./time";
import type { WeeklyHoursJson } from "@/lib/supabase/database.types";

/** Minute-of-day a date-only due date is stored at: the last minute of the day,
 * so "is it still due today" and "which day is this" both answer correctly. */
export const ALL_DAY_DUE_MIN = 23 * 60 + 59;

/** Used when the due date falls on a day with no configured working hours (a
 * weekend, a day switched off). The day still has a due date on it — it just
 * has no window to read, and picking a mid-morning hour beats both midnight
 * (reminders at 00:00) and 23:59 (a "day before" reminder near midnight). */
const FALLBACK_DAY_START_MIN = 9 * 60;

/** The instant to store for a date-only due date on this civil date. */
export function allDayDueAt(
  date: { year: number; month: number; day: number },
  timezone: string,
): string {
  return zonedTimeToUtc(
    date.year,
    date.month,
    date.day,
    Math.floor(ALL_DAY_DUE_MIN / 60),
    ALL_DAY_DUE_MIN % 60,
    timezone,
  ).toISOString();
}

/** What a date-only item's lead times count back from: the start of the working
 * day it's due on. Returns the stored instant unchanged for a timed item, so
 * callers can use this unconditionally. */
export function leadAnchor(
  dueIso: string,
  allDay: boolean,
  timezone: string,
  weeklyHours: WeeklyHoursJson,
): Date {
  const due = new Date(dueIso);
  if (!allDay) return due;
  const z = zonedNow(timezone, due);
  const startMin = weeklyHours[String(z.weekdayIdx)]?.start ?? FALLBACK_DAY_START_MIN;
  return zonedTimeToUtc(z.year, z.month, z.day, Math.floor(startMin / 60), startMin % 60, timezone);
}

/** A due date as the user set it — no hour on a date-only item, because the
 * stored 23:59 is bookkeeping rather than something they chose. */
export function formatDue(dueIso: string, allDay: boolean, timezone: string): string {
  return new Date(dueIso).toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(allDay ? {} : { hour: "numeric", minute: "2-digit" }),
  });
}
