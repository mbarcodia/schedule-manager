// Timezone-aware time helpers. The prototype assumed the browser's local
// timezone throughout (a known gap called out in the handoff README); this
// version takes an explicit IANA timezone (stored per-account) so the engine
// gives the same answer on the server (Node, UTC) and in the browser
// regardless of either machine's local timezone.
//
// Day/week arithmetic is done on plain civil-date {year, month, day} triples
// via Date.UTC — never by subtracting real Date instants — so it isn't
// thrown off by DST transitions inside the scheduling horizon.

const WEEKDAY_TO_IDX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

export interface ZonedNow {
  /** 0=Mon..6=Sun */
  weekdayIdx: number;
  minuteOfDay: number;
  year: number;
  month: number; // 1-12
  day: number;
}

export function zonedNow(timeZone: string, at: Date = new Date()): ZonedNow {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(at)) parts[p.type] = p.value;
  return {
    weekdayIdx: WEEKDAY_TO_IDX[parts.weekday],
    minuteOfDay: parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10),
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
  };
}

/** Absolute minute of "now" within the schedule grid (gday 0 = Monday of the
 * current week, at minute 0). */
export function nowAbsMinute(timeZone: string, at: Date = new Date()): number {
  const now = zonedNow(timeZone, at);
  return now.weekdayIdx * 1440 + now.minuteOfDay;
}

/** Civil-date day count from this week's Monday to an arbitrary calendar
 * date, computed via UTC-normalized date-only arithmetic (DST-safe). */
export function gdayForDate(
  timeZone: string,
  target: { year: number; month: number; day: number },
  at: Date = new Date(),
): number {
  const now = zonedNow(timeZone, at);
  const mondayUtcMs =
    Date.UTC(now.year, now.month - 1, now.day) - now.weekdayIdx * 86400000;
  const targetUtcMs = Date.UTC(target.year, target.month - 1, target.day);
  return Math.round((targetUtcMs - mondayUtcMs) / 86400000);
}

/** Inverse of gdayForDate: the real civil date a grid day falls on. */
export function dateForGday(
  timeZone: string,
  gday: number,
  at: Date = new Date(),
): { year: number; month: number; day: number } {
  const now = zonedNow(timeZone, at);
  const mondayUtcMs =
    Date.UTC(now.year, now.month - 1, now.day) - now.weekdayIdx * 86400000;
  const targetUtcMs = mondayUtcMs + gday * 86400000;
  const d = new Date(targetUtcMs);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Inverse of zonedNow: given a civil date + wall-clock time in a specific
 * IANA timezone, returns the real UTC instant. Standard offset-correction
 * technique (one correction pass — accurate except in rare DST-transition
 * edge cases, an acceptable simplification here). */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(guess)) parts[p.type] = p.value;
  const asIfUtc = Date.UTC(
    parseInt(parts.year, 10),
    parseInt(parts.month, 10) - 1,
    parseInt(parts.day, 10),
    parseInt(parts.hour, 10),
    parseInt(parts.minute, 10),
    parseInt(parts.second, 10),
  );
  const diff = asIfUtc - guess.getTime();
  return new Date(guess.getTime() - diff);
}

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function minToLabel(m: number): string {
  const h = Math.floor(m / 60);
  const mi = m % 60;
  const ap = h >= 12 ? "PM" : "AM";
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}${mi ? ":" + String(mi).padStart(2, "0") : ""}${ap}`;
}

export function fmtMin(m: number): string {
  if (m % 60 === 0) return `${m / 60}h`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}
