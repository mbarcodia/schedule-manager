// Natural-language date/time parsing for the assistant's tools — ported from
// the prototype's parseDeadlineDate/parseTimeStr (Schedule Manager.dc.html
// ~465-492, 1092-1100).

const WEEKDAY_MAP: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
const MONTH_ALIASES: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function weekdayFromText(lower: string): number | null {
  for (const k in WEEKDAY_MAP) {
    if (lower.includes(k)) return WEEKDAY_MAP[k];
  }
  return null;
}

/** Parses a natural-language deadline phrase relative to `today` (a plain
 * civil date, no time component) into a real Date. Mirrors the prototype's
 * parseDeadlineDate exactly, including "end of month" being pre-substituted
 * by the caller to "in 3 weeks". */
export function parseDeadlineDate(rawLower: string, today: Date): Date | null {
  const lower = rawLower.replace(/end of (the )?month/, "in 3 weeks");

  // ISO (YYYY-MM-DD) — unambiguous, so check it before any other pattern.
  // Tool-calling models reach for this format naturally; without it, a
  // deadline like "2026-08-07" silently failed to parse and the task got
  // placed with no deadline at all rather than erroring.
  const iso = lower.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const year = parseInt(iso[1], 10);
    const month = parseInt(iso[2], 10) - 1;
    const day = parseInt(iso[3], 10);
    return new Date(year, month, day);
  }

  const inMatch = lower.match(/in\s+(\d+)\s*(day|days|week|weeks)/);
  if (inMatch) {
    const n = parseInt(inMatch[1], 10);
    const mult = inMatch[2].startsWith("week") ? 7 : 1;
    const d = new Date(today);
    d.setDate(d.getDate() + n * mult);
    return d;
  }
  if (lower.includes("tomorrow")) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return d;
  }
  // "tonight" is still today's date — only the time-of-day differs, which
  // is a separate (time) parse, not this (date) one.
  if (lower.includes("today") || lower.includes("tonight")) return new Date(today);

  const mm = lower.match(
    /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/,
  );
  if (mm) {
    const month = MONTH_ALIASES[mm[1]];
    const day = parseInt(mm[2], 10);
    let d = new Date(today.getFullYear(), month, day);
    if (d < today) d = new Date(today.getFullYear() + 1, month, day);
    return d;
  }

  const wd = weekdayFromText(lower);
  if (wd != null) {
    const jsTarget = (wd + 1) % 7; // our Mon=0..Sun=6 -> JS Sun=0..Sat=6
    let diff = (jsTarget - today.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    // "next friday" always means the following week's occurrence, never this
    // week's — without this, "next friday" and "friday" resolve identically.
    const explicitlyNext = new RegExp(`next\\s+${Object.keys(WEEKDAY_MAP).find((k) => WEEKDAY_MAP[k] === wd)}`).test(lower);
    if (explicitlyNext && diff < 7) diff += 7;
    const d = new Date(today);
    d.setDate(d.getDate() + diff);
    return d;
  }

  return null;
}

/** Parses "2pm", "14:30", "9:00", "noon", "midnight" into minutes-since-midnight. */
export function parseTimeStr(s: string | null | undefined): number | null {
  if (s == null) return null;
  const lower = String(s).toLowerCase().trim();
  if (/^(noon|midday)$/.test(lower)) return 720;
  if (lower === "midnight") return 0;
  const m = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mi = m[2] ? parseInt(m[2], 10) : 0;
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  return h * 60 + mi;
}

/** Finds an explicit clock time inside a longer phrase — "due by 2pm on Nov 10",
 * "november 10 at 14:30". Deliberately stricter than parseTimeStr: a bare
 * number is NOT treated as a time, because "november 10" would otherwise parse
 * as 10 o'clock and silently move the deadline. */
export function parseTimeInText(text: string | null | undefined): number | null {
  if (text == null) return null;
  const lower = String(text).toLowerCase();
  if (/\b(noon|midday)\b/.test(lower)) return 720;
  if (/\bmidnight\b/.test(lower)) return 0;

  const meridiem = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (meridiem) {
    let h = parseInt(meridiem[1], 10);
    const mi = meridiem[2] ? parseInt(meridiem[2], 10) : 0;
    if (h > 12) return null;
    if (meridiem[3] === "pm" && h < 12) h += 12;
    if (meridiem[3] === "am" && h === 12) h = 0;
    return h * 60 + mi;
  }

  // 24-hour "14:30" — the colon is what makes it unambiguous.
  const explicit = lower.match(/\b(\d{1,2}):(\d{2})\b/);
  if (explicit) {
    const h = parseInt(explicit[1], 10);
    const mi = parseInt(explicit[2], 10);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }
  return null;
}

/** A stretch of days, as the user said it — the range form of
 * parseDeadlineDate, for things that are about a period rather than a moment.
 *
 * Exists because "next week" is the single most likely way to scope a routine
 * note (migration 0044) and parseDeadlineDate cannot express it: that function
 * returns one date, and a routine running Monday and Wednesday has two
 * occurrences in the week being talked about. Asking which one would be asking
 * the user to be more precise than they were.
 *
 * A WEEK RUNS MONDAY TO SUNDAY here, matching the gday grid the whole app is
 * built on (startOfWeekMonday), so "next week" means the same seven days the
 * calendar shows as next week.
 *
 * Anything this doesn't recognise as a range falls through to a single date via
 * parseDeadlineDate, which makes "next Tuesday" and "August 17" work with no
 * extra vocabulary. Returns null only when nothing at all parsed — the caller
 * turns that into a question rather than guessing a window. */
export function parseDateWindow(
  rawLower: string,
  today: Date,
): { start: Date; end: Date } | null {
  const lower = rawLower.toLowerCase().trim();
  const civil = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const plus = (d: Date, days: number) => {
    const out = civil(d);
    out.setDate(out.getDate() + days);
    return out;
  };
  // Monday of the week `d` falls in. Duplicated from scheduling/time.ts rather
  // than imported: this module is the assistant's pure text layer and has no
  // scheduling imports, and the expression is three lines.
  const monday = (d: Date) => plus(d, -((d.getDay() + 6) % 7));

  // "for the rest of this week" and "this week" are the same window: the point
  // of a window is the days still to come, so it starts today either way rather
  // than at a Monday already past.
  if (/\b(this|current)\s+week\b/.test(lower) || /\brest\s+of\s+(the\s+|this\s+)?week\b/.test(lower)) {
    return { start: civil(today), end: plus(monday(today), 6) };
  }
  if (/\b(next|coming|following)\s+week\b/.test(lower)) {
    const start = plus(monday(today), 7);
    return { start, end: plus(start, 6) };
  }
  // "the week of the 17th" / "week of Aug 17" — anchored on whatever date the
  // inner phrase resolves to, then widened to that whole week.
  const weekOf = lower.match(/\bweek\s+(?:of|beginning|starting|commencing)\s+(.+)$/);
  if (weekOf) {
    const anchor = parseDeadlineDate(weekOf[1].trim(), today);
    if (anchor) return { start: monday(anchor), end: plus(monday(anchor), 6) };
  }
  // "for the next 3 weeks" / "the next 2 days" — from today, inclusive, so
  // "the next 2 weeks" is 14 days and not 15.
  const nextN = lower.match(/\b(?:the\s+)?next\s+(\d+)\s*(day|days|week|weeks)\b/);
  if (nextN) {
    const n = parseInt(nextN[1], 10);
    const span = nextN[2].startsWith("week") ? n * 7 : n;
    if (n > 0) return { start: civil(today), end: plus(today, span - 1) };
  }
  if (/\bnext\s+month\b/.test(lower)) {
    const start = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    return { start, end: new Date(today.getFullYear(), today.getMonth() + 2, 0) };
  }
  if (/\b(this|the\s+rest\s+of\s+(the|this))\s+month\b/.test(lower) || /\brest\s+of\s+the\s+month\b/.test(lower)) {
    return { start: civil(today), end: new Date(today.getFullYear(), today.getMonth() + 1, 0) };
  }

  // Not a range phrase: one day, which is a legitimate window of length 1.
  const single = parseDeadlineDate(lower, today);
  return single ? { start: civil(single), end: civil(single) } : null;
}

/** Matches phrases meaning "start this immediately" — "now", "right now",
 * "immediately", "asap", "right away", "straight away". */
export function isNowPhrase(s: string | null | undefined): boolean {
  if (s == null) return false;
  return /^(right\s+now|now|immediately|asap|right\s+away|straight\s+away)$/.test(s.toLowerCase().trim());
}

/** Parses "in 30 minutes", "in 2 hours", "in an hour", "in half an hour",
 * "in 1 hour 30 minutes" into a minute offset from now. Returns null if the
 * phrase isn't a relative-time one at all (as opposed to 0, a valid offset). */
export function parseRelativeMinutes(s: string | null | undefined): number | null {
  if (s == null) return null;
  const lower = s.toLowerCase().trim();
  if (/^in\s+(half\s+an\s+hour|a\s+half\s*-?\s*hour)$/.test(lower)) return 30;
  if (/^in\s+an?\s+hour$/.test(lower)) return 60;
  const m = lower.match(/^in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(?:and\s+)?(\d+)\s*m(?:in(?:ute)?s?)?)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  return hours * 60 + minutes;
}

export function normTitle(s: string): string {
  return (s || "").toLowerCase().trim().replace(/\s+/g, " ");
}

export interface TitleMatch<T> {
  match: T | null;
  /** Populated only when multiple candidates tie for the best score and
   * neither is an outright exact match — the caller should ask which one
   * was meant instead of silently picking one. */
  ambiguous: T[];
}

const FUZZY_THRESHOLD = 0.35;

/** Title resolution with disambiguation, replacing the old first-match
 * heuristic (which returned whichever list item happened to come first,
 * with no score and no exact-match priority — the root cause of a class of
 * misrouting bugs where a query for one record's exact title resolved to a
 * different, unrelated record).
 *
 * An exact (normalized) title always wins outright, and multiple exact
 * matches (duplicate titles) are themselves ambiguous rather than picking
 * the first. Otherwise, candidates are scored — substring containment
 * beats partial word overlap — and must clear a minimum threshold; ties
 * for the top score are also reported as ambiguous rather than guessed. */
export function findByTitle<T extends { title: string }>(list: T[], needle: string): TitleMatch<T> {
  const n = normTitle(needle);
  if (!n) return { match: null, ambiguous: [] };

  const exact = list.filter((t) => normTitle(t.title) === n);
  if (exact.length === 1) return { match: exact[0], ambiguous: [] };
  if (exact.length > 1) return { match: null, ambiguous: exact };

  const needleWords = n.split(" ").filter((w) => w.length > 3);
  const scored = list
    .map((item) => {
      const title = normTitle(item.title);
      let score = 0;
      if (title.includes(n) || n.includes(title)) {
        score = 0.5 + 0.3 * (Math.min(title.length, n.length) / Math.max(title.length, n.length));
      } else if (needleWords.length) {
        const titleWords = title.split(" ");
        const overlap = needleWords.filter((w) => titleWords.includes(w));
        if (overlap.length) score = 0.35 * (overlap.length / needleWords.length);
      }
      return { item, score };
    })
    .filter((s) => s.score >= FUZZY_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { match: null, ambiguous: [] };
  const top = scored[0].score;
  const tied = scored.filter((s) => s.score >= top - 1e-9);
  if (tied.length > 1) return { match: null, ambiguous: tied.map((s) => s.item) };
  return { match: scored[0].item, ambiguous: [] };
}

/** Convenience wrapper for lower-stakes lookups (recurring rules,
 * preference notes) that don't need disambiguation UX — ties or
 * below-threshold matches both resolve to null rather than guessing. */
export function fuzzyFindByTitle<T extends { title: string }>(list: T[], needle: string): T | null {
  return findByTitle(list, needle).match;
}
