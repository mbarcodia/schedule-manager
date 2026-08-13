// Writing a day's focus from the browser.
//
// Split from day-focus-form.ts, which is pure, because that one is imported by the
// chat tools running on the server and must never pull in a Supabase browser
// client. The same split exists between day-hours.ts and the adjust_day_hours
// tool, and this is the reason for it.

import { createClient } from "@/lib/supabase/client";

/** Gives one label's time on one date to one project. Upserts on the label, so
 * re-choosing replaces rather than accumulating — and Research and Teaching on the
 * same date are independent rows.
 *
 * `date` is a YYYY-MM-DD key built from LOCAL parts (use dateKey from
 * day-hours.ts). Never toISOString: that converts to UTC first and lands a day
 * early west of Greenwich, which is how date-only columns have gone wrong here
 * before. */
export async function saveDayFocus(
  date: string,
  categoryId: string,
  projectId: string,
): Promise<string | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "You appear to be signed out — reload and try again.";
  const { error } = await supabase
    .from("day_focus")
    .upsert(
      { user_id: user.id, focus_date: date, category_id: categoryId, project_id: projectId },
      { onConflict: "user_id,focus_date,category_id" },
    );
  return error?.message ?? null;
}

/** Back to sharing that day's time across the label's commitments normally. A real
 * delete, not a tombstone: this is a setting about a day, not something the user
 * authored, so it needs no Trash entry (see migration 0046). */
export async function clearDayFocus(date: string, categoryId: string): Promise<string | null> {
  const supabase = createClient();
  const { error } = await supabase
    .from("day_focus")
    .delete()
    .match({ focus_date: date, category_id: categoryId });
  return error?.message ?? null;
}
