// Fetches and parses a read-only ICS feed (Outlook's "Publish a calendar"
// link, or an iCloud/Google ICS fallback) into plain event instances within
// a date window. Recurrence expansion uses the `rrule` library (RFC
// 5545-correct) via node-ical's parsed RRule, rather than a hand-rolled
// regex implementation.
//
// Pinned to node-ical@0.20.1 (not latest): newer versions pull in
// `temporal-polyfill`, which breaks Next.js/Turbopack's server build
// ("s.BigInt is not a function") when the route module is analyzed at
// build time. 0.20.1 predates that dependency and uses the plain `rrule`
// package instead, which bundles cleanly.

import ical from "node-ical";
import { RRule, type Options } from "rrule";
import { zonedTimeToUtc } from "@/lib/scheduling/time";
import { assertZonesArePinned, isIanaZone, prepareIcs, wallClockIn, type TzidResolution } from "./tzid";
import type { VEvent } from "node-ical";

export interface SyncedEvent {
  /** Stable per-occurrence identifier, used as events.external_id. */
  uid: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  description: string | null;
  location: string | null;
  meetingUrl: string | null;
  /** From an all-day (date-valued) entry rather than a timed one. Rendered as a
   * banner, and what it blocks depends on the connection's all_day_mode. */
  allDay: boolean;
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const MEETING_HOSTS = [
  "zoom.us",
  "meet.google.com",
  "teams.microsoft.com",
  "teams.live.com",
  "webex.com",
  "gotomeeting.com",
  "bluejeans.com",
  "whereby.com",
];

/** Best-effort join-link detection — these providers don't put the link in
 * a single standard field, so scan the ones that usually carry it, in
 * order of reliability: the VEVENT's own URL property first, then
 * description/location text. */
function extractMeetingUrl(...texts: (string | undefined)[]): string | null {
  for (const text of texts) {
    if (!text) continue;
    const matches = text.match(URL_PATTERN);
    if (!matches) continue;
    const hit = matches.find((u) => MEETING_HOSTS.some((h) => u.toLowerCase().includes(h)));
    if (hit) return hit.replace(/[.,;)]+$/, "");
  }
  return null;
}

/** Splits an all-day span into one entry per calendar day it covers.
 *
 * ICS gives all-day events a date-valued DTSTART and an EXCLUSIVE DTEND, so
 * Mon-Fri arrives as 3 Aug -> 8 Aug. Everything downstream — the grid, the busy
 * set, the day window — works a day at a time, so a single row spanning five
 * days would be mapped onto its start day and the other four would vanish.
 *
 * The day boundaries must be midnight in the ACCOUNT'S timezone, which is why
 * this takes one. An earlier version used the process's local midnight; sync
 * runs on Vercel where that is UTC, so a five-day conference was stored as five
 * 8pm-to-8pm spans and every day landed on the evening before. The last day fell
 * off the end, leaving it bookable while the owner was away.
 *
 * A date-valued DTSTART is a calendar date with no time and no zone, so it
 * arrives here as {year, month, day} rather than an instant — see
 * dateOnlyParts for why an instant would be the wrong thing to carry. */
export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** The calendar date behind a date-valued DTSTART/DTEND, read back the same way
 * node-ical wrote it.
 *
 * node-ical builds these with `new Date(y, m - 1, d)` — the LOCAL constructor,
 * under a comment that says "assume same timezone as this computer". So the
 * instant it produces is different on every machine, and reading it back with
 * getUTC* (which is what this file used to do) reads a different date depending
 * on where the code runs: a 1 June banner became 1-2 June in New York and
 * 31 May-1 June in Tokyo. The local constructor and the local getters are exact
 * inverses of each other, though, so going back through getFullYear/getMonth/
 * getDate returns the date the feed actually said, on any machine. */
function dateOnlyParts(d: Date): CivilDate {
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

/** Exported for scripts/sanity-check-all-day-days.mjs: which local days a span
 * covers is worth asserting directly, since getting it wrong is invisible until
 * someone in a non-UTC timezone travels. */
export const expandAllDayForTest = (
  uid: string,
  title: string,
  start: CivilDate,
  end: CivilDate,
  timeZone: string,
): SyncedEvent[] => expandAllDay(uid, title, start, end, timeZone);

function expandAllDay(
  uid: string,
  title: string,
  start: CivilDate,
  end: CivilDate,
  timeZone: string,
  description?: string,
  location?: string,
  url?: string,
): SyncedEvent[] {
  const out: SyncedEvent[] = [];
  // Plain calendar arithmetic on the date parts, no zone involved yet. UTC is
  // just the arithmetic frame here — these are civil dates, not instants.
  const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day));
  const endMs = Date.UTC(end.year, end.month - 1, end.day);
  // A malformed feed can give end <= start: still emit the one day.
  const last = endMs > cursor.getTime() ? endMs : cursor.getTime() + 86400000;
  let guard = 0;
  while (cursor.getTime() < last && guard++ < 400) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    const d = cursor.getUTCDate();
    const next = new Date(cursor.getTime() + 86400000);
    out.push({
      uid: `${uid}-allday-${y}-${m}-${d}`,
      title,
      startsAt: zonedTimeToUtc(y, m, d, 0, 0, timeZone),
      endsAt: zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone),
      description: description || null,
      location: location || null,
      meetingUrl: extractMeetingUrl(url, description, location),
      allDay: true,
    });
    cursor.setTime(next.getTime());
  }
  return out;
}

/** A recurrence expanded on WALL-CLOCK terms, then converted to instants.
 *
 * The obvious way — `ev.rrule.between(from, to)` — is a second, independent
 * copy of the same bug the TZID rewrite exists to kill. rrule.js given a `tzid`
 * returns occurrences shifted by the offset of the PROCESS's timezone: the same
 * weekly meeting comes back at 19:00Z on a UTC server, 12:00Z in Los Angeles,
 * and on the following DAY in Tokyo. It happens to be right on Vercel only
 * because Vercel is UTC, where that shift is zero — a fix resting on a
 * coincidence about someone else's infrastructure.
 *
 * So the rule is rebuilt with its timezone stripped and its start expressed as
 * a floating wall clock, which makes rrule do all its arithmetic in UTC and
 * return exactly the wall clocks the feed meant. Each of those is then anchored
 * in the event's real zone one at a time — which is also what keeps a 3pm
 * meeting at 3pm across a DST change instead of sliding to 2pm, since every
 * occurrence gets its own offset lookup rather than inheriting the first one's.
 *
 * EXDATE and RECURRENCE-ID are compared as real instants: they were parsed from
 * the same rewritten text, so the exception and the occurrence it cancels now
 * agree. Before, a cancelled meeting could reappear because the two were
 * computed in different frames. */
function expandRecurrence(
  ev: VEvent,
  title: string,
  durationMs: number,
  horizonStart: Date,
  horizonEnd: Date,
  fallbackZone: string,
): SyncedEvent[] {
  // node-ical records the resolved zone on the date it parsed; after prepareIcs
  // that is always a real zone (or Etc/UTC for a "Z" time). The fallback is the
  // account's zone — never the process's.
  const startTz = (ev.start as Date & { tz?: string }).tz;
  const zone = startTz && isIanaZone(startTz) ? startTz : fallbackZone;

  const toFloating = (at: Date): Date => {
    const w = wallClockIn(zone, at);
    return new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second));
  };
  const fromFloating = (floating: Date): Date =>
    new Date(
      zonedTimeToUtc(
        floating.getUTCFullYear(),
        floating.getUTCMonth() + 1,
        floating.getUTCDate(),
        floating.getUTCHours(),
        floating.getUTCMinutes(),
        zone,
      ).getTime() +
        floating.getUTCSeconds() * 1000,
    );

  const options: Partial<Options> = { ...ev.rrule!.origOptions };
  delete options.tzid;
  options.dtstart = toFloating(ev.start);
  // UNTIL is a real UTC instant in the feed, so it has to move into the
  // floating frame too or the series is cut off at the wrong occurrence.
  if (options.until instanceof Date) options.until = toFloating(options.until);
  const floatingRule = new RRule(options);

  // A day of slack each side because the floating window and the real one are
  // offset from each other; the exact horizon test happens below, on instants.
  const windowFrom = toFloating(new Date(horizonStart.getTime() - 86400000));
  const windowTo = toFloating(new Date(horizonEnd.getTime() + 86400000));

  const exdates = new Set<number>(
    ev.exdate ? Object.values(ev.exdate as Record<string, Date>).map((d) => d.getTime()) : [],
  );

  const out: SyncedEvent[] = [];
  for (const floating of floatingRule.between(windowFrom, windowTo, true)) {
    const occStart = fromFloating(floating);
    if (exdates.has(occStart.getTime())) continue;

    // node-ical keys overrides by the UTC date of the RECURRENCE-ID instant.
    const override = ev.recurrences?.[occStart.toISOString().slice(0, 10)];
    if (override?.status === "CANCELLED") continue;

    const start = override?.start ?? occStart;
    const end = override?.end ?? new Date(occStart.getTime() + durationMs);
    if (end < horizonStart || start > horizonEnd) continue;

    out.push(
      buildEvent(
        `${ev.uid}-${occStart.toISOString()}`,
        override?.summary || title,
        start,
        end,
        override?.description ?? ev.description,
        override?.location ?? ev.location,
        override?.url ?? ev.url,
      ),
    );
  }
  return out;
}

function buildEvent(
  uid: string,
  title: string,
  startsAt: Date,
  endsAt: Date,
  description?: string,
  location?: string,
  url?: string,
): SyncedEvent {
  return {
    uid,
    title,
    startsAt,
    endsAt,
    description: description || null,
    location: location || null,
    meetingUrl: extractMeetingUrl(url, description, location),
    allDay: false,
  };
}

export interface ParsedFeed {
  events: SyncedEvent[];
  /** What each TZID in the feed was taken to mean, and which of those were
   * guesses. Recorded on the connection so a feed that needed guessing says so
   * instead of quietly producing plausible wrong times. */
  resolutions: TzidResolution[];
  /** VEVENT times that carried no zone at all and were read as account-local. */
  floatingCount: number;
}

export async function fetchIcsEvents(
  url: string,
  horizonStart: Date,
  horizonEnd: Date,
  /** Whether to keep all-day entries. False (the default) drops them, which is
   * right for a calendar full of birthday and holiday banners; the caller passes
   * true only for a connection that has opted in. */
  includeAllDay = false,
  /** The account's timezone. Anchors all-day day boundaries, and is the floor
   * every timezone resolution falls back to (see tzid.ts) — so unlike before,
   * it matters on EVERY feed, not just ones with all-day entries. */
  timeZone = "UTC",
): Promise<ParsedFeed> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`feed returned HTTP ${response.status}`);
  return parseIcsFeed(await response.text(), horizonStart, horizonEnd, includeAllDay, timeZone);
}

/** The parse half of fetchIcsEvents, over text rather than a URL — the seam the
 * timezone guardrail test drives, since proving the result does not depend on
 * the server's timezone means running the same bytes under several of them. */
export async function parseIcsFeed(
  raw: string,
  horizonStart: Date,
  horizonEnd: Date,
  includeAllDay = false,
  timeZone = "UTC",
): Promise<ParsedFeed> {
  // Pin every zone BEFORE parsing, then prove it. node-ical answers an
  // unresolvable TZID with the server's own timezone, so a feed reaching it
  // unprepared is how every Outlook meeting ended up four hours early.
  const prepared = prepareIcs(raw, timeZone);
  assertZonesArePinned(prepared.text);

  const data = await ical.async.parseICS(prepared.text);
  const out: SyncedEvent[] = [];

  for (const item of Object.values(data)) {
    if (!item || item.type !== "VEVENT") continue;
    const ev = item as VEvent;
    if (ev.status === "CANCELLED") continue;
    if (!ev.start || !ev.end) continue;

    // All-day entries are mostly banners (birthdays, holidays) that must not
    // consume time, so they're only kept for a calendar that has opted in —
    // see calendar_connections.all_day_mode.
    if (ev.datetype === "date") {
      if (!includeAllDay) continue;
      // A day of slack each side: these two Dates are the machine-dependent
      // instants described in dateOnlyParts, so they can sit up to 14 hours
      // either side of the date they stand for. Only ever widens the window —
      // every entry is filtered again below on correctly anchored instants.
      if (ev.end.getTime() < horizonStart.getTime() - 86400000) continue;
      if (ev.start.getTime() > horizonEnd.getTime() + 86400000) continue;
      out.push(
        ...expandAllDay(
          ev.uid,
          ev.summary || "Busy",
          dateOnlyParts(ev.start),
          dateOnlyParts(ev.end),
          timeZone,
          ev.description,
          ev.location,
          ev.url,
        ).filter((e) => e.endsAt >= horizonStart && e.startsAt <= horizonEnd),
      );
      continue;
    }

    const title = ev.summary || "Busy";
    const durationMs = ev.end.getTime() - ev.start.getTime();

    if (ev.rrule) {
      out.push(...expandRecurrence(ev, title, durationMs, horizonStart, horizonEnd, timeZone));
      continue;
    }

    if (ev.end < horizonStart || ev.start > horizonEnd) continue;
    out.push(buildEvent(ev.uid, title, ev.start, ev.end, ev.description, ev.location, ev.url));
  }

  return { events: out, resolutions: prepared.resolutions, floatingCount: prepared.floatingCount };
}
