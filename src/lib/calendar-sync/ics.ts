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
  };
}

export async function fetchIcsEvents(
  url: string,
  horizonStart: Date,
  horizonEnd: Date,
): Promise<SyncedEvent[]> {
  const data = await ical.async.fromURL(url);
  const out: SyncedEvent[] = [];

  for (const item of Object.values(data)) {
    if (!item || item.type !== "VEVENT") continue;
    const ev = item as VEvent;
    if (ev.status === "CANCELLED") continue;
    // All-day/banner events (holidays, "out of office" markers) would block
    // an entire day if treated as busy time — skip rather than let one
    // banner event wipe out a day's scheduling.
    if (ev.datetype === "date") continue;
    if (!ev.start || !ev.end) continue;

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
