import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { isSlotFree } from "@/lib/scheduling/free-slots";
import { getAccessToken, GoogleDisconnectedError } from "@/lib/google/oauth";
import { insertBookingEvent } from "@/lib/google/calendar";
import { sendPushToUser } from "@/lib/notifications/send";
import { buildIcs } from "@/lib/booking/ics";

// PUBLIC route (middleware-exempt). Creates a booking: local event row
// (instant slot-blocking + calendar display), booking record, best-effort
// Google Calendar event (Google emails the visitor's invite), owner push.

const bodySchema = z.object({
  startIso: z.string().datetime(),
  durationMin: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  note: z.string().trim().max(1000).optional(),
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

  // Authoritative re-validation against fresh data. A ~1s race between two
  // visitors remains; the bookings(user_id, starts_at) unique index catches
  // exact-instant collisions below.
  if (!(await isSlotFree(admin, link, startIso, durationMin))) {
    return NextResponse.json({ error: "slot_taken" }, { status: 409 });
  }

  const { data: profile } = await admin
    .from("profiles")
    .select("booking_meeting_url, timezone")
    .eq("id", link.user_id)
    .single();
  const meetingUrl = profile?.booking_meeting_url ?? null;
  const timezone = profile?.timezone ?? "UTC";

  const startsAt = new Date(startIso);
  const endsAt = new Date(startsAt.getTime() + durationMin * 60000);
  const title = `${link.title}: ${name}`;

  // Local event first — connection_id stays null so ICS resyncs (which
  // delete-by-connection) never wipe booking events. It becomes a hard
  // "synced" block in the engine immediately.
  const { data: event, error: eventError } = await admin
    .from("events")
    .insert({
      user_id: link.user_id,
      title,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      source: "manual",
      meeting_url: meetingUrl,
      location: meetingUrl,
      description: note || null,
    })
    .select("id")
    .single();
  if (eventError || !event) return NextResponse.json({ error: "Booking failed" }, { status: 500 });

  const { data: booking, error: bookingError } = await admin
    .from("bookings")
    .insert({
      user_id: link.user_id,
      link_id: link.id,
      event_id: event.id,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      duration_min: durationMin,
      visitor_name: name,
      visitor_email: email,
      visitor_note: note || null,
    })
    .select("id")
    .single();
  if (bookingError || !booking) {
    // Unique-index collision (simultaneous identical instant) or other
    // failure — roll back the event row so no phantom busy block remains.
    await admin.from("events").delete().eq("id", event.id);
    const conflict = bookingError?.code === "23505";
    return NextResponse.json(
      { error: conflict ? "slot_taken" : "Booking failed" },
      { status: conflict ? 409 : 500 },
    );
  }

  // Best-effort Google event — failure must never fail the booking.
  let googleOk = false;
  try {
    const accessToken = await getAccessToken(admin, link.user_id);
    const googleEventId = await insertBookingEvent(accessToken, {
      title,
      description: `${note ? note + "\n\n" : ""}${meetingUrl ? `Join: ${meetingUrl}` : ""}`.trim(),
      location: meetingUrl ?? "",
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
    body: `${name} — ${timeLabel} (${durationMin}m)${googleOk ? "" : " · Google invite NOT sent — contact them directly"}`,
    url: "/",
  });

  const ics = buildIcs({
    bookingId: booking.id,
    title: link.title,
    startIso: startsAt.toISOString(),
    endIso: endsAt.toISOString(),
    description: `${note ? note + "\n" : ""}${meetingUrl ? `Join: ${meetingUrl}` : ""}`.trim(),
    meetingUrl,
  });

  return NextResponse.json({
    bookingId: booking.id,
    startIso: startsAt.toISOString(),
    endIso: endsAt.toISOString(),
    meetingUrl,
    title: link.title,
    googleInviteSent: googleOk,
    ics,
  });
}
