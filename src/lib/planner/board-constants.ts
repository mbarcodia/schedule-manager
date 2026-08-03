// Board methodology knobs — deliberately constants, not settings, for V1
// (sane defaults over configurability; a profiles column is a trivial
// follow-up migration if tuning turns out to matter).

/** Soft kanban WIP cap: the In Progress column warns past this, never blocks. */
export const DEFAULT_WIP_LIMIT = 3;

/** Eisenhower "urgent" = deadline within this many calendar days (today
 * inclusive). A task with no deadline is never urgent. */
export const URGENT_THRESHOLD_DAYS = 3;
