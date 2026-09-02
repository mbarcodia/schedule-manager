import type { SupabaseClient } from "@supabase/supabase-js";
import type { AllDayMode, CalendarProvider, Database, EventSource } from "@/lib/supabase/database.types";
import { fetchIcsEvents } from "./ics";
import { HORIZON_WEEKS } from "@/lib/scheduling/horizon";
import { logWrite } from "@/lib/planner/write";

const SOURCE_BY_PROVIDER: Record<CalendarProvider, EventSource> = {
  outlook_ics: "outlook",
  icloud_ics: "icloud",
  google_ics: "google",
};

export interface ConnectionRow {
  id: string;
  user_id: string;
  provider: CalendarProvider;
  ics_url: string;
  all_day_mode: AllDayMode;
}

/** Fetches one connection's feed and replaces exactly that connection's
 * synced events (delete-then-insert) — simplest correct way to reflect
 * cancellations/edits without diffing, and safe because connection_id
 * scopes the delete to only this feed's own rows. */
export async function syncConnection(
  supabase: SupabaseClient<Database>,
  connection: ConnectionRow,
): Promise<{ ok: boolean; count?: number; error?: string }> {
  const horizonStart = new Date();
  horizonStart.setDate(horizonStart.getDate() - 1);
  const horizonEnd = new Date();
  horizonEnd.setDate(horizonEnd.getDate() + HORIZON_WEEKS * 7);

  try {
    // All-day entries are only fetched when this calendar has opted in; most
    // calendars are full of banners that must not consume time. Their day
    // boundaries are the ACCOUNT'S midnight, not the server's — this runs on
    // Vercel in UTC, so using the process timezone shifted every all-day event
    // onto the evening before.
    const includeAllDay = connection.all_day_mode !== "ignore";
    // Read unconditionally. This used to be fetched only for a calendar with
    // all-day entries, leaving every other feed to default to "UTC" — which is
    // also the last-resort zone for a time the feed doesn't pin down, so the
    // fallback would have landed on the server's zone by another route.
    const { data: profile } = await supabase
      .from("profiles")
      .select("timezone")
      .eq("id", connection.user_id)
      .maybeSingle();
    const timeZone = profile?.timezone || "UTC";

    const { events, resolutions, floatingCount } = await fetchIcsEvents(
      connection.ics_url,
      horizonStart,
      horizonEnd,
      includeAllDay,
      timeZone,
    );
    const source = SOURCE_BY_PROVIDER[connection.provider];

    // Scoped to the range just re-fetched, NOT the whole connection. Deleting
    // everything meant each sync wiped every synced meeting older than
    // horizonStart (yesterday), so the calendar had no history to scroll back
    // through — the rows were being thrown away hourly. Now anything before the
    // window is left alone and accumulates as a record of what the week held.
    const { error: deleteError } = await supabase
      .from("events")
      .delete()
      .eq("connection_id", connection.id)
      .gte("starts_at", horizonStart.toISOString());
    if (deleteError) throw deleteError;

    if (events.length > 0) {
      const { error: insertError } = await supabase.from("events").insert(
        events.map((e) => ({
          user_id: connection.user_id,
          title: e.title,
          starts_at: e.startsAt.toISOString(),
          ends_at: e.endsAt.toISOString(),
          source,
          all_day: e.allDay,
          external_id: e.uid,
          connection_id: connection.id,
          description: e.description,
          location: e.location,
          meeting_url: e.meetingUrl,
        })),
      );
      if (insertError) throw insertError;
    }

    await logWrite(
      `sync: recording success for connection ${connection.id}`,
      supabase
        .from("calendar_connections")
        .update({
          last_synced_at: new Date().toISOString(),
          last_sync_error: null,
          last_sync_event_count: events.length,
        })
        .eq("id", connection.id),
    );

    // A zone that had to be guessed is not an error, but it must not be
    // invisible either — this is what Settings shows, so a feed that stopped
    // saying what its times mean is noticed before the booking link acts on it.
    //
    // Written SEPARATELY and best-effort on purpose. It is a note about the
    // sync, not part of it, and folding it into the update above would make a
    // cosmetic column load-bearing: on a deployment where migration 0048 has
    // not landed yet, the whole update fails, the sync records itself as
    // broken, and the booking link pauses over a missing annotation. Recording
    // less than everything beats taking the calendar down.
    const notes = resolutions.filter((r) => r.warning).map((r) => r.warning!);
    if (floatingCount > 0) {
      notes.push(`${floatingCount} time${floatingCount === 1 ? "" : "s"} carried no timezone; read as ${timeZone}`);
    }
    const { error: noteError } = await supabase
      .from("calendar_connections")
      .update({ last_sync_tz_note: notes.length > 0 ? notes.join("; ") : null })
      .eq("id", connection.id);
    if (noteError) {
      console.warn(`[sync] could not record the timezone note for ${connection.id}: ${noteError.message}`);
    }

    return { ok: true, count: events.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Recording the FAILURE is the one that matters most: last_sync_error is
    // what Settings and the calendar's Sync button read to say a feed is broken,
    // so dropping it turns a visible breakage into a silent one.
    await logWrite(
      `sync: recording failure for connection ${connection.id}`,
      supabase
        .from("calendar_connections")
        .update({ last_synced_at: new Date().toISOString(), last_sync_error: message })
        .eq("id", connection.id),
    );
    return { ok: false, error: message };
  }
}
