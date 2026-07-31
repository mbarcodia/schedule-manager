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
 * Each day becomes local midnight to local midnight. Using local time matters:
 * a UTC-midnight span lands on the previous evening in a western timezone and
 * marks the wrong day. */
function expandAllDay(
  uid: string,
  title: string,
  startsAt: Date,
  endsAt: Date,
  description?: string,
  location?: string,
  url?: string,
): SyncedEvent[] {
  const out: SyncedEvent[] = [];
  const day = new Date(startsAt.getFullYear(), startsAt.getMonth(), startsAt.getDate());
  // Guard against a malformed feed giving end <= start: still emit one day.
  const last = endsAt > startsAt ? endsAt : new Date(day.getTime() + 86400000);
  let guard = 0;
  while (day < last && guard++ < 400) {
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    out.push({
      uid: `${uid}-allday-${dayStart.getFullYear()}-${dayStart.getMonth() + 1}-${dayStart.getDate()}`,
      title,
      startsAt: dayStart,
      endsAt: dayEnd,
      description: description || null,
      location: location || null,
      meetingUrl: extractMeetingUrl(url, description, location),
      allDay: true,
    });
    day.setDate(day.getDate() + 1);
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

export async function fetchIcsEvents(
  url: string,
  horizonStart: Date,
  horizonEnd: Date,
  /** Whether to keep all-day entries. False (the default) drops them, which is
   * right for a calendar full of birthday and holiday banners; the caller passes
   * true only for a connection that has opted in. */
  includeAllDay = false,
): Promise<SyncedEvent[]> {
  const data = await ical.async.fromURL(url);
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
      if (ev.end < horizonStart || ev.start > horizonEnd) continue;
      out.push(
        ...expandAllDay(ev.uid, ev.summary || "Busy", ev.start, ev.end, ev.description, ev.location, ev.url).filter(
          (e) => e.endsAt >= horizonStart && e.startsAt <= horizonEnd,
        ),
      );
      continue;
    }

    const title = ev.summary || "Busy";
    const durationMs = ev.end.getTime() - ev.start.getTime();

    if (ev.rrule) {
      const exdates = new Set<number>(
        ev.exdate ? Object.values(ev.exdate as Record<string, Date>).map((d) => d.getTime()) : [],
      );
      const occurrences = ev.rrule.between(horizonStart, horizonEnd, true);
      occurrences.forEach((occStart) => {
        if (exdates.has(occStart.getTime())) return;
        const override = ev.recurrences?.[occStart.toISOString()] ?? ev.recurrences?.[occStart.toISOString().slice(0, 10)];
        const start = override?.start ?? occStart;
        const end = override?.end ?? new Date(occStart.getTime() + durationMs);
        if (override?.status === "CANCELLED") return;
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
      });
      continue;
    }

    if (ev.end < horizonStart || ev.start > horizonEnd) continue;
    out.push(buildEvent(ev.uid, title, ev.start, ev.end, ev.description, ev.location, ev.url));
  }

  return out;
}
