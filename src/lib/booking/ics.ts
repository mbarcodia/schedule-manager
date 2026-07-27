// Hand-rolled iCalendar invite for the visitor's confirmation download —
// three-line spec surface, not worth a dependency. UTC "Z" timestamps
// sidestep VTIMEZONE entirely; importing calendars localize themselves.

function icsEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsUtc(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** RFC 5545: content lines fold at 75 octets, continuations start with a
 * space. Splitting on chars (not octets) is fine for our ASCII-heavy lines. */
function fold(line: string): string {
  const parts: string[] = [];
  for (let i = 0; i < line.length; i += 74) parts.push((i === 0 ? "" : " ") + line.slice(i, i + 74));
  return parts.join("\r\n");
}

export function buildIcs(input: {
  bookingId: string;
  title: string;
  startIso: string;
  endIso: string;
  description: string;
  /** Join link for video meetings — becomes URL:. */
  meetingUrl: string | null;
  /** Where it happens (office text or the join link) — becomes LOCATION:. */
  location?: string | null;
  /** Bumped on reschedule so calendars replace rather than duplicate. */
  sequence?: number;
  /** METHOD:CANCEL + STATUS:CANCELLED, so importing removes the meeting. */
  cancelled?: boolean;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ScheduleManager//Booking//EN",
    `METHOD:${input.cancelled ? "CANCEL" : "PUBLISH"}`,
    "BEGIN:VEVENT",
    // Stable UID + rising SEQUENCE: a rescheduled or cancelled booking
    // updates the guest's existing entry instead of adding a second one.
    `UID:booking-${input.bookingId}@schedule-manager`,
    `SEQUENCE:${input.sequence ?? 0}`,
    `DTSTAMP:${icsUtc(new Date().toISOString())}`,
    `DTSTART:${icsUtc(input.startIso)}`,
    `DTEND:${icsUtc(input.endIso)}`,
    `SUMMARY:${icsEscape(input.title)}`,
    `DESCRIPTION:${icsEscape(input.description)}`,
    ...(input.location ? [`LOCATION:${icsEscape(input.location)}`] : []),
    ...(input.meetingUrl ? [`URL:${icsEscape(input.meetingUrl)}`] : []),
    ...(input.cancelled ? ["STATUS:CANCELLED"] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
