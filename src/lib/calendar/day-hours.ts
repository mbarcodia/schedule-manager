// "This particular day is different" — the working window for ONE date, which
// overrides that weekday's standard hours.
//
// Only the chat could set these (adjust_day_hours), so a conference Friday or a
// morning off had to be described in a sentence while you were looking straight
// at the day on the calendar.
//
// Three things this has to get right, all of them learned from the existing
// behaviour rather than assumed:
//
//   CLEARING IS A DELETE. A row saying the same as the default is not the same as
//   no row, because the default can change later. "Back to standard hours" has to
//   remove the override, not copy today's standard into it.
//
//   AN ALL-NULL ROW IS NOT A CLOSED DAY. resolveDayWindow treats an override with
//   no start, no end and no weekend opt-in as no override at all and falls back
//   to the weekday's hours — so the obvious guess at how to close a day did
//   nothing. Closing is the `closed` column (migration 0036).
//
//   A WEEKEND NEEDS THE OPT-IN. A day whose weekday is off in the standard hours
//   is not schedulable, and giving it a window only counts if allow_weekend comes
//   with it. Without the flag the row saves and the day stays empty, which reads
//   as the app ignoring you — so that's an error here, not a warning.

import { createClient } from "@/lib/supabase/client";

export interface DayHoursDraft {
  /** "closed" means nothing is scheduled that date at all. */
  mode: "hours" | "closed";
  /** "HH:MM" as an <input type="time"> gives them. */
  startText: string;
  endText: string;
  /** Only meaningful when the weekday itself is off by default. */
  allowWeekend: boolean;
}

const parse = (value: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

export const timeValue = (minutes: number | null | undefined): string =>
  minutes == null ? "" : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** `dayIsOffByDefault` rather than "is a weekend": the standard hours can switch
 * off any weekday, and the opt-in works for all of them. */
export function validateDayHours(draft: DayHoursDraft, dayIsOffByDefault: boolean): string[] {
  const errors: string[] = [];
  if (draft.mode === "closed") return errors;

  const start = parse(draft.startText);
  const end = parse(draft.endText);
  if (start == null) errors.push("Give a start time for this day, or mark it as nothing scheduled.");
  if (end == null) errors.push("Give an end time for this day, or mark it as nothing scheduled.");
  if (start != null && end != null && end <= start) errors.push("This day would end before it starts.");
  if (dayIsOffByDefault && !draft.allowWeekend) {
    errors.push("This weekday is off in your standard hours — tick “work this day anyway” or nothing will be scheduled.");
  }
  return errors;
}

export interface DayHoursRow {
  start_min: number | null;
  end_min: number | null;
  allow_weekend: boolean;
  closed: boolean;
}

/** The columns to write, or null when the draft doesn't validate. */
export function dayHoursRow(draft: DayHoursDraft, dayIsOffByDefault: boolean): DayHoursRow | null {
  if (validateDayHours(draft, dayIsOffByDefault).length) return null;
  if (draft.mode === "closed") {
    // The window is kept deliberately: re-opening the day restores the hours it
    // had rather than making you type them again.
    return {
      start_min: parse(draft.startText),
      end_min: parse(draft.endText),
      allow_weekend: draft.allowWeekend,
      closed: true,
    };
  }
  return {
    start_min: parse(draft.startText),
    end_min: parse(draft.endText),
    allow_weekend: draft.allowWeekend,
    closed: false,
  };
}

/** YYYY-MM-DD from local parts. Never toISOString — that converts local midnight
 * to UTC first, which lands a day early east of Greenwich and is how date-only
 * columns have gone wrong in this codebase before. */
export const dateKey = (parts: { year: number; month: number; day: number }): string =>
  `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;

export async function saveDayHours(date: string, row: DayHoursRow): Promise<string | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "You appear to be signed out — reload and try again.";
  const { error } = await supabase
    .from("day_overrides")
    .upsert({ user_id: user.id, override_date: date, ...row }, { onConflict: "user_id,override_date" });
  return error?.message ?? null;
}

/** Back to whatever the standard hours say for that weekday, now and in future. */
export async function clearDayHours(date: string): Promise<string | null> {
  const supabase = createClient();
  const { error } = await supabase.from("day_overrides").delete().eq("override_date", date);
  return error?.message ?? null;
}
