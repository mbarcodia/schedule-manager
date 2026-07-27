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
  meetingUrl: string | null;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ScheduleManager//Booking//EN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:booking-${input.bookingId}@schedule-manager`,
    `DTSTAMP:${icsUtc(new Date().toISOString())}`,
    `DTSTART:${icsUtc(input.startIso)}`,
    `DTEND:${icsUtc(input.endIso)}`,
    `SUMMARY:${icsEscape(input.title)}`,
    `DESCRIPTION:${icsEscape(input.description)}`,
    ...(input.meetingUrl ? [`LOCATION:${icsEscape(input.meetingUrl)}`, `URL:${icsEscape(input.meetingUrl)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
