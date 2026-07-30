import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { isSlotFree } from "@/lib/scheduling/free-slots";
import { getAccessToken, GoogleDisconnectedError } from "@/lib/google/oauth";
import { deleteBookingEvent, updateBookingEventTime } from "@/lib/google/calendar";
import { sendPushToUser } from "@/lib/notifications/send";
import { bookingDescription, bookingTitle, joinUrl, locationText, manageUrlFor } from "@/lib/booking/details";
import { buildIcs } from "@/lib/booking/ics";

// PUBLIC route (middleware-exempt): the booking id IS the capability — a
// v4 uuid nobody can guess, handed only to the guest (confirmation page +
// invite) and to the owner (Settings). Whoever holds it may cancel or move
// that one booking and nothing else. The owner is additionally recognised by
// her session cookie, so the notification says who made the change.

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }),
  z.object({
    action: z.literal("reschedule"),
    startIso: z.string().datetime(),
    // Changing a meeting is a chance to change where it happens, not just when.
    locationMode: z.enum(["zoom", "office"]).optional(),
  }),
]);

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = createAdminClient();
  const { data: booking } = await admin
    .from("bookings")
    .select("id,starts_at,ends_at,duration_min,status,visitor_name,location_mode,link_id,user_id")
    .eq("id", id)
    .maybeSingle();
  if (!booking) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [{ data: link }, { data: profile }] = await Promise.all([
    admin.from("booking_links").select("slug,title,durations,active,location_modes").eq("id", booking.link_id).single(),
    admin.from("profiles").select("display_name,office_location,timezone").eq("id", booking.user_id).single(),
  ]);

  return NextResponse.json({
    startIso: booking.starts_at,
    durationMin: booking.duration_min,
    status: booking.status,
    visitorName: booking.visitor_name,
    locationMode: booking.location_mode,
    officeLocation: profile?.office_location ?? null,
    ownerName: profile?.display_name ?? null,
    title: link?.title ?? "Meeting",
    locationModes: link?.location_modes ?? [],
    // Rescheduling reuses the link's public availability endpoint.
    slug: link?.active ? link.slug : null,
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const admin = createAdminClient();
  const { data: booking } = await admin.from("bookings").select("*").eq("id", id).maybeSingle();
  if (!booking) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (booking.status === "cancelled") return NextResponse.json({ error: "already_cancelled" }, { status: 409 });

  // Is this the owner acting from her own session, or the guest via the link?
  let actor: "owner" | "visitor" = "visitor";
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user?.id === booking.user_id) actor = "owner";
  } catch {
    // no session — a guest with the link
  }

  const [{ data: link }, { data: profile }] = await Promise.all([
    admin.from("booking_links").select("*").eq("id", booking.link_id).single(),
    admin
      .from("profiles")
      .select("booking_meeting_url,timezone,display_name,office_location")
      .eq("id", booking.user_id)
      .single(),
  ]);
  const timezone = profile?.timezone ?? "UTC";

  // A reschedule may carry a new location; anything else keeps the original.
  const nextLocationMode =
    parsed.data.action === "reschedule" && parsed.data.locationMode && link?.location_modes.includes(parsed.data.locationMode)
      ? parsed.data.locationMode
      : booking.location_mode;

  const details = {
    linkTitle: link?.title ?? "Meeting",
    visitorName: booking.visitor_name,
    visitorEmail: booking.visitor_email,
    ownerName: profile?.display_name ?? null,
    locationMode: nextLocationMode,
    meetingUrl: profile?.booking_meeting_url ?? null,
    officeLocation: profile?.office_location ?? null,
    note: booking.visitor_note,
    manageUrl: manageUrlFor(booking.id),
  };

  if (parsed.data.action === "cancel") {
    // Keep the row (history) but release the slot: the live-bookings partial
    // unique index only covers status='confirmed'.
    await admin
      .from("bookings")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString(), last_changed_by: actor })
      .eq("id", booking.id);
    if (booking.event_id) await admin.from("events").delete().eq("id", booking.event_id);
    if (booking.google_event_id) {
      try {
        const accessToken = await getAccessToken(admin, booking.user_id);
        await deleteBookingEvent(accessToken, booking.google_event_id);
      } catch (e) {
        if (!(e instanceof GoogleDisconnectedError)) {
          console.error("[booking] google delete failed:", e instanceof Error ? e.message : e);
        }
      }
    }
    const when = new Date(booking.starts_at).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    });
    await sendPushToUser(admin, booking.user_id, {
      title: "Booking cancelled",
      body: `${booking.visitor_name} — ${when}${actor === "owner" ? " (cancelled by you)" : ""}`,
      url: "/",
    });
    return NextResponse.json({
      status: "cancelled",
      ics: buildIcs({
        bookingId: booking.id,
        title: bookingTitle(details),
        startIso: booking.starts_at,
        endIso: booking.ends_at,
        description: "This meeting was cancelled.",
        meetingUrl: null,
        sequence: 2,
        cancelled: true,
      }),
    });
  }

  // --- reschedule ---
  if (!link?.active) return NextResponse.json({ error: "link_inactive" }, { status: 409 });
  const { startIso } = parsed.data;
  // Availability excludes this booking's own slot (its event row still exists),
  // so drop the old event first, then validate the new time.
  if (booking.event_id) await admin.from("events").delete().eq("id", booking.event_id);
  if (!(await isSlotFree(admin, link, startIso, booking.duration_min))) {
    // Restore the original block so a failed move doesn't lose the meeting.
    const { data: restored } = await admin
      .from("events")
      .insert({
        user_id: booking.user_id,
        title: bookingTitle(details),
        starts_at: booking.starts_at,
        ends_at: booking.ends_at,
        source: "manual",
        meeting_url: joinUrl(details),
        location: locationText(details),
        description: bookingDescription(details),
      })
      .select("id")
      .single();
    if (restored) await admin.from("bookings").update({ event_id: restored.id }).eq("id", booking.id);
    return NextResponse.json({ error: "slot_taken" }, { status: 409 });
  }

  const startsAt = new Date(startIso);
  const endsAt = new Date(startsAt.getTime() + booking.duration_min * 60000);
  const { data: event } = await admin
    .from("events")
    .insert({
      user_id: booking.user_id,
      title: bookingTitle(details),
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      source: "manual",
      meeting_url: joinUrl(details),
      location: locationText(details),
      description: bookingDescription(details),
    })
    .select("id")
    .single();

  const { error: moveError } = await admin
    .from("bookings")
    .update({
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      event_id: event?.id ?? null,
      location_mode: nextLocationMode,
      last_changed_by: actor,
    })
    .eq("id", booking.id);
  if (moveError) {
    if (event) await admin.from("events").delete().eq("id", event.id);
    return NextResponse.json({ error: moveError.code === "23505" ? "slot_taken" : "Reschedule failed" }, { status: 409 });
  }

  if (booking.google_event_id) {
    try {
      const accessToken = await getAccessToken(admin, booking.user_id);
      await updateBookingEventTime(accessToken, booking.google_event_id, {
        startIso: startsAt.toISOString(),
        endIso: endsAt.toISOString(),
        timezone,
      });
    } catch (e) {
      if (!(e instanceof GoogleDisconnectedError)) {
        console.error("[booking] google update failed:", e instanceof Error ? e.message : e);
      }
    }
  }

  const when = startsAt.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });
  await sendPushToUser(admin, booking.user_id, {
    title: "Booking moved",
    body: `${booking.visitor_name} → ${when}${actor === "owner" ? " (moved by you)" : ""}`,
    url: "/",
  });

  return NextResponse.json({
    status: "confirmed",
    startIso: startsAt.toISOString(),
    ics: buildIcs({
      bookingId: booking.id,
      title: bookingTitle(details),
      startIso: startsAt.toISOString(),
      endIso: endsAt.toISOString(),
      description: bookingDescription(details),
      meetingUrl: joinUrl(details),
      location: locationText(details),
      sequence: 1,
    }),
  });
}
