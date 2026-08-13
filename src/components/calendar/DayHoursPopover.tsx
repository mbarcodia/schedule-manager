"use client";

// One day, opened from its date in the calendar header — its hours, and which
// commitment gets its time.
//
// The calendar is where you are when you find out a day is different — a
// conference Friday, a morning taken back, a holiday. Until now the only way to
// say so was to describe the day to the chat while looking straight at it.
//
// Past days are deliberately not editable: a past week is a record of what was
// worked, not a plan, and nothing back there is re-derived from hours (see
// from-db.ts). Changing them would alter nothing and imply otherwise.

import { useState } from "react";
import { XIcon } from "@phosphor-icons/react";
import {
  clearDayHours,
  dayHoursRow,
  saveDayHours,
  timeValue,
  validateDayHours,
  type DayHoursDraft,
} from "@/lib/calendar/day-hours";
import { clearDayFocus, saveDayFocus } from "@/lib/calendar/day-focus";
import { describeDayFocus, focusableProjects } from "@/lib/planner/day-focus-form";
import type { DayWindow } from "@/lib/scheduling/day-window";
import type { Category, DayFocusOutcome, DayOverride, Project } from "@/lib/scheduling/types";

export function DayHoursPopover({
  dateLabel,
  dateKey,
  override,
  standard,
  gday,
  projects,
  categories,
  focuses,
  onClose,
  onSaved,
}: {
  /** "Wed 12 Aug", for the heading. */
  dateLabel: string;
  /** YYYY-MM-DD, the row's key. */
  dateKey: string;
  override: DayOverride | undefined;
  /** That weekday's standard window, or null when the weekday is off. */
  standard: DayWindow | null;
  /** Which day this is on the grid — decides whether a focus is even offerable
   * (weekly hours are never placed at a weekend). */
  gday: number;
  projects: Project[];
  categories: Category[];
  /** What the engine says each of this day's focuses actually did, so the control
   * can report rather than assert. */
  focuses: DayFocusOutcome[];
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const dayIsOffByDefault = standard == null;
  const [draft, setDraft] = useState<DayHoursDraft>({
    mode: override?.closed ? "closed" : "hours",
    startText: timeValue(override?.start ?? standard?.start ?? null),
    endText: timeValue(override?.end ?? standard?.end ?? null),
    allowWeekend: !!override?.allowWeekend || !dayIsOffByDefault,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The focus half writes a DIFFERENT table, so it carries its own busy/error
   * state and saves on change. Folding it into the hours Save button would put two
   * tables behind one click, and a partial failure there reports as success. */
  const [focusBusy, setFocusBusy] = useState<string | null>(null);
  const [focusError, setFocusError] = useState<string | null>(null);

  const errors = validateDayHours(draft, dayIsOffByDefault);
  const hasOverride = override != null;

  async function save() {
    const row = dayHoursRow(draft, dayIsOffByDefault);
    if (!row) {
      setError(errors[0] ?? "Something about that day doesn't add up.");
      return;
    }
    setBusy(true);
    setError(null);
    const message = await saveDayHours(dateKey, row);
    if (message) {
      setBusy(false);
      setError(`Couldn't change that day: ${message}`);
      return;
    }
    await onSaved();
    setBusy(false);
    onClose();
  }

  async function revert() {
    setBusy(true);
    setError(null);
    const message = await clearDayHours(dateKey);
    if (message) {
      setBusy(false);
      setError(`Couldn't reset that day: ${message}`);
      return;
    }
    await onSaved();
    setBusy(false);
    onClose();
  }

  /** Labels that have at least one commitment able to take a day. */
  const focusableGroups = focusableProjects(projects, categories);

  async function setFocus(categoryId: string, projectId: string) {
    setFocusBusy(categoryId);
    setFocusError(null);
    const message = projectId
      ? await saveDayFocus(dateKey, categoryId, projectId)
      : await clearDayFocus(dateKey, categoryId);
    setFocusBusy(null);
    if (message) return setFocusError(message);
    // Not closed on purpose: the sentence under the select is the point, and it
    // only exists once the schedule has been recomputed.
    await onSaved();
  }

  const field =
    "rounded border border-border bg-surface px-1.5 py-1 text-[11px] text-text outline-none focus-visible:border-accent";

  return (
    <div className="absolute left-0 top-full mt-1 z-20 w-[236px] rounded-md border border-border bg-panel p-2.5 shadow-lg flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 text-[11px] text-text">{dateLabel}</div>
        <button onClick={onClose} aria-label="Close" className="text-muted-2 hover:text-text">
          <XIcon size={12} />
        </button>
      </div>

      <label className="flex items-center gap-1.5 text-[11px] text-text">
        <input
          type="radio"
          checked={draft.mode === "hours"}
          onChange={() => setDraft({ ...draft, mode: "hours" })}
        />
        Working these hours
      </label>
      {draft.mode === "hours" && (
        <>
          <div className="flex items-center gap-1.5 pl-5 text-[11px] text-muted">
            <input
              type="time"
              value={draft.startText}
              onChange={(e) => setDraft({ ...draft, startText: e.target.value })}
              className={field}
            />
            <span>to</span>
            <input
              type="time"
              value={draft.endText}
              onChange={(e) => setDraft({ ...draft, endText: e.target.value })}
              className={field}
            />
          </div>
          {/* Belongs to THIS branch, not the closed one: on a day the standard
             hours have switched off, hours alone are ignored. It sat below the
             other radio and read as belonging to it. */}
          {dayIsOffByDefault && (
            <label className="flex items-baseline gap-1.5 text-[11px] text-text pl-5">
              <input
                type="checkbox"
                checked={draft.allowWeekend}
                onChange={(e) => setDraft({ ...draft, allowWeekend: e.target.checked })}
              />
              <span>
                Work this day anyway{" "}
                <span className="text-[10px] text-muted-2">— it&apos;s off in your standard hours</span>
              </span>
            </label>
          )}
        </>
      )}

      <label className="flex items-center gap-1.5 text-[11px] text-text">
        <input
          type="radio"
          checked={draft.mode === "closed"}
          onChange={() => setDraft({ ...draft, mode: "closed" })}
        />
        Nothing scheduled this day
      </label>

      {(error || errors.length > 0) && (
        <div className="text-[10px] leading-snug" style={{ color: "#e5484d" }}>
          {error ?? errors[0]}
        </div>
      )}

      {/* Whose day it is. Separated by a rule and saved on change, because it is a
         different table from the hours above — see the state comment. Offered only
         Mon-Fri: weekly hours are never placed at a weekend, so a control there
         would be one that does nothing. */}
      {gday % 7 <= 4 && focusableGroups.length > 0 && (
        <div className="mt-0.5 pt-2 border-t border-border flex flex-col gap-1.5">
          {focusableGroups.map(({ category, projects: opts }) => {
            const current = focuses.find((f) => f.labelId === category.id);
            return (
              <div key={category.id} className="flex flex-col gap-1">
                <label className="text-[10px] text-muted-2">
                  All <span style={{ color: category.color }}>{category.name}</span> time this day
                </label>
                <select
                  value={current && !current.skipped ? current.projectId : ""}
                  disabled={focusBusy === category.id}
                  onChange={(e) => void setFocus(category.id, e.target.value)}
                  className={field}
                >
                  <option value="">shared out normally</option>
                  {opts.map((p) => (
                    <option key={p.id} value={p.id}>
                      all to {p.title}
                    </option>
                  ))}
                </select>
                {/* The engine's own account of what happened, not a restatement of
                   what was asked for. This is where a day that did NOT become one
                   project says so. */}
                {current && (
                  <div
                    className="text-[10px] leading-snug"
                    style={{ color: current.skipped ? "#e0a94e" : "var(--color-muted, #9397ab)" }}
                  >
                    {describeDayFocus(current)}
                  </div>
                )}
              </div>
            );
          })}
          {focusError && (
            <div className="text-[10px] leading-snug" style={{ color: "#e5484d" }}>
              {focusError}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={busy || errors.length > 0}
          className="rounded-md border border-accent text-accent px-2 py-0.5 text-[10.5px] font-medium hover:bg-accent/10 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {hasOverride && (
          <button onClick={() => void revert()} disabled={busy} className="text-[10px] text-muted-2 hover:text-text">
            back to standard{standard ? ` (${timeValue(standard.start)}–${timeValue(standard.end)})` : ""}
          </button>
        )}
      </div>
    </div>
  );
}
