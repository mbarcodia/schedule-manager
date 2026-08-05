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
    chunk_min: chunkFor(duration_min),
    priority: draft.priority,
    deadline_at,
    deadline_all_day,
    floor_at,
    project_id: draft.projectId || null,
    category_id: draft.categoryId || null,
    important: draft.important,
  };
}

/** An existing row back into a draft. */
export function taskDraft(row: {
  title: string;
  duration_min: number;
  priority: string;
  deadline_at: string | null;
  deadline_all_day: boolean;
  floor_at: string;
  project_id: string | null;
  category_id: string | null;
  important: boolean;
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
  };
}
