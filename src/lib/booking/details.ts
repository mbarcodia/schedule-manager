// How a booking presents itself — title, where it happens, and the detail
// block. Shared by the booking POST, the reschedule/cancel routes, the Google
// event, the .ics, and the owner's own calendar event so all five agree.

import type { BookingLocationMode } from "@/lib/supabase/database.types";

export interface BookingDetailInput {
  linkTitle: string;
  visitorName: string;
  visitorEmail: string;
  /** profiles.display_name — the owner's name as guests should see it. */
  ownerName: string | null;
  locationMode: BookingLocationMode;
  /** Static meeting-room URL (profiles.booking_meeting_url). */
  meetingUrl: string | null;
  /** profiles.office_location free text. */
  officeLocation: string | null;
  note: string | null;
  manageUrl: string;
}

/** "Jane Doe <> Marybeth Arcodia" — the form she asked for on invites. Falls
 * back to the link's own title when the owner hasn't set a display name yet,
 * so a half-configured account still produces a sensible invite. */
export function bookingTitle(input: BookingDetailInput): string {
  return input.ownerName ? `${input.visitorName} <> ${input.ownerName}` : `${input.linkTitle}: ${input.visitorName}`;
}

/** Human-readable location for the calendar's LOCATION field. */
export function locationText(input: BookingDetailInput): string | null {
  return input.locationMode === "office" ? input.officeLocation : input.meetingUrl;
}

/** Only Zoom-style bookings carry a join URL; office meetings have none. */
export function joinUrl(input: BookingDetailInput): string | null {
  return input.locationMode === "zoom" ? input.meetingUrl : null;
}

/** The detail block written to the calendar event, the Google invite, and the
 * .ics — so the location and the guest's notes actually show up on her
 * schedule-manager calendar (EventDetailPopover renders description). */
export function bookingDescription(input: BookingDetailInput): string {
  const where = input.locationMode === "office" ? (input.officeLocation ?? "Office") : (input.meetingUrl ?? "Video call");
  return [
    `Booked via ${input.linkTitle}`,
    `Guest: ${input.visitorName} (${input.visitorEmail})`,
    `Where: ${where}`,
    ...(input.note ? [`Notes: ${input.note}`] : []),
    `Reschedule or cancel: ${input.manageUrl}`,
  ].join("\n");
}

export function manageUrlFor(bookingId: string): string {
  return `${process.env.APP_ORIGIN}/book/manage/${bookingId}`;
}
