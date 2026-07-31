import type { SupabaseClient } from "@supabase/supabase-js";
import type { AllDayMode, CalendarProvider, Database, EventSource } from "@/lib/supabase/database.types";
import { fetchIcsEvents } from "./ics";

const HORIZON_WEEKS = 12;

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
    // calendars are full of banners that must not consume time.
    const events = await fetchIcsEvents(
      connection.ics_url,
      horizonStart,
      horizonEnd,
      connection.all_day_mode !== "ignore",
    );
    const source = SOURCE_BY_PROVIDER[connection.provider];

    const { error: deleteError } = await supabase.from("events").delete().eq("connection_id", connection.id);
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

    await supabase
      .from("calendar_connections")
      .update({ last_synced_at: new Date().toISOString(), last_sync_error: null, last_sync_event_count: events.length })
      .eq("id", connection.id);

    return { ok: true, count: events.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from("calendar_connections")
      .update({ last_synced_at: new Date().toISOString(), last_sync_error: message })
      .eq("id", connection.id);
    return { ok: false, error: message };
  }
}
