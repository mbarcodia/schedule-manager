// Day focus: the validation and the wording, in one place.
//
// Same split as routine-form.ts and todo-order.ts, for the same reason. A focus
// can be set by saying it to the chat or by picking a project in the day's
// popover, and those two paths must agree about what is allowed and how it reads
// back — otherwise the chat refuses something the panel accepts, or the two
// describe the same row differently and the user can't tell which is true.
//
// Pure on purpose: no Supabase client, no browser API. That is exactly why
// adjust_day_hours cannot share day-hours.ts today — it imports the browser
// client, so the server tools can't touch it.

import type { Category, DayFocusOutcome, Project } from "@/lib/scheduling/types";

/** Which projects can be handed a day, and under which label.
 *
 * A project qualifies only if it carries weekly hours — a focus redirects
 * weekly-hours time, so a commitment that generates none has nothing to receive.
 * Archived and on-hold ones are out for the same reason a pin refuses them: the
 * engine schedules nothing for either, so the day would sit empty and the setting
 * would look broken rather than declined. */
export function focusableProjects(
  projects: Project[],
  categories: Category[],
): { category: Category; projects: Project[] }[] {
  return categories
    .map((category) => ({
      category,
      projects: projects.filter((p) => p.categoryId === category.id && p.weeklyMinMin && !p.onHold),
    }))
    .filter((g) => g.projects.length > 0);
}

export interface DayFocusDraft {
  /** 0=Mon..6=Sun for the day being set. */
  gday: number;
  categoryId: string;
  /** "" = no focus (clear it). */
  projectId: string;
}

/** What's wrong with a focus before it's written, as sentences. Errors block;
 * warnings are legal but worth saying. */
export function validateDayFocus(
  draft: DayFocusDraft,
  ctx: { projects: Project[]; dayHasHours: boolean },
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  // Clearing is always allowed — there is nothing to validate about removing a
  // setting, and refusing it would trap a focus on a day that later became a
  // weekend or a day off.
  if (!draft.projectId) return { errors, warnings };

  // Weekly hours are only ever generated Mon-Fri, so a weekend focus has nothing
  // to act on. Refused rather than saved-and-ignored.
  if (draft.gday % 7 > 4) {
    errors.push("Weekly hours are only ever placed Monday to Friday, so there's nothing on a weekend to reassign.");
    return { errors, warnings };
  }
  if (!ctx.dayHasHours) {
    errors.push("That day has no working hours, so there's no time on it to give to anything.");
    return { errors, warnings };
  }

  const project = ctx.projects.find((p) => p.id === draft.projectId);
  if (!project) {
    errors.push("That commitment no longer exists.");
    return { errors, warnings };
  }
  if (project.onHold) {
    errors.push(`${project.title} is on hold, so nothing is scheduled for it — take it off hold first.`);
    return { errors, warnings };
  }
  if (project.categoryId !== draft.categoryId) {
    errors.push(`${project.title} isn't in that label, so it can't take that label's time.`);
    return { errors, warnings };
  }
  if (!project.weeklyMinMin) {
    warnings.push(
      `${project.title} has no weekly hours set, so it has no quota to fill — the day's time is additive for it.`,
    );
  }
  return { errors, warnings };
}

const hrs = (min: number): string => `${+(min / 60).toFixed(1)}h`;

/** What a focus did, as a sentence.
 *
 * Says the shortfall as readily as the success, because the whole failure this
 * feature was built out of was a confirmation that read like everything worked
 * while three deadlines slipped. Every branch here names a number. */
export function describeDayFocus(o: DayFocusOutcome): string {
  if (o.skipped) {
    const why: Record<string, string> = {
      weekend: "weekly hours are never placed at a weekend, so there was nothing to reassign",
      day_off: "that day has no working hours",
      unknown_project: "that commitment no longer exists",
      label_mismatch: `${o.projectTitle} isn't in ${o.labelName}`,
      project_on_hold: `${o.projectTitle} is on hold, so nothing is scheduled for it`,
      outside_active_window: `${o.projectTitle} isn't active on that day`,
      nothing_to_reassign: `there was no ${o.labelName} time on that day to reassign — pin it instead if you want time there`,
    };
    return `No change: ${why[o.skipped] ?? o.skipped}.`;
  }

  const parts = [`${hrs(o.placedMin)} of ${o.labelName} on that day is now ${o.projectTitle}`];
  if (o.transferredMin > 0) {
    const names = o.displaced.map((d) => `${d.title} (${hrs(d.min)})`).join(", ");
    parts.push(
      `${hrs(o.transferredMin)} came off ${names} — those hours are still owed and move to other days this week, or get reported short if the week can't hold them`,
    );
  }
  // The two ways the day is not purely one project. Both said out loud: a user who
  // asked for "all of it" and sees another block needs to know why.
  if (o.leftoverTo.length) {
    parts.push(
      `${o.leftoverTo.map((l) => `${l.title} (${hrs(l.min)})`).join(", ")} kept time there because ${o.projectTitle} had no more work to put in it`,
    );
  }
  if (o.pinnedOthers.length) {
    parts.push(`${o.pinnedOthers.join(", ")} stays where you pinned it`);
  }
  if (o.placedMin < o.focusMin) {
    parts.push(`${hrs(o.focusMin - o.placedMin)} of it wouldn't fit the day's gaps`);
  }
  return `${parts.join(". ")}.`;
}
