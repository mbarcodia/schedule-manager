import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { isSlotFree } from "@/lib/scheduling/free-slots";
import { getAccessToken, GoogleDisconnectedError } from "@/lib/google/oauth";
import { insertBookingEvent } from "@/lib/google/calendar";
import { sendPushToUser } from "@/lib/notifications/send";
import { buildIcs } from "@/lib/booking/ics";
import { bookingDescription, bookingTitle, joinUrl, locationText, manageUrlFor } from "@/lib/booking/details";

// PUBLIC route (middleware-exempt). Creates a booking: local event row
// (instant slot-blocking + calendar display), booking record, best-effort
// Google Calendar event (Google emails the visitor's invite), owner push.

const bodySchema = z.object({
  startIso: z.string().datetime(),
  durationMin: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  note: z.string().trim().max(1000).optional(),
  locationMode: z.enum(["zoom", "office"]).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const { startIso, durationMin, name, email, note } = parsed.data;

  const admin = createAdminClient();
  const { data: link } = await admin.from("booking_links").select("*").eq("slug", slug).eq("active", true).maybeSingle();
  if (!link) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!link.durations.includes(durationMin)) return NextResponse.json({ error: "Invalid duration" }, { status: 400 });

  // Default to the link's only location when the visitor wasn't asked.
  const locationMode = parsed.data.locationMode ?? link.location_modes[0] ?? "zoom";
  if (!link.location_modes.includes(locationMode)) {
    return NextResponse.json({ error: "Invalid location" }, { status: 400 });
  }

  // Authoritative re-validation against fresh data. A ~1s race between two
  // visitors remains; the partial unique index on live bookings catches
  // exact-instant collisions below.
  if (!(await isSlotFree(admin, link, startIso, durationMin))) {
    return NextResponse.json({ error: "slot_taken" }, { status: 409 });
  }

  const { data: profile } = await admin
    .from("profiles")
    .select("booking_meeting_url, timezone, display_name, office_location")
    .eq("id", link.user_id)
    .single();
  const timezone = profile?.timezone ?? "UTC";

  const startsAt = new Date(startIso);
  const endsAt = new Date(startsAt.getTime() + durationMin * 60000);

  const { data: booking, error: bookingError } = await admin
    .from("bookings")
    .insert({
      user_id: link.user_id,
      link_id: link.id,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      duration_min: durationMin,
      visitor_name: name,
      visitor_email: email,
      visitor_note: note || null,
      location_mode: locationMode,
    })
    .select("id")
    .single();
  if (bookingError || !booking) {
    const conflict = bookingError?.code === "23505";
    return NextResponse.json(
      { error: conflict ? "slot_taken" : "Booking failed" },
      { status: conflict ? 409 : 500 },
    );
  }

  const details = {
    linkTitle: link.title,
    visitorName: name,
    visitorEmail: email,
    ownerName: profile?.display_name ?? null,
    locationMode,
    meetingUrl: profile?.booking_meeting_url ?? null,
    officeLocation: profile?.office_location ?? null,
    note: note || null,
    manageUrl: manageUrlFor(booking.id),
  };
  const title = bookingTitle(details);
  const description = bookingDescription(details);
  const where = locationText(details);
  const join = joinUrl(details);

  // Local event — connection_id stays null so ICS resyncs (which delete by
  // connection) never wipe booking events. Becomes a hard "synced" block in
  // the engine immediately, and the popover shows location + guest notes.
  const { data: event, error: eventError } = await admin
    .from("events")
    .insert({
      user_id: link.user_id,
      title,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      source: "manual",
      meeting_url: join,
      location: where,
      description,
    })
    .select("id")
    .single();
  if (eventError || !event) {
    await admin.from("bookings").delete().eq("id", booking.id);
    return NextResponse.json({ error: "Booking failed" }, { status: 500 });
  }
  await admin.from("bookings").update({ event_id: event.id }).eq("id", booking.id);

  // Best-effort Google event — failure must never fail the booking.
  let googleOk = false;
  try {
    const accessToken = await getAccessToken(admin, link.user_id);
    const googleEventId = await insertBookingEvent(accessToken, {
      title,
      description,
      location: where ?? "",
      startIso: startsAt.toISOString(),
      endIso: endsAt.toISOString(),
      timezone,
      visitorName: name,
      visitorEmail: email,
    });
    await admin.from("bookings").update({ google_event_id: googleEventId }).eq("id", booking.id);
    googleOk = true;
  } catch (e) {
    if (!(e instanceof GoogleDisconnectedError)) {
      console.error("[booking] google insert failed:", e instanceof Error ? e.message : e);
    }
  }

  const timeLabel = startsAt.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });
  await sendPushToUser(admin, link.user_id, {
    title: "New booking",
    body: `${name} — ${timeLabel} (${durationMin}m, ${locationMode === "office" ? "office" : "video"})${googleOk ? "" : " · Google invite NOT sent — contact them directly"}`,
    url: "/",
  });

  return NextResponse.json({
    bookingId: booking.id,
    startIso: startsAt.toISOString(),
    endIso: endsAt.toISOString(),
    title,
    locationMode,
    locationText: locationMode === "office" ? where : null,
    // The join URL is withheld when Google will email the invite — the
    // visitor gets it there rather than from a public page.
    joinUrl: googleOk ? null : join,
    manageUrl: details.manageUrl,
    googleInviteSent: googleOk,
    ics: buildIcs({
      bookingId: booking.id,
      title,
      startIso: startsAt.toISOString(),
      endIso: endsAt.toISOString(),
      description,
      meetingUrl: join,
      location: where,
    }),
  });
}
