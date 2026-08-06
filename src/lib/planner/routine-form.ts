// Routines: the standing weekly slots — email time, lunch, a lit scan. Until now
// they could only be created or changed by asking the chat (update_recurring),
// which meant five rows shaping every week with nothing on screen to show them.
//
// Kept out of the component for the same reason commitment-form.ts is: the edges
// here are arithmetic (does the length fit the window, which days does the engine
// actually honour) and they should be testable without a browser.
//
// THE ENGINE ONLY PLACES MON–FRI. anchorDefs does `if (d < 0 || d > 4) return`,
// so a Saturday routine would be stored, displayed, and silently never appear.
// The form offers weekdays only rather than a control that does nothing.

export const ROUTINE_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

/** How the slot is pinned down. All three are the same two columns underneath —
 * this is the shape a person means, mapped onto them:
 *
 *   anywhere  both null            wherever it fits in the working day
 *   fixed     start, end=start+len at a set time
 *   window    start, end>start+len somewhere inside a window
 */
export type RoutinePlacement = "anywhere" | "fixed" | "window";

export interface RoutineDraft {
  /** Absent while being added. */
  id?: string;
  title: string;
  /** 0=Mon .. 4=Fri. */
  days: number[];
  lengthText: string;
  placement: RoutinePlacement;
  /** "HH:MM" as an <input type="time"> gives it. */
  startText: string;
  endText: string;
  /** Optional label. Empty string = none, which is right for most routines —
   * a standing email slot belongs to no share. A labelled one counts toward
   * that label's weekly percentage and reduces what its commitments are asked
   * for, which is what makes a weekly literature scan count as research. */
  categoryId: string;
}

/** "13:00" -> 780. Null for empty or malformed. */
export function parseTimeOfDay(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export const timeOfDayValue = (minutes: number | null | undefined): string =>
  minutes == null ? "" : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const clock = (minutes: number): string => {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour < 12 ? "am" : "pm";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${h12}${suffix}` : `${h12}:${String(minute).padStart(2, "0")}${suffix}`;
};

/** Consecutive weekdays read as a range, anything else as a list. "Mon–Fri" is
 * how a person says the common case, and five separate chips is not. */
export function describeDays(days: number[]): string {
  const sorted = [...new Set(days)].filter((d) => d >= 0 && d <= 4).sort((a, b) => a - b);
  if (!sorted.length) return "no days";
  if (sorted.length === 5) return "Mon–Fri";
  const consecutive = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (consecutive && sorted.length > 2) return `${ROUTINE_DAYS[sorted[0]]}–${ROUTINE_DAYS[sorted[sorted.length - 1]]}`;
  return sorted.map((d) => ROUTINE_DAYS[d]).join(", ");
}

/** One line for the list, saying what actually happens rather than naming
 * columns. Shared with the sanity check so the phrasing is pinned down. */
export function describeRoutine(row: {
  days: number[];
  length_min: number;
  win_start_min: number | null;
  win_end_min: number | null;
}): string {
  const length = row.length_min % 60 === 0 ? `${row.length_min / 60}h` : `${row.length_min}m`;
  const when =
    row.win_start_min == null
      ? "wherever it fits"
      : row.win_end_min != null && row.win_end_min - row.win_start_min > row.length_min
        ? `between ${clock(row.win_start_min)} and ${clock(row.win_end_min)}`
        : `at ${clock(row.win_start_min)}`;
  return `${length} · ${describeDays(row.days)} · ${when}`;
}

export interface RoutineProblems {
  errors: string[];
  warnings: string[];
}

export function validateRoutine(draft: RoutineDraft): RoutineProblems {
  const errors: string[] = [];
  const warnings: string[] = [];
  const where = draft.title.trim() ? `“${draft.title.trim()}”` : "this routine";

  if (!draft.title.trim()) errors.push("A routine needs a name — it's what appears on the calendar block.");
  if (!draft.days.length) errors.push(`${where} happens on no days, so it would never appear.`);

  const length = Number(draft.lengthText.trim());
  if (!draft.lengthText.trim() || !Number.isFinite(length) || length <= 0) {
    errors.push(`${where} needs a length in minutes.`);
  } else if (length > 1440) {
    errors.push(`${where} is longer than a day.`);
  }

  if (draft.placement !== "anywhere") {
    const start = parseTimeOfDay(draft.startText);
    if (start == null) {
      errors.push(`${where} needs a start time, or set it to go wherever it fits.`);
    } else if (draft.placement === "window") {
      const end = parseTimeOfDay(draft.endText);
      if (end == null) errors.push(`${where} needs the end of its window.`);
      else if (end <= start) errors.push(`${where} ends before it starts.`);
      else if (Number.isFinite(length) && length > 0 && end - start < length) {
        errors.push(
          `${where} is ${length} minutes long but its window is only ${end - start} — widen the window or shorten it.`,
        );
      }
    } else if (Number.isFinite(length) && length > 0 && start + length > 1440) {
      warnings.push(`${where} would run past midnight, so it will be dropped for want of room in the day.`);
    }
  }

  return { errors, warnings };
}

/** The columns to write. Returns null when the draft doesn't validate, so a
 * caller can't half-write one. `tag` is deliberately not set here: it defaults to
 * "anchor" and carries no meaning since labels absorbed the block names. */
export function routineRow(draft: RoutineDraft): {
  title: string;
  days: number[];
  length_min: number;
  win_start_min: number | null;
  win_end_min: number | null;
  category_id: string | null;
} | null {
  if (validateRoutine(draft).errors.length) return null;
  const length_min = Math.round(Number(draft.lengthText.trim()));
  const category_id = draft.categoryId || null;
  if (draft.placement === "anywhere") {
    return {
      title: draft.title.trim(),
      days: [...draft.days].sort(),
      length_min,
      win_start_min: null,
      win_end_min: null,
      category_id,
    };
  }
  const start = parseTimeOfDay(draft.startText)!;
  // A fixed time is stored as a window exactly one length wide — the same thing
  // update_recurring does, so the two paths produce identical rows.
  const end = draft.placement === "window" ? parseTimeOfDay(draft.endText)! : start + length_min;
  return {
    title: draft.title.trim(),
    days: [...draft.days].sort(),
    length_min,
    win_start_min: start,
    win_end_min: end,
    category_id,
  };
}

/** Existing row back into a draft, inferring which of the three shapes it is. */
export function routineDraft(row: {
  id: string;
  title: string;
  days: number[];
  length_min: number;
  win_start_min: number | null;
  win_end_min: number | null;
  category_id?: string | null;
}): RoutineDraft {
  const placement: RoutinePlacement =
    row.win_start_min == null
      ? "anywhere"
      : row.win_end_min != null && row.win_end_min - row.win_start_min > row.length_min
        ? "window"
        : "fixed";
  return {
    id: row.id,
    title: row.title,
    days: [...row.days].filter((d) => d >= 0 && d <= 4).sort(),
    lengthText: String(row.length_min),
    placement,
    startText: timeOfDayValue(row.win_start_min),
    endText: timeOfDayValue(row.win_end_min),
    categoryId: row.category_id ?? "",
  };
}
