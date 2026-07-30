// When a to-do list's chase period is closing.
//
// Kept out of the route file so the date edge cases — leap February, the last
// day of a 30- vs 31-day month, the turn of the year — can be tested directly
// rather than only by waiting for December.

import type { ZonedNow } from "@/lib/scheduling/time";
import type { ChaseCadence } from "@/lib/supabase/database.types";

/** Fires in the user's own evening rather than at UTC midnight, so "end of the
 * week" means what they would mean by it. */
export const CHASE_MINUTE_OF_DAY = 17 * 60; // 5pm local

/** Whether this local moment is the closing stretch of the given period. */
export function isPeriodEnd(cadence: ChaseCadence, z: ZonedNow): boolean {
  if (z.minuteOfDay < CHASE_MINUTE_OF_DAY) return false;
  if (cadence === "week") return z.weekdayIdx === 6; // Sunday
  // Day 0 of the following month is the last day of this one — and passing the
  // real year matters, or February is wrong every leap year.
  if (cadence === "month") return z.day === new Date(z.year, z.month, 0).getDate();
  return z.month === 12 && z.day === 31;
}

/** Start of the current period, so one chase per period is enforceable against
 * todo_lists.last_chased_at. */
export function periodStart(cadence: ChaseCadence, now: Date): number {
  const d = new Date(now);
  if (cadence === "week") d.setDate(d.getDate() - 7);
  else if (cadence === "month") d.setMonth(d.getMonth() - 1);
  else d.setFullYear(d.getFullYear() - 1);
  return d.getTime();
}
