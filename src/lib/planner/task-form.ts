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
  /** How far the work may be spread — see migration 0042. Unlike chunkText this
   * is a CONSTRAINT: the engine leaves the work unplaced rather than break it. */
  splitMode: SplitMode;
  /** The shortest piece this task may be cut into. Empty falls back to the
   * label's minimum, then to the engine's 30-minute floor. Setting one
   * OVERRIDES the label in both directions, which is why the panels warn when
   * it does — see labelMinChunkClash. */
  minChunkText: string;
  /** Exact slots this task is held to (migration 0047). Empty = it floats and
   * the engine places it wherever the week allows, which is the normal case.
   *
   * A LIST because one slot per task was a real cap: work that has to happen as
   * four separate two-hour sittings needs four of them. Kept as typed text like
   * every other field here, and validated on save by pinSlotRows. */
  pins: PinSlotDraft[];
}

export interface PinSlotDraft {
  /** YYYY-MM-DD. */
  date: string;
  /** HH:MM, 24h — what <input type="time"> gives. */
  time: string;
  /** Minutes. Empty means "as long as one chunk of this task". */
  lengthText: string;
}

export const blankPinSlot = (): PinSlotDraft => ({ date: "", time: "", lengthText: "" });

/** The pin rows to write, or a sentence naming what is wrong with one.
 *
 * Returns [] for a draft with no slots, which is a complete answer meaning
 * "unpinned" — the caller still writes it, so clearing the last slot in the
 * panel actually releases the work. */
export function pinSlotRows(
  draft: TaskDraft,
  defaultLengthMin: number,
): { pinned_date: string; start_min: number; length_min: number }[] | string {
  const rows: { pinned_date: string; start_min: number; length_min: number }[] = [];
  for (const slot of draft.pins) {
    // A half-filled row is a mistake, not an instruction — say so rather than
    // dropping it, which would look like the panel ignored what was typed.
    if (!slot.date && !slot.time && !slot.lengthText) continue;
    if (!slot.date || !slot.time) return "Every fixed time needs both a date and a time.";
    const [h, m] = slot.time.split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return `Couldn't read the time "${slot.time}".`;
    const length = slot.lengthText.trim() ? Math.round(Number(slot.lengthText)) : defaultLengthMin;
    if (!Number.isFinite(length) || length <= 0) return `A fixed time needs a length in minutes.`;
    rows.push({ pinned_date: slot.date, start_min: h * 60 + m, length_min: length });
  }
  const sorted = [...rows].sort((a, b) => a.pinned_date.localeCompare(b.pinned_date) || a.start_min - b.start_min);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].pinned_date === sorted[i - 1].pinned_date && sorted[i].start_min < sorted[i - 1].start_min + sorted[i - 1].length_min) {
      return `Two fixed times overlap on ${sorted[i].pinned_date} — they have to be separate slots.`;
    }
  }
  return rows;
}

export type SplitMode = "free" | "one_day" | "one_block";

/** The three modes with the words the panels use, so both say the same thing. */
export const SPLIT_MODES: { id: SplitMode; label: string; hint: string }[] = [
  { id: "free", label: "Split it however it fits", hint: "the usual — pieces anywhere in its window" },
  { id: "one_day", label: "All on one day", hint: "may still be split, but not across days" },
  { id: "one_block", label: "All in one block", hint: "one unbroken sitting" },
];

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
  splitMode: "free",
  minChunkText: "",
  pins: [],
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
  positive(draft.minChunkText, "The smallest block");

  // The one combination that genuinely cannot be satisfied, as opposed to the
  // two below that merely resolve surprisingly: "one block" means the single
  // sitting is the whole task, so a daily cap shorter than the task forbids it
  // outright. The engine's answer would be to schedule nothing at all, silently
  // — so this one IS refused rather than described.
  const cap = Number(draft.maxPerDayText.trim());
  const durationMin = Math.round((Number(draft.hoursText.trim()) || 0) * 60);
  if (draft.splitMode === "one_block" && cap > 0 && durationMin > 0 && cap < durationMin) {
    errors.push(
      `It can't be one block of ${durationMin} minutes and also capped at ${cap} minutes a day — raise the cap, or let it split.`,
    );
  }
  if (draft.splitMode === "one_day" && cap > 0 && durationMin > 0 && cap < durationMin) {
    errors.push(
      `It can't all fall on one day and also be capped at ${cap} minutes a day — that's ${durationMin} minutes of work. Raise the cap, or let it spread across days.`,
    );
  }

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
  split_mode: SplitMode;
  min_chunk_min: number | null;
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
    split_mode: draft.splitMode,
    min_chunk_min: draft.minChunkText.trim() ? Math.round(Number(draft.minChunkText.trim())) : null,
  };
}

/** The task's own minimum against its label's, when the two differ.
 *
 * Returned so a panel can say it at the moment it is caused. The task's figure
 * WINS either way (migration 0042) — this is not a conflict being resolved, it
 * is an override being reported, and the wording has to make that clear or it
 * reads as a warning that something won't work.
 *
 * Null when there is no label, the label sets no minimum, the task sets none, or
 * the two agree. */
export function labelMinChunkClash(
  draft: TaskDraft,
  /** The chosen label, already looked up. Takes the label rather than the whole
   * list because the two panels hold theirs in different shapes — the board's
   * comes from the scheduling types, the to-do's straight off the table row. */
  label: { name: string; minChunkMin?: number | null } | null | undefined,
): { text: string; loosens: boolean } | null {
  const own = Number(draft.minChunkText.trim());
  if (!draft.minChunkText.trim() || !Number.isFinite(own) || own <= 0) return null;
  if (!label?.minChunkMin || label.minChunkMin === own) return null;
  const loosens = own < label.minChunkMin;
  return {
    loosens,
    text: loosens
      ? `${label.name} asks for at least ${label.minChunkMin} minutes a block. This task overrides that with ${own}, so it alone may be booked in shorter pieces.`
      : `${label.name} asks for at least ${label.minChunkMin} minutes a block. This task raises that to ${own}, so it alone gets longer pieces.`,
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

  // "One block" makes the preferred block length moot — the single sitting is
  // the whole task, whatever was typed. Said first, because leaving a 60 in the
  // block-length box next to "all in one block" otherwise looks like the two
  // are fighting and the smaller number might win.
  if (draft.splitMode === "one_block") {
    return chunk > 0 && durationMin > 0 && chunk !== durationMin
      ? `In one sitting, so the block length is ignored — it will be a single ${durationMin}-minute block.`
      : null;
  }

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
  split_mode?: SplitMode | null;
  min_chunk_min?: number | null;
  /** The task's pinned slots, already grouped by caller. Optional: a caller
   * that hasn't fetched them means "none known", not "unpinned" — which is why
   * the panel only writes pins when it actually loaded them. */
  pins?: { pinned_date: string; start_min: number; length_min: number }[];
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
    splitMode: row.split_mode ?? "free",
    minChunkText: row.min_chunk_min != null ? String(row.min_chunk_min) : "",
    pins: (row.pins ?? []).map((p) => ({
      date: p.pinned_date,
      time: `${pad(Math.floor(p.start_min / 60))}:${pad(p.start_min % 60)}`,
      lengthText: String(p.length_min),
    })),
  };
}
