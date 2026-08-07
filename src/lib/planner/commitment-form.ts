// Validation for the commitment panel, kept out of the component so the edges
// are testable — same reason chase.ts holds the date arithmetic for list chasing
// rather than the route that calls it.
//
// The panel now writes the same columns the chat tools write, which is the point:
// a word dump into the chat and typing into the panel are two ways to do one job.
// But it means the panel has to respect a rule the chat depends on and the
// database does not enforce — see DUPLICATE TITLES below.

/** Hours as typed. Empty means "no figure", which is a legitimate answer for
 * every one of these fields and must not become 0. */
export function parseHours(text: string): { minutes: number | null; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed) return { minutes: null, error: null };
  const hours = Number(trimmed);
  if (!Number.isFinite(hours)) return { minutes: null, error: `"${trimmed}" isn't a number of hours.` };
  // The columns are `check (... > 0)`, so a zero would be rejected by Postgres
  // with a constraint message no one can act on. Say what's meant instead:
  // leaving it empty is how you say "unknown".
  if (hours <= 0) return { minutes: null, error: "Hours have to be more than zero — leave it empty for “not known”." };
  return { minutes: Math.round(hours * 60), error: null };
}

/** Minutes back to a field value, without trailing zeros: 90 -> "1.5", 240 -> "4". */
export const hoursValue = (minutes: number | null | undefined): string =>
  minutes == null ? "" : String(+(minutes / 60).toFixed(2));

export interface TargetDraft {
  /** Absent for a row being added. */
  id?: string;
  title: string;
  date: string;
  dateKind: "hard" | "goal";
  hoursText: string;
}

/** Chat's add_target and plan_phases find an existing target by normalising its
 * title within the commitment: re-using a title MOVES that target rather than
 * making a second one. Two targets with the same title would make that lookup
 * pick one arbitrarily, so the panel must not create the situation — the
 * database has no unique constraint to fall back on. */
export const normTargetTitle = (title: string) => title.trim().toLowerCase().replace(/\s+/g, " ");

export interface FormProblems {
  /** Blocks saving. */
  errors: string[];
  /** Saved anyway — a figure that looks wrong is still the user's to hold. */
  warnings: string[];
}

export function validateCommitmentForm(input: {
  estimateText: string;
  weeklyText: string;
  deadlineDate: string;
  /** The window the weekly hours apply inside. Either end may be empty. */
  activeFrom?: string;
  activeUntil?: string;
  targets: TargetDraft[];
}): FormProblems {
  const errors: string[] = [];
  const warnings: string[] = [];

  const estimate = parseHours(input.estimateText);
  if (estimate.error) errors.push(`Total work: ${estimate.error}`);
  const weekly = parseHours(input.weeklyText);
  if (weekly.error) errors.push(`Hours a week: ${weekly.error}`);

  // An inverted window is silently nothing: the engine asks for hours inside it
  // and no day qualifies, so the commitment simply stops generating time with no
  // sign of why. Refused rather than warned about for that reason.
  const from = input.activeFrom ?? "";
  const until = input.activeUntil ?? "";
  if (from && until && from > until) {
    errors.push("The hours stop applying before they start — swap those two dates.");
  }
  // Legal, and almost always a mistake worth seeing: hours that run out before
  // the date they were meant to reach.
  if (until && input.deadlineDate && until < input.deadlineDate) {
    warnings.push(
      "The weekly hours stop before the finish-by date, so nothing is booked for the last stretch of it.",
    );
  }
  if ((from || until) && !parseHours(input.weeklyText).minutes) {
    warnings.push("An active window only bounds weekly hours, and this commitment carries none — it changes nothing.");
  }

  const seen = new Map<string, number>();
  let phaseSum = 0;
  let everyPhaseCosted = input.targets.length > 0;

  input.targets.forEach((t, i) => {
    const where = t.title.trim() ? `“${t.title.trim()}”` : `date ${i + 1}`;
    if (!t.title.trim()) errors.push(`${where} needs a name — it's what the pace line says out loud.`);
    if (!t.date) errors.push(`${where} needs a date.`);

    const hours = parseHours(t.hoursText);
    if (hours.error) errors.push(`${where}: ${hours.error}`);
    if (hours.minutes == null) everyPhaseCosted = false;
    else phaseSum += hours.minutes;

    const key = normTargetTitle(t.title);
    if (key) {
      const first = seen.get(key);
      if (first != null) errors.push(`Two dates are both called ${where} — the chat picks one by name, so they can't match.`);
      else seen.set(key, i);
    }

    if (t.date && input.deadlineDate && t.date > input.deadlineDate) {
      warnings.push(`${where} is after the finish-by date — a checkpoint past the end won't be measured against.`);
    }
  });

  // Only worth saying when the phases are meant to add up to the whole: a
  // partially costed sequence isn't claiming to.
  if (everyPhaseCosted && estimate.minutes != null && phaseSum > estimate.minutes) {
    warnings.push(
      `The dates add up to ${+(phaseSum / 60).toFixed(1)}h, more than the ${+(estimate.minutes / 60).toFixed(1)}h total — ` +
        `pace will use the phase figures, so the total is the one to revise.`,
    );
  }
  if (everyPhaseCosted && estimate.minutes != null && phaseSum < estimate.minutes) {
    warnings.push(
      `The dates account for ${+(phaseSum / 60).toFixed(1)}h of ${+(estimate.minutes / 60).toFixed(1)}h — ` +
        `the rest is measured against the finish-by date.`,
    );
  }

  return { errors, warnings };
}
