// Shared row-fetching logic used by both the browser client
// (fetch-schedule-data.ts) and the server-side chat route — same queries,
// different Supabase client instance (RLS scopes both to the caller).

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
  ] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", userId).single(),
    supabase.from("categories").select("*"),
    supabase.from("projects").select("*"),
    supabase.from("proposals").select("*"),
    supabase.from("goals").select("*"),
    supabase.from("tasks").select("*"),
    supabase.from("recurring_rules").select("*"),
    supabase.from("preference_notes").select("*"),
    supabase
      .from("day_overrides")
      .select("*")
      .gte("override_date", windowStartDate)
      .lte("override_date", windowEndDate),
    supabase.from("events").select("*").gte("starts_at", windowStart).lte("starts_at", windowEnd),
    supabase
      .from("progress_log")
      .select("*")
      .gte("occurred_date", windowStartDate)
      .lte("occurred_date", windowEndDate),
    supabase
      .from("pinned_chunks")
      .select("*")
      .gte("occurred_date", windowStartDate)
      .lte("occurred_date", windowEndDate),
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
  };
}
