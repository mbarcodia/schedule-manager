// Routine notes: the arithmetic and the wording, in one place.
//
// Same split as routine-form.ts, for the same reason. A routine note can be
// written by saying it to the chat or by typing it into the routine's panel in
// Settings, and those are two code paths that must agree about what a window
// means and how it reads back — otherwise "next week" in the chat and "next
// week" in the panel quietly become different windows, and the user finds out
// when a reminder doesn't fire. Everything here is pure, so it can be checked
// without a browser or a database.

import { parseDateWindow } from "@/lib/assistant/nlp-dates";
import { localDateKey } from "@/lib/scheduling/time";
import type { Database } from "@/lib/supabase/database.types";

export type RoutineNoteRow = Database["public"]["Tables"]["routine_notes"]["Row"];

/** The window as two date keys, ready for the date columns. */
export interface NoteWindow {
  startsOn: string;
  endsOn: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A YYYY-MM-DD key as a civil Date at local midnight. Parsing it with
 * `new Date(key)` instead would read it as UTC and land on the previous day west
 * of Greenwich — the mirror of the trap localDateKey exists for. */
export function dateFromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const fmtDay = (key: string): string => {
  const d = dateFromKey(key);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

/** Is this note speaking today? The whole feature turns on this one comparison,
 * and it is a string compare on purpose: YYYY-MM-DD sorts lexically, so no Date
 * is constructed and no timezone can shift the boundary. */
export function isActiveOn(note: Pick<RoutineNoteRow, "starts_on" | "ends_on">, todayKey: string): boolean {
  return note.starts_on <= todayKey && todayKey <= note.ends_on;
}

/** Its window has closed. Distinct from being ticked off and from being deleted:
 * an expired note is still a live row, still visible in the routine's history,
 * and simply no longer surfaced. */
export function hasExpired(note: Pick<RoutineNoteRow, "ends_on">, todayKey: string): boolean {
  return note.ends_on < todayKey;
}

/** The window in the words someone would use for it.
 *
 * Relative where a relative phrase is unambiguous ("next week"), absolute
 * otherwise — because "next week" written on a Friday and read on a Monday means
 * two different things, and a stored note has to read correctly whenever it is
 * looked at. The absolute dates come along in brackets for exactly that reason:
 * they are what the row actually holds. */
export function describeWindow(
  note: Pick<RoutineNoteRow, "starts_on" | "ends_on">,
  today: Date = new Date(),
): string {
  const todayKey = localDateKey(today);
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const weekStart = (offset: number) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + offset * 7);
    return localDateKey(d);
  };
  const weekEnd = (offset: number) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + offset * 7 + 6);
    return localDateKey(d);
  };

  if (note.starts_on === note.ends_on) {
    if (note.starts_on === todayKey) return "today";
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    if (note.starts_on === localDateKey(tomorrow)) return "tomorrow";
    return fmtDay(note.starts_on);
  }
  // A note covering a whole Monday-to-Sunday week gets that week's name. A
  // this-week note starts today rather than on Monday (see parseDateWindow), so
  // its start is compared against today as well.
  if (note.ends_on === weekEnd(1) && note.starts_on === weekStart(1)) return `next week (${fmtDay(note.starts_on)}–${fmtDay(note.ends_on)})`;
  if (note.ends_on === weekEnd(0) && (note.starts_on === weekStart(0) || note.starts_on === todayKey))
    return `this week (through ${fmtDay(note.ends_on)})`;
  if (note.starts_on <= todayKey) return `through ${fmtDay(note.ends_on)}`;
  return `${fmtDay(note.starts_on)}–${fmtDay(note.ends_on)}`;
}

/** Turns a phrase like "next week" into the window to store. Null when nothing
 * parsed — the caller asks rather than assuming a default, since guessing wrong
 * means the note surfaces on days it wasn't meant for or never surfaces at all. */
export function windowFromText(text: string, today: Date): NoteWindow | null {
  const parsed = parseDateWindow(text, today);
  if (!parsed) return null;
  return { startsOn: localDateKey(parsed.start), endsOn: localDateKey(parsed.end) };
}

/** The window meaning "the week after the one we're in", which is what a bare
 * note with no stated window almost always means in practice. Kept here so the
 * chat and the panel's "next week" button produce the identical pair. */
export function nextWeekWindow(today: Date): NoteWindow {
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) + 7);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  return { startsOn: localDateKey(monday), endsOn: localDateKey(sunday) };
}

export interface NoteProblems {
  errors: string[];
  warnings: string[];
}

/** What's wrong with a note before it's written. Errors block the save;
 * warnings are things worth knowing that are nonetheless legal. */
export function validateNote(draft: { body: string; window: NoteWindow | null }, today: Date): NoteProblems {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!draft.body.trim()) errors.push("The note needs some text — it's what you'll be reminded of.");
  if (!draft.window) {
    errors.push("Say which days this is for — “next week”, “Tuesday”, “the next 3 weeks”.");
    return { errors, warnings };
  }
  const { startsOn, endsOn } = draft.window;
  if (endsOn < startsOn) errors.push("That window ends before it starts.");
  const todayKey = localDateKey(today);
  // Legal but pointless, and silence is the failure mode this feature is meant
  // to avoid — so it's said rather than left to be noticed.
  if (endsOn < todayKey) warnings.push("That window is already past, so this note will never come up.");
  const spanDays =
    Math.round((dateFromKey(endsOn).getTime() - dateFromKey(startsOn).getTime()) / 86400000) + 1;
  if (spanDays > 120)
    warnings.push(
      `That's ${spanDays} days — it'll come up in every session for months. Something that always applies belongs in the routine's title or a standing rule instead.`,
    );
  return { errors, warnings };
}

/** How a routine's live notes are given to the chat. Only the ones speaking
 * today: an expired note is not sent at all, which is both the behaviour asked
 * for and the reason this costs almost nothing per turn. */
export function activeNotesForPrompt(
  notes: RoutineNoteRow[],
  routineId: string,
  todayKey: string,
): string[] {
  return notes
    .filter((n) => n.routine_id === routineId && !n.done_at && isActiveOn(n, todayKey))
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on) || a.created_at.localeCompare(b.created_at))
    .map((n) => n.body);
}
