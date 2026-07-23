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
