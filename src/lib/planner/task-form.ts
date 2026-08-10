// A standalone task: a piece of work with hours that get scheduled onto the
// calendar. Creating one was chat-only, and a task not attached to a to-do had no
// editor at all — so a typo in a title, or hours that turned out wrong, could only
// be fixed by describing the change in a sentence.
//
// Kept out of the component so the derived values are testable. Two of them are
// not obvious and both come from add_task, which this has to agree with or the
// same request would produce different rows depending on which path made it:
//
//   CHUNK LENGTH is derived, not asked for. add_task uses "60 minutes if the task
//   is longer than 90, otherwise the whole thing" — a 45-minute task in one sitting,
//   a 4-hour one in hour-long pieces. A label's minimum chunk overrides it later.
//
//   FLOOR_AT defaults to NOW, not to null. It is the earliest the scheduler may
//   place the work, the column is NOT NULL, and leaving it out of an insert would
//   be a constraint error rather than "no floor".

export const PRIORITIES = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface TaskDraft {
  title: string;
  hoursText: string;
  priority: Priority;
  /** YYYY-MM-DD, or empty. A deadline is a DAY unless a time was given. */
  deadlineDate: string;
  /** Empty keeps the deadline a date-only one, which is a complete answer. */
  deadlineTime: string;
  /** Earliest the scheduler may start it — "don't touch this before". */
  startDate: string;
  projectId: string;
  categoryId: string;
  important: boolean;
  /** A HARD half-of-day restriction: the engine refuses the other half even when
   * that means not fitting. Empty = unrestricted, which is not the same as
   * "anywhere" — a label's own time preference still applies underneath. */
  timeOfDay: "" | "morning" | "afternoon";
  /** "Spread it out": at most this many minutes of it on any one day. Empty =
   * no cap. Paired with the chunk floor in the engine, which takes the TIGHTER
   * of the two rather than making the pair unschedulable. */
  maxPerDayText: string;
  /** Overrides the derived chunk length. Empty keeps the derivation, which is
   * the right answer almost always and is why this is the last field. */
  chunkText: string;
}

export const blankTaskDraft = (): TaskDraft => ({
  title: "",
  hoursText: "1",
  priority: "medium",
  deadlineDate: "",
  deadlineTime: "",
  startDate: "",
  projectId: "",
  categoryId: "",
  important: false,
  timeOfDay: "",
  maxPerDayText: "",
  chunkText: "",
});

/** Same rule as add_task: an hour-long chunk for anything over 90 minutes, the
 * whole task in one sitting below that. */
export const chunkFor = (durationMin: number): number => (durationMin > 90 ? 60 : durationMin);

export function validateTask(draft: TaskDraft): string[] {
  const errors: string[] = [];
  if (!draft.title.trim()) errors.push("A task needs a name — it's what appears on the calendar block.");

  const hours = Number(draft.hoursText.trim());
  if (!draft.hoursText.trim() || !Number.isFinite(hours) || hours <= 0) {
    errors.push("How many hours of work is it? That's what gets booked on the calendar.");
  } else if (hours > 100) {
    errors.push("Over 100 hours is a commitment with weekly hours, not one task.");
  }

  if (draft.deadlineTime && !draft.deadlineDate) {
    errors.push("A time needs a date to go with it.");
  }
  if (draft.deadlineDate && draft.startDate && draft.startDate > draft.deadlineDate) {
    errors.push("It can't start after the day it's due.");
  }

  const positive = (text: string, name: string): number | null => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(`${name} has to be a number of minutes above zero — leave it empty for none.`);
      return null;
    }
    return Math.round(value);
  };
  positive(draft.maxPerDayText, "The daily cap");
  positive(draft.chunkText, "The block length");

  // NEITHER of the two obvious-looking conflicts is an error, and both were
  // refused here until the engine was read properly. A cap below the block
  // length shortens the blocks (chunkLengthsToTry walks down from the preferred
  // size, and maxPerDayMin is folded into the floor); a block longer than the
  // task is clamped to the task. Refusing them would have blocked saves the
  // scheduler handles correctly — describeChunking says what will happen instead.
  return errors;
}

export interface TaskRowFields {
  title: string;
  duration_min: number;
  chunk_min: number;
  priority: Priority;
  deadline_at: string | null;
  deadline_all_day: boolean;
  floor_at: string;
  project_id: string | null;
  category_id: string | null;
  important: boolean;
  time_of_day: "morning" | "afternoon" | null;
  max_per_day_min: number | null;
}

/** `now` is passed in rather than read here so the caller controls it and this
 * stays a pure function — the same reason the engine takes its own clock. */
export function taskRowFields(draft: TaskDraft, now: Date): TaskRowFields | null {
  if (validateTask(draft).length) return null;
  const duration_min = Math.round(Number(draft.hoursText.trim()) * 60);

  // A date-only deadline is stored at the END of that day: any time that day
  // counts as on time, and the hours may be scheduled up to the end of it.
  // Built from local parts — `new Date("2026-08-11")` is parsed as UTC midnight,
  // which is the previous evening in the Americas.
  let deadline_at: string | null = null;
  let deadline_all_day = false;
  if (draft.deadlineDate) {
    const [y, m, d] = draft.deadlineDate.split("-").map(Number);
    if (draft.deadlineTime) {
      const [hh, mm] = draft.deadlineTime.split(":").map(Number);
      deadline_at = new Date(y, m - 1, d, hh, mm).toISOString();
    } else {
      deadline_at = new Date(y, m - 1, d, 23, 59).toISOString();
      deadline_all_day = true;
    }
  }

  let floor_at = now.toISOString();
  if (draft.startDate) {
    const [y, m, d] = draft.startDate.split("-").map(Number);
    floor_at = new Date(y, m - 1, d, 0, 0).toISOString();
  }

  return {
    title: draft.title.trim(),
    duration_min,
    // An explicit block length wins over the derivation; empty keeps it.
    chunk_min: draft.chunkText.trim() ? Math.round(Number(draft.chunkText.trim())) : chunkFor(duration_min),
    priority: draft.priority,
    deadline_at,
    deadline_all_day,
    floor_at,
    project_id: draft.projectId || null,
    category_id: draft.categoryId || null,
    important: draft.important,
    time_of_day: draft.timeOfDay || null,
    max_per_day_min: draft.maxPerDayText.trim() ? Math.round(Number(draft.maxPerDayText.trim())) : null,
  };
}

/** What the scheduler will actually do with the block length and the daily cap,
 * for a panel that would otherwise leave the user to discover it. Null when
 * there is nothing surprising to say.
 *
 * Neither combination is refused (see validateTask): the engine resolves both,
 * and this is the resolution stated out loud. */
export function describeChunking(draft: TaskDraft): string | null {
  const durationMin = Math.round((Number(draft.hoursText.trim()) || 0) * 60);
  const chunk = Number(draft.chunkText.trim()) || 0;
  const cap = Number(draft.maxPerDayText.trim()) || 0;
  if (chunk > 0 && durationMin > 0 && chunk > durationMin) {
    // The cap still applies to the clamped block, so saying only "one block"
    // would be wrong in the very case both fields are set.
    const clamped = cap > 0 && cap < durationMin ? cap : durationMin;
    return clamped < durationMin
      ? `That's longer than the whole task, so it's clamped to ${durationMin} minutes — and the daily cap cuts it further, to ${clamped} minutes a day.`
      : `That's longer than the whole task, so it will simply be booked in one ${durationMin}-minute block.`;
  }
  if (cap > 0 && chunk > 0 && cap < chunk) {
    return `The daily cap is shorter than the block, so blocks will be cut to ${cap} minutes — one a day.`;
  }
  if (cap > 0 && chunk === 0 && durationMin > 0 && cap < chunkFor(durationMin)) {
    return `Shorter than this task's ${chunkFor(durationMin)}-minute default block, so blocks will be cut to ${cap} minutes.`;
  }
  return null;
}

/** An existing row back into a draft. */
export function taskDraft(row: {
  title: string;
  duration_min: number;
  chunk_min?: number;
  priority: string;
  deadline_at: string | null;
  deadline_all_day: boolean;
  floor_at: string;
  project_id: string | null;
  category_id: string | null;
  important: boolean;
  time_of_day?: "morning" | "afternoon" | null;
  max_per_day_min?: number | null;
}): TaskDraft {
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateOf = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const timeOf = (iso: string) => {
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // A floor at or before now is the default one add_task writes, not a decision —
  // showing it as "don't start before" would put a date in front of the user that
  // they never chose.
  const floor = new Date(row.floor_at);
  const isRealFloor = floor.getTime() > Date.now() + 60_000;

  return {
    title: row.title,
    hoursText: String(+(row.duration_min / 60).toFixed(2)),
    priority: (PRIORITIES as readonly string[]).includes(row.priority) ? (row.priority as Priority) : "medium",
    deadlineDate: row.deadline_at ? dateOf(row.deadline_at) : "",
    deadlineTime: row.deadline_at && !row.deadline_all_day ? timeOf(row.deadline_at) : "",
    startDate: isRealFloor ? dateOf(row.floor_at) : "",
    projectId: row.project_id ?? "",
    categoryId: row.category_id ?? "",
    important: row.important,
    timeOfDay: row.time_of_day ?? "",
    maxPerDayText: row.max_per_day_min != null ? String(row.max_per_day_min) : "",
    // Shown only when it ISN'T the derived value: a number the user never chose,
    // presented as theirs, is the same mistake as showing a floor_at default as
    // "don't start before".
    chunkText:
      row.chunk_min != null && row.chunk_min !== chunkFor(row.duration_min) ? String(row.chunk_min) : "",
  };
}
