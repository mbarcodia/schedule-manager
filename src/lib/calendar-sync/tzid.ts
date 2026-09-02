// Pinning an ICS feed's timezones to real IANA zones BEFORE the parser sees
// them — the single place that decides what wall-clock time in a feed means.
//
// THE BUG THIS EXISTS TO MAKE IMPOSSIBLE
//
// Outlook's "Publish a calendar" feed labels its times with a TZID that is not
// an IANA zone and not even a Windows zone name:
//
//     BEGIN:VTIMEZONE
//     TZID:Customized Time Zone          <- means nothing to any zone database
//     BEGIN:STANDARD
//     TZOFFSETFROM:-0400
//     TZOFFSETTO:-0500                   <- ...but the RULES are right here
//     RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11
//
// Handed a TZID it cannot map, node-ical does this (ical.js, ~line 241):
//
//     tz = moment.tz.guess();   // "Set it to the local timezone, we can't tell"
//
// `moment.tz.guess()` is the SERVER's timezone. So a 12:30pm meeting was read
// as 12:30 UTC on Vercel and stored as 8:30am Eastern — every Outlook meeting
// four hours early, and a booking link happily offering slots on top of real
// meetings. It never showed up in development because a laptop in Miami makes
// that same fallback accidentally correct.
//
// THE FIX
//
// A feed's own VTIMEZONE block carries the offsets and transition rules, so the
// answer is in the file — the parser just wasn't reading it. This module reads
// it, finds a real IANA zone that reproduces those rules exactly, and rewrites
// the TZIDs in the text so the parser only ever sees zones it can resolve.
//
// The load-bearing property is not "Outlook works now", it is: **no time in any
// feed is ever interpreted in the server's timezone.** Resolution degrades
// name -> feed's own rules -> Windows name table -> the ACCOUNT's zone, and the
// process timezone appears nowhere in that list. assertZonesArePinned() then
// re-checks the rewritten text and throws rather than let anything slip past.

import { createRequire } from "node:module";

/** How a TZID's zone was decided — surfaced to the owner, since a guess should
 * never be invisible. */
export type TzidResolutionKind =
  /** The TZID was already a real IANA zone. */
  | "iana"
  /** Derived from the feed's own VTIMEZONE offsets and transition rules. */
  | "derived"
  /** A Windows zone name ("Pacific Standard Time"), mapped via CLDR. */
  | "windows"
  /** Nothing in the feed said what the zone was; the account's zone was used. */
  | "account-fallback";

export interface TzidResolution {
  tzid: string;
  zone: string;
  kind: TzidResolutionKind;
  /** Set when the resolution is a guess, or when the feed contradicts itself. */
  warning?: string;
}

/** One STANDARD or DAYLIGHT arm of a VTIMEZONE. */
interface TzArm {
  /** Minutes east of UTC in force AFTER this transition (TZOFFSETTO). */
  offsetMin: number;
  /** Minutes east of UTC in force BEFORE it — the offset DTSTART is written in. */
  fromOffsetMin: number;
  /** Wall-clock date/time of the transition, per DTSTART. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** Yearly recurrence, when the arm has one. Absent = a fixed-offset zone. */
  recurs?: { month: number; weekday: number; nth: number } | { month: number; monthDay: number };
}

interface VtimezoneDef {
  tzid: string;
  arms: TzArm[];
}

/** "-0430" -> -270. */
function parseUtcOffset(text: string): number | null {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(text.trim());
  if (!m) return null;
  const mins = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
  return m[1] === "-" ? -mins : mins;
}

const RRULE_DAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** RFC 5545 folds long content lines and continues them with a leading space or
 * tab. Everything here matches on whole property lines, so unfold first —
 * otherwise a folded `DTSTART;TZID=...` is two lines and matches neither. The
 * unfolded text is what gets handed to the parser; nothing re-folds it, because
 * it is never written anywhere, only parsed. */
export function unfoldIcs(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}

/** Reads every VTIMEZONE block into offsets + transition rules. */
export function parseVtimezones(unfolded: string): Map<string, VtimezoneDef> {
  const out = new Map<string, VtimezoneDef>();
  for (const block of unfolded.split("BEGIN:VTIMEZONE").slice(1)) {
    const body = block.split("END:VTIMEZONE")[0];
    const tzid = /^TZID:(.*)$/m.exec(body)?.[1]?.trim();
    if (!tzid) continue;

    const arms: TzArm[] = [];
    // split() keeps the capture group, so parts alternate [kind, body, kind, body...]
    const parts = body.split(/BEGIN:(STANDARD|DAYLIGHT)/).slice(1);
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const armBody = parts[i + 1].split(/END:(?:STANDARD|DAYLIGHT)/)[0];
      const to = parseUtcOffset(/^TZOFFSETTO:(.*)$/m.exec(armBody)?.[1] ?? "");
      const from = parseUtcOffset(/^TZOFFSETFROM:(.*)$/m.exec(armBody)?.[1] ?? "");
      const dtstart = /^DTSTART:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/m.exec(armBody);
      if (to == null || from == null || !dtstart) continue;

      const arm: TzArm = {
        offsetMin: to,
        fromOffsetMin: from,
        month: parseInt(dtstart[2], 10),
        day: parseInt(dtstart[3], 10),
        hour: parseInt(dtstart[4], 10),
        minute: parseInt(dtstart[5], 10),
      };

      const rrule = /^RRULE:(.*)$/m.exec(armBody)?.[1] ?? "";
      if (rrule) {
        const params = Object.fromEntries(
          rrule.split(";").map((p) => {
            const eq = p.indexOf("=");
            return [p.slice(0, eq).toUpperCase(), p.slice(eq + 1)];
          }),
        );
        const month = parseInt(params.BYMONTH ?? "", 10);
        const byDay = /^(-?\d)?([A-Z]{2})$/.exec((params.BYDAY ?? "").split(",")[0] ?? "");
        const byMonthDay = parseInt(params.BYMONTHDAY ?? "", 10);
        if (month && byDay && RRULE_DAYS[byDay[2]] !== undefined) {
          arm.recurs = { month, weekday: RRULE_DAYS[byDay[2]], nth: byDay[1] ? parseInt(byDay[1], 10) : 1 };
        } else if (month && byMonthDay) {
          arm.recurs = { month, monthDay: byMonthDay };
        }
      }
      arms.push(arm);
    }
    if (arms.length > 0) out.set(tzid, { tzid, arms });
  }
  return out;
}

/** The `nth` weekday of a month as a UTC calendar date; nth < 0 counts back
 * from the end, which is how "last Sunday in October" is written. */
function nthWeekdayUtc(year: number, month: number, nth: number, weekday: number): Date {
  if (nth > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1));
    const delta = (weekday - first.getUTCDay() + 7) % 7;
    return new Date(Date.UTC(year, month - 1, 1 + delta + (nth - 1) * 7));
  }
  const last = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last of this
  const delta = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month - 1, last.getUTCDate() - delta - (-nth - 1) * 7));
}

/** The instant an arm's transition happens in a given year. DTSTART inside a
 * VTIMEZONE is wall-clock in the offset being LEFT (TZOFFSETFROM), which is
 * what makes this subtraction the right one. */
function transitionUtcMs(arm: TzArm, year: number): number {
  let month = arm.month;
  let day = arm.day;
  if (arm.recurs) {
    month = arm.recurs.month;
    day =
      "monthDay" in arm.recurs
        ? arm.recurs.monthDay
        : nthWeekdayUtc(year, arm.recurs.month, arm.recurs.nth, arm.recurs.weekday).getUTCDate();
  }
  return Date.UTC(year, month - 1, day, arm.hour, arm.minute) - arm.fromOffsetMin * 60000;
}

/** The offset the feed itself claims is in force at `at`. */
function offsetFromVtimezone(def: VtimezoneDef, at: Date): number {
  const recurring = def.arms.filter((a) => a.recurs);
  // No recurrence rules means a fixed-offset zone: one answer, all year.
  if (recurring.length === 0) return def.arms[def.arms.length - 1].offsetMin;

  const year = new Date(at.getTime()).getUTCFullYear();
  let best: { ms: number; offsetMin: number } | null = null;
  for (const y of [year - 1, year, year + 1]) {
    for (const arm of recurring) {
      const ms = transitionUtcMs(arm, y);
      if (ms <= at.getTime() && (!best || ms > best.ms)) best = { ms, offsetMin: arm.offsetMin };
    }
  }
  // Before the first transition of the window, the offset is the other arm's.
  if (!best) {
    const earliest = recurring.reduce((a, b) => (transitionUtcMs(a, year) <= transitionUtcMs(b, year) ? a : b));
    return earliest.fromOffsetMin;
  }
  return best.offsetMin;
}

/** Minutes east of UTC that a real IANA zone is at an instant. */
export function zoneOffsetMinutes(zone: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(at)) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** The wall-clock reading of an instant in a named zone — what a person in that
 * zone sees on the wall. The inverse of scheduling/time.ts's zonedTimeToUtc,
 * and the pair of them is how a recurrence gets expanded on wall-clock terms
 * (a 3pm meeting stays 3pm across a DST change) without the process's own
 * timezone entering into it. */
export function wallClockIn(
  zone: string,
  at: Date,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(at)) p[part.type] = part.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
}

export function isIanaZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** Monthly probes across the window any of this app's data can reach: a year of
 * history to keep the calendar's record honest, two years ahead to cover the
 * scheduling horizon and long-dated recurrences. Monthly (not quarterly) so a
 * probe always lands on both sides of every DST transition. */
function probeInstants(at: Date): Date[] {
  const probes: Date[] = [];
  const start = new Date(Date.UTC(at.getUTCFullYear() - 1, at.getUTCMonth(), 15, 12));
  for (let i = 0; i < 36; i += 1) {
    probes.push(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 15, 12)));
  }
  return probes;
}

/** Every IANA zone whose real offsets match what the feed declares, at every
 * probe. They are interchangeable by construction — agreeing at all 36 probes
 * means they produce identical instants for anything in range — so which one is
 * chosen only affects the label, never the arithmetic. */
function matchingZones(def: VtimezoneDef, at: Date): string[] {
  const probes = probeInstants(at);
  const expected = probes.map((p) => offsetFromVtimezone(def, p));
  return supportedZones().filter((zone) => probes.every((p, i) => zoneOffsetMinutes(zone, p) === expected[i]));
}

let zoneCache: string[] | null = null;
function supportedZones(): string[] {
  if (!zoneCache) {
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    zoneCache = supported ? supported("timeZone") : [];
  }
  return zoneCache;
}

/** node-ical ships the CLDR Windows->IANA table. Used only as a late fallback,
 * for a feed that names a Windows zone but omits the VTIMEZONE that would have
 * defined it. Reached through a guarded require because it is the library's
 * internal file, not part of its API: if a future version drops it, resolution
 * falls through to the account's zone with a warning rather than breaking. */
let windowsZones: Record<string, { iana: string[] }> | null | undefined;
function windowsZoneToIana(name: string): string | null {
  if (windowsZones === undefined) {
    try {
      windowsZones = createRequire(import.meta.url)("node-ical/windowsZones.json");
    } catch {
      windowsZones = null;
    }
  }
  return windowsZones?.[name]?.iana?.[0] ?? null;
}

/** Decides what one TZID means, never consulting the process's own timezone.
 *
 * Order matters: a real zone name is taken at face value; otherwise the feed's
 * own declared rules win, because they are this file's statement about itself
 * and beat any table; a Windows name is next, for feeds that omit VTIMEZONE;
 * and the account's zone is the floor, because a person's own calendar is
 * overwhelmingly in their own timezone — and it is at least a property OF THE
 * USER rather than of whichever machine happened to run the sync. */
export function resolveTzid(
  tzid: string,
  defs: Map<string, VtimezoneDef>,
  accountZone: string,
  at: Date = new Date(),
): TzidResolution {
  const clean = tzid.replace(/^"(.*)"$/, "$1").trim();
  const def = defs.get(clean) ?? defs.get(tzid);

  if (isIanaZone(clean)) {
    // A feed that names a real zone but describes a different one is broken in
    // a way worth seeing. The name is still trusted — it is the more reliable
    // of the two in practice — but silence here would hide a real problem.
    let warning: string | undefined;
    if (def) {
      const probes = probeInstants(at);
      const disagrees = probes.some((p) => zoneOffsetMinutes(clean, p) !== offsetFromVtimezone(def, p));
      if (disagrees) {
        warning = `feed names "${clean}" but its VTIMEZONE describes different offsets; used the name`;
      }
    }
    return { tzid: clean, zone: clean, kind: "iana", warning };
  }

  if (def) {
    const matches = matchingZones(def, at);
    if (matches.length > 0) {
      // Which match to name. All of them give identical instants, so this only
      // decides the label a warning would show: prefer the account's own zone,
      // then the canonical name for a Windows zone ("Mountain Standard Time"
      // reads better as America/Denver than as the alphabetically first
      // America/Boise), then whatever sorts first so the answer is stable.
      const windows = windowsZoneToIana(clean);
      const zone =
        (matches.includes(accountZone) && accountZone) ||
        (windows && matches.includes(windows) && windows) ||
        [...matches].sort()[0];
      return { tzid: clean, zone, kind: "derived" };
    }
    // Offsets that match no real zone (a hand-rolled or historical rule set).
    // A fixed offset still beats a guess, and Etc/GMT is sign-inverted by spec.
    const arms = def.arms;
    const constant = arms.every((a) => a.offsetMin === arms[0].offsetMin);
    if (constant && arms[0].offsetMin % 60 === 0) {
      const hours = arms[0].offsetMin / 60;
      const zone = `Etc/GMT${hours <= 0 ? "+" : "-"}${Math.abs(hours)}`;
      if (isIanaZone(zone)) {
        return { tzid: clean, zone, kind: "derived", warning: `no named zone matches "${clean}"; used ${zone}` };
      }
    }
  }

  const windows = windowsZoneToIana(clean);
  if (windows && isIanaZone(windows)) return { tzid: clean, zone: windows, kind: "windows" };

  return {
    tzid: clean,
    zone: accountZone,
    kind: "account-fallback",
    warning: `feed used timezone "${clean}" without defining it; read as ${accountZone}`,
  };
}

export interface PreparedIcs {
  /** Unfolded ICS text with every TZID rewritten to a real IANA zone, and every
   * floating time given an explicit one. Safe to hand to any parser. */
  text: string;
  resolutions: TzidResolution[];
  /** How many VEVENT times had no zone at all and were read as account-local. */
  floatingCount: number;
}

/** RFC 5545's date-time properties. RECURRENCE-ID and EXDATE carry zones too,
 * and a mismatch there silently stops an exception from cancelling its
 * occurrence — a deleted meeting reappearing is the same bug wearing a hat. */
const TIMED_PROPS = "DTSTART|DTEND|EXDATE|RECURRENCE-ID|RDATE|DUE";

/** Rewrites a feed so that every timed value states a zone the parser can
 * resolve. Call before parsing; pair with assertZonesArePinned. */
export function prepareIcs(raw: string, accountZone: string, at: Date = new Date()): PreparedIcs {
  const unfolded = unfoldIcs(raw);
  const defs = parseVtimezones(unfolded);

  const resolved = new Map<string, TzidResolution>();
  const resolveOnce = (tzid: string): TzidResolution => {
    const key = tzid.replace(/^"(.*)"$/, "$1").trim();
    let hit = resolved.get(key);
    if (!hit) {
      hit = resolveTzid(tzid, defs, accountZone, at);
      resolved.set(key, hit);
    }
    return hit;
  };

  let floatingCount = 0;
  let inVtimezone = false;
  const lines = unfolded.split("\n").map((line) => {
    // VTIMEZONE bodies are the one place a floating DTSTART is correct — it is
    // the transition rule itself, not a time in anyone's day. Leave them alone.
    if (line.startsWith("BEGIN:VTIMEZONE")) inVtimezone = true;
    else if (line.startsWith("END:VTIMEZONE")) inVtimezone = false;

    // The VTIMEZONE's own name, so the block still matches the events using it.
    if (inVtimezone && line.startsWith("TZID:")) {
      return `TZID:${resolveOnce(line.slice(5)).zone}`;
    }
    if (inVtimezone) return line;

    const withTzid = new RegExp(`^(${TIMED_PROPS})((?:;[^:]*)?);TZID=([^:;]+)((?:;[^:]*)?):(.*)$`).exec(line);
    if (withTzid) {
      const [, prop, before, tzid, after, value] = withTzid;
      return `${prop}${before};TZID=${resolveOnce(tzid).zone}${after}:${value}`;
    }

    // A floating time: a date-time with neither Z nor TZID. RFC 5545 says it
    // means local time wherever it is read — which on a server is a coin toss,
    // and is exactly the hole the TZID rewrite above would otherwise leave open.
    // The owner's own zone is what "local" means for the owner's own calendar.
    const floating = new RegExp(`^(${TIMED_PROPS})((?:;[^:]*)?):(\\d{8}T\\d{6})$`).exec(line);
    if (floating && !/VALUE=DATE(?!-)/.test(floating[2])) {
      floatingCount += 1;
      return `${floating[1]}${floating[2]};TZID=${accountZone}:${floating[3]}`;
    }

    return line;
  });

  return { text: lines.join("\n"), resolutions: [...resolved.values()], floatingCount };
}

/** The guardrail proper: proves the prepared text cannot be read in the
 * server's timezone, whatever the parser would otherwise have done with it.
 *
 * Every timed value must be UTC ("Z"), or date-valued, or carry a TZID that is
 * a real IANA zone. Those are the only three forms whose meaning is fixed
 * independent of where the code runs — so if this passes, the four-hour shift
 * cannot recur, no matter which feed, which provider, or which machine.
 *
 * It throws rather than warns on purpose: a sync that fails is visible on the
 * connection and fixable, while wrong times are silent and reach the booking
 * link, where a stranger books over a real meeting. */
export function assertZonesArePinned(preparedText: string): void {
  let inVtimezone = false;
  let lineNo = 0;
  for (const line of preparedText.split("\n")) {
    lineNo += 1;
    if (line.startsWith("BEGIN:VTIMEZONE")) inVtimezone = true;
    else if (line.startsWith("END:VTIMEZONE")) inVtimezone = false;
    if (inVtimezone) continue;

    const m = new RegExp(`^(${TIMED_PROPS})((?:;[^:]*)?):(.*)$`).exec(line);
    if (!m) continue;
    const [, prop, params, value] = m;
    if (/VALUE=DATE(?!-)/.test(params)) continue; // all-day, no time to misread
    if (!/\d{8}T\d{6}/.test(value)) continue; // durations, periods, non-times
    if (/\d{8}T\d{6}Z/.test(value)) continue; // explicit UTC

    const tzid = /;TZID=([^:;]+)/.exec(params)?.[1];
    if (!tzid) {
      throw new Error(
        `line ${lineNo}: ${prop} has no timezone and no "Z" — it would be read in the server's timezone`,
      );
    }
    if (!isIanaZone(tzid.replace(/^"(.*)"$/, "$1"))) {
      throw new Error(
        `line ${lineNo}: ${prop} uses TZID="${tzid}", which is not a real timezone — it would fall back to the server's`,
      );
    }
  }
}
