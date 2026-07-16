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
  if (lower.includes("today")) return new Date(today);

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

/** Parses "2pm", "14:30", "9:00" into minutes-since-midnight. */
export function parseTimeStr(s: string | null | undefined): number | null {
  if (s == null) return null;
  const m = String(s).toLowerCase().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mi = m[2] ? parseInt(m[2], 10) : 0;
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  return h * 60 + mi;
}

/** Fuzzy title match — same heuristic as the prototype's findByTitleIn:
 * substring match either direction, or a >3-char word overlap. */
export function fuzzyFindByTitle<T extends { title: string }>(list: T[], needle: string): T | null {
  const n = (needle || "").toLowerCase().trim();
  if (!n) return null;
  return (
    list.find((t) => {
      const title = t.title.toLowerCase();
      if (title.includes(n) || n.includes(title)) return true;
      return n.split(" ").some((w) => w.length > 3 && title.includes(w));
    }) ?? null
  );
}
