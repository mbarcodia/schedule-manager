// Shared row-fetching logic used by the browser client (fetch-schedule-data.ts),
// the server-side chat route, and the admin-client cron routes. Every query is
// explicitly filtered by user_id rather than relying solely on RLS, since the
// cron routes call this with createAdminClient() (no auth session, RLS bypassed
// entirely) to build one user's schedule at a time out of an admin-scoped client.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { RawScheduleRows } from "./from-db";

const HORIZON_WEEKS = 12;
const DAY_MS = 86400000;

export async function queryScheduleRows(
  supabase: SupabaseClient<Database>,
  userId: string,
  now: Date = new Date(),
): Promise<RawScheduleRows> {
  // The profile defaults to UTC at signup (the trigger has no way to know
  // the browser's zone); the browser client syncs it on load. Here we just
  // read whatever's currently stored.
  const windowStart = new Date(now.getTime() - 14 * DAY_MS).toISOString();
  const windowEnd = new Date(now.getTime() + HORIZON_WEEKS * 7 * DAY_MS).toISOString();
  const windowStartDate = windowStart.slice(0, 10);
  const windowEndDate = windowEnd.slice(0, 10);

  const [
    profileRes,
    categoriesRes,
    projectsRes,
    proposalsRes,
    goalsRes,
    tasksRes,
    rulesRes,
    notesRes,
    overridesRes,
    eventsRes,
    progressRes,
    pinnedRes,
    connectionsRes,
  ] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", userId).single(),
    supabase.from("categories").select("*").eq("user_id", userId),
    supabase.from("projects").select("*").eq("user_id", userId),
    supabase.from("proposals").select("*").eq("user_id", userId),
    supabase.from("goals").select("*").eq("user_id", userId),
    supabase.from("tasks").select("*").eq("user_id", userId),
    supabase.from("recurring_rules").select("*").eq("user_id", userId),
    supabase.from("preference_notes").select("*").eq("user_id", userId),
    supabase
      .from("day_overrides")
      .select("*")
      .eq("user_id", userId)
      .gte("override_date", windowStartDate)
      .lte("override_date", windowEndDate),
    supabase
      .from("events")
      .select("*")
      .eq("user_id", userId)
      .gte("starts_at", windowStart)
      .lte("starts_at", windowEnd),
    supabase
      .from("progress_log")
      .select("*")
      .eq("user_id", userId)
      .gte("occurred_date", windowStartDate)
      .lte("occurred_date", windowEndDate),
    supabase
      .from("pinned_chunks")
      .select("*")
      .eq("user_id", userId)
      .gte("occurred_date", windowStartDate)
      .lte("occurred_date", windowEndDate),
    supabase.from("calendar_connections").select("*").eq("user_id", userId),
  ]);

  for (const res of [
    profileRes,
    categoriesRes,
    projectsRes,
    proposalsRes,
    goalsRes,
    tasksRes,
    rulesRes,
    notesRes,
    overridesRes,
    eventsRes,
    progressRes,
    pinnedRes,
    connectionsRes,
  ]) {
    if (res.error) throw res.error;
  }

  return {
    profile: profileRes.data!,
    categories: categoriesRes.data ?? [],
    projects: projectsRes.data ?? [],
    proposals: proposalsRes.data ?? [],
    goals: goalsRes.data ?? [],
    tasks: tasksRes.data ?? [],
    recurringRules: rulesRes.data ?? [],
    preferenceNotes: notesRes.data ?? [],
    dayOverrides: overridesRes.data ?? [],
    events: eventsRes.data ?? [],
    progressLog: progressRes.data ?? [],
    pinnedChunks: pinnedRes.data ?? [],
    calendarConnections: connectionsRes.data ?? [],
  };
}
