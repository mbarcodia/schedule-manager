// Minimal Google Calendar REST wrapper — a single insert; the visitor is an
// attendee and sendUpdates=all makes Google email them the invite (this is
// deliberately the app's only "email service").

const EVENTS_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export interface BookingEventInput {
  title: string;
  description: string;
  location: string;
  startIso: string;
  endIso: string;
  timezone: string;
  visitorName: string;
  visitorEmail: string;
}

/** Returns the created Google event id. */
export async function insertBookingEvent(accessToken: string, input: BookingEventInput): Promise<string> {
  const res = await fetch(`${EVENTS_ENDPOINT}?sendUpdates=all`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: input.title,
      description: input.description,
      location: input.location,
      start: { dateTime: input.startIso, timeZone: input.timezone },
      end: { dateTime: input.endIso, timeZone: input.timezone },
      attendees: [{ email: input.visitorEmail, displayName: input.visitorName }],
    }),
  });
  if (!res.ok) throw new Error(`Google event insert failed (${res.status})`);
  const data = (await res.json()) as { id: string };
  return data.id;
}
