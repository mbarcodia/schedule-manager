// Did you keep up, week after week?
//
// Weekly hours are a lead measure: they say what you did, not what you finished,
// and they're the thing actually under your control each week. Making the run of
// them visible is the point — a broken run is legible in a way "you are 6 hours
// behind" is not.
//
// Two honest limitations, both stated rather than papered over:
//
//   The minimum has no history. Only its CURRENT value is stored, so every past
//   week is judged against today's figure. Raising a minimum will therefore turn
//   some past weeks from hit to missed. Recording per-week targets would fix it
//   and is not worth a table yet.
//
//   Weeks are bucketed by the BROWSER's local Monday, while the engine's grid
//   uses the account timezone. These agree in practice — fetch-schedule-data
//   syncs the stored timezone to the browser's on load — but a session in a
//   different zone from the stored one could bucket a boundary day either side.
//
//   "Away" is inferred. Which past weeks were travel isn't recoverable — events
//   are only fetched a fortnight back — so a week in which NOTHING was logged
//   anywhere on the account is treated as a week you weren't working, and
//   skipped rather than counted as missed. That is a guess, but a better one
//   than marking a fortnight of leave as five failures.

export type WeekMark = "hit" | "missed" | "skipped" | "before";

export interface CommitmentStreak {
  projectId: string;
  /** Oldest first, one per week, ending with the current week. */
  marks: WeekMark[];
  /** Consecutive hits ending at the most recent judged week. Weeks that were
   * skipped don't break it — they aren't weeks you failed. */
  current: number;
  /** Best run in the window, for when the current one is 0 and a bare zero
   * would be needlessly bleak. */
  best: number;
}

export const STREAK_WEEKS = 8;

/** Monday 00:00 of the week containing `d`, in local time — the same week
 * boundary the scheduler's grid uses (gday 0 = Monday). */
export function weekStart(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (out.getDay() + 6) % 7; // 0 = Monday
  out.setDate(out.getDate() - dow);
  return out;
}

export interface StreakInputs {
  /** Any logged work, with the date it happened and the commitment it belongs
   * to — null for routines and unlinked work, which still prove the week was a
   * working one. */
  logged: { occurredDate: Date; projectId: string | null; minutes: number }[];
  commitments: { id: string; weeklyMinMin?: number | null; createdAt?: Date | null }[];
  now: Date;
  weeks?: number;
}

export function computeStreaks(inputs: StreakInputs): CommitmentStreak[] {
  const weeks = inputs.weeks ?? STREAK_WEEKS;
  const thisWeek = weekStart(inputs.now);

  // Oldest first, so the marks read left-to-right like a calendar.
  const windowStarts: Date[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(thisWeek);
    d.setDate(d.getDate() - i * 7);
    windowStarts.push(d);
  }

  const key = (d: Date) => weekStart(d).getTime();
  const byWeekProject = new Map<string, number>();
  const anyWorkInWeek = new Set<number>();
  for (const row of inputs.logged) {
    if (row.minutes <= 0) continue;
    const wk = key(row.occurredDate);
    anyWorkInWeek.add(wk);
    if (!row.projectId) continue;
    const k = `${wk}:${row.projectId}`;
    byWeekProject.set(k, (byWeekProject.get(k) ?? 0) + row.minutes);
  }

  return inputs.commitments.map((c) => {
    const min = c.weeklyMinMin ?? 0;
    const marks: WeekMark[] = windowStarts.map((ws) => {
      const wk = ws.getTime();
      // Before the commitment existed there is nothing to have kept up with.
      if (c.createdAt && weekStart(c.createdAt).getTime() > wk) return "before";
      if (!anyWorkInWeek.has(wk)) return "skipped";
      if (!min) return "skipped"; // no minimum set — nothing to measure against
      return (byWeekProject.get(`${wk}:${c.id}`) ?? 0) >= min ? "hit" : "missed";
    });

    // Current run: walk back from the end, stepping over skipped/before weeks.
    let current = 0;
    for (let i = marks.length - 1; i >= 0; i--) {
      if (marks[i] === "skipped" || marks[i] === "before") continue;
      if (marks[i] === "hit") current++;
      else break;
    }
    let best = 0;
    let run = 0;
    for (const m of marks) {
      if (m === "skipped" || m === "before") continue;
      if (m === "hit") {
        run++;
        best = Math.max(best, run);
      } else run = 0;
    }
    return { projectId: c.id, marks, current, best };
  });
}

/** The marks as characters, used by the card and repeated verbatim to the chat so
 * both describe the same run. */
export function streakGlyphs(marks: WeekMark[]): string {
  return marks.map((m) => (m === "hit" ? "●" : m === "missed" ? "○" : m === "skipped" ? "–" : " ")).join(" ");
}
