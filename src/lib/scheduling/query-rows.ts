// Shared row-fetching logic used by the browser client (fetch-schedule-data.ts),
// the server-side chat route, and the admin-client cron routes. Every query is
// explicitly filtered by user_id rather than relying solely on RLS, since the
// cron routes call this with createAdminClient() (no auth session, RLS bypassed
// entirely) to build one user's schedule at a time out of an admin-scoped client.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { RawScheduleRows } from "./from-db";
import { HISTORY_WEEKS, HORIZON_WEEKS } from "./horizon";
import { fetchProgressFacts } from "./logged-hours";

const DAY_MS = 86400000;

export async function queryScheduleRows(
  supabase: SupabaseClient<Database>,
  userId: string,
  now: Date = new Date(),
): Promise<RawScheduleRows> {
  // The profile defaults to UTC at signup (the trigger has no way to know
  // the browser's zone); the browser client syncs it on load. Here we just
  // read whatever's currently stored.
  // Reaches back as far as the calendar can be scrolled, so a past week has its
  // rows. Was a flat fortnight, which is why scrolling back was pointless even
  // once the UI allowed it.
  const windowStart = new Date(now.getTime() - HISTORY_WEEKS * 7 * DAY_MS).toISOString();
  const windowEnd = new Date(now.getTime() + HORIZON_WEEKS * 7 * DAY_MS).toISOString();
  const windowStartDate = windowStart.slice(0, 10);
  const windowEndDate = windowEnd.slice(0, 10);
  /** Yesterday in UTC — the loose lower bound for anything keyed to "not past
   * yet", covering every account timezone regardless of which side of the date
   * line the server clock sits on. */
  const cushionStartDate = new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10);

  const factsPromise = fetchProgressFacts(supabase, userId);

  const [
    profileRes,
    categoriesRes,
    projectsRes,
    targetsRes,
    tasksRes,
    archivedTaskTitlesRes,
    rulesRes,
    routineNotesRes,
    notesRes,
    overridesRes,
    eventsRes,
    progressRes,
    pinnedRes,
    taskPinsRes,
    researchPinsRes,
    dayFocusRes,
    connectionsRes,
  ] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", userId).single(),
    supabase.from("categories").select("*").eq("user_id", userId),
    // Same treatment as archived tasks below: the row, its progress_log history
    // and its targets are all kept, and it is invisible to scheduling, pace and
    // the boards until restored.
    supabase.from("projects").select("*").eq("user_id", userId).is("archived_at", null),
    supabase.from("targets").select("*").eq("user_id", userId).is("deleted_at", null),
    // Archived tasks keep their rows + progress_log history forever, but are
    // invisible to scheduling and the board (the archive view queries them
    // separately with archived_at NOT null).
    supabase.from("tasks").select("*").eq("user_id", userId).is("archived_at", null),
    // Titles only, for the archived ones the query above drops. Completing a
    // task archives it, so its own logged block would otherwise redraw itself
    // as the placeholder "Work" (from-db's historyBlocks/currentWeekFallback)
    // the instant it was ticked off. Two columns of every finished task is a
    // cheap query; nothing here re-enters scheduling.
    supabase.from("tasks").select("id,title").eq("user_id", userId).not("archived_at", "is", null),
    supabase.from("recurring_rules").select("*").eq("user_id", userId),
    // Routine notes still worth saying: anything whose window hasn't closed and
    // hasn't opened beyond the horizon. The bound here is deliberately one day
    // loose on each side, because the account's timezone is in the profile row
    // being fetched in this same batch and so isn't known yet — whether a note
    // has expired "today" is decided later, in the account's own zone, where
    // that is knowable (system-prompt.ts). A day of slack costs a handful of
    // small rows; getting it wrong here would silently drop a note on its last
    // day for anyone east of UTC.
    supabase
      .from("routine_notes")
      .select("*")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .gte("ends_on", cushionStartDate)
      .lte("starts_on", windowEndDate),
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
      .is("deleted_at", null)
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
    // Exact slots tasks are fixed to (migration 0047). Bounded like the pins
    // below: a row outside the visible window can no longer be placed, and
    // from-db drops it anyway.
    supabase
      .from("task_pins")
      .select("*")
      .eq("user_id", userId)
      .gte("pinned_date", windowStartDate)
      .lte("pinned_date", windowEndDate),
    supabase
      .from("research_pins")
      .select("*")
      .eq("user_id", userId)
      .gte("pinned_date", windowStartDate)
      .lte("pinned_date", windowEndDate),
    // Days where one label's hours all go to one project. Same date bounding as
    // the pins above; rows for dates outside the window are ignored rather than
    // cleaned up, so nothing has to sweep them.
    supabase
      .from("day_focus")
      .select("*")
      .eq("user_id", userId)
      .gte("focus_date", windowStartDate)
      .lte("focus_date", windowEndDate),
    supabase.from("calendar_connections").select("*").eq("user_id", userId),
  ]);

  for (const res of [
    profileRes,
    categoriesRes,
    projectsRes,
    targetsRes,
    tasksRes,
    archivedTaskTitlesRes,
    rulesRes,
    routineNotesRes,
    notesRes,
    overridesRes,
    eventsRes,
    progressRes,
    pinnedRes,
    taskPinsRes,
    researchPinsRes,
    dayFocusRes,
    connectionsRes,
  ]) {
    if (res.error) throw res.error;
  }

  const progressFacts = await factsPromise;

  return {
    profile: profileRes.data!,
    categories: categoriesRes.data ?? [],
    projects: projectsRes.data ?? [],
    targets: targetsRes.data ?? [],
    tasks: tasksRes.data ?? [],
    archivedTaskTitles: archivedTaskTitlesRes.data ?? [],
    recurringRules: rulesRes.data ?? [],
    routineNotes: routineNotesRes.data ?? [],
    preferenceNotes: notesRes.data ?? [],
    dayOverrides: overridesRes.data ?? [],
    events: eventsRes.data ?? [],
    progressLog: progressRes.data ?? [],
    pinnedChunks: pinnedRes.data ?? [],
    taskPins: taskPinsRes.data ?? [],
    researchPins: researchPinsRes.data ?? [],
    dayFocus: dayFocusRes.data ?? [],
    calendarConnections: connectionsRes.data ?? [],
    progressFacts,
  };
}
