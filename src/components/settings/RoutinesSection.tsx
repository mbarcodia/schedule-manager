"use client";

// Settings section for routines — the standing weekly slots that make up a
// normal week, alongside the standard hours they sit inside.
//
// These existed only as a chat tool (update_recurring), so five rows were
// shaping every scheduled week with nothing on screen to show them, let alone
// change them. Both paths write the same columns; the arithmetic and the wording
// live in lib/planner/routine-form.ts so they can be tested without a browser.

import { useCallback, useEffect, useState } from "react";
import { PlusIcon, TrashIcon, CheckIcon } from "@phosphor-icons/react";
import { createClient } from "@/lib/supabase/client";
import { writeError } from "@/lib/planner/write";
import { softDelete } from "@/lib/db/soft-delete";
import {
  ROUTINE_DAYS,
  describeRoutine,
  routineDraft,
  routineRow,
  validateRoutine,
  type RoutineDraft,
  type RoutinePlacement,
} from "@/lib/planner/routine-form";
import {
  describeWindow,
  hasExpired,
  isActiveOn,
  nextWeekWindow,
  validateNote,
  windowFromText,
  type RoutineNoteRow,
} from "@/lib/planner/routine-notes";
import { localDateKey } from "@/lib/scheduling/time";
import { useConfirmDialog } from "@/components/ui/useConfirmDialog";
import type { Database } from "@/lib/supabase/database.types";

type RoutineRow = Database["public"]["Tables"]["recurring_rules"]["Row"];
type CategoryRow = Database["public"]["Tables"]["categories"]["Row"];

const PLACEMENTS: { id: RoutinePlacement; label: string; hint: string }[] = [
  { id: "fixed", label: "At a set time", hint: "it holds that slot" },
  { id: "window", label: "Somewhere in a window", hint: "the scheduler picks when, inside it" },
  // No clock time of their own: they follow the day's hours, so moving a day's
  // start moves them with it and no work can be placed in front of them.
  { id: "day_start", label: "First thing in the day", hint: "starts when the day does, whenever that is" },
  { id: "day_end", label: "Last thing in the day", hint: "ends when the day does" },
  { id: "anywhere", label: "Wherever it fits", hint: "anywhere in that day's working hours" },
];

const blankDraft = (): RoutineDraft => ({
  title: "",
  days: [0, 1, 2, 3, 4],
  lengthText: "30",
  placement: "anywhere",
  startText: "",
  endText: "",
  categoryId: "",
});

export function RoutinesSection({ categories }: { categories: CategoryRow[] }) {
  const [rows, setRows] = useState<RoutineRow[] | null>(null);
  const [notes, setNotes] = useState<RoutineNoteRow[]>([]);
  const [draft, setDraft] = useState<RoutineDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDialog, ask] = useConfirmDialog();

  const load = useCallback(async () => {
    const supabase = createClient();
    const [{ data }, { data: noteRows }] = await Promise.all([
      supabase.from("recurring_rules").select("*").order("created_at"),
      supabase.from("routine_notes").select("*").is("deleted_at", null).order("starts_on"),
    ]);
    setRows(data ?? []);
    setNotes(noteRows ?? []);
  }, []);

  useEffect(() => {
    // Fetch-on-mount, same pattern (and lint caveat) as the other sections.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const problems = draft ? validateRoutine(draft) : { errors: [], warnings: [] };

  async function save() {
    if (!draft) return;
    const row = routineRow(draft);
    if (!row) {
      setError(problems.errors[0] ?? "Something in that routine doesn't add up.");
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = createClient();
    if (draft.id) {
      const { error: err } = await supabase.from("recurring_rules").update(row).eq("id", draft.id);
      if (err) {
        setBusy(false);
        setError(`Couldn't save that routine: ${err.message}`);
        return;
      }
    } else {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setBusy(false);
        setError("You appear to be signed out — reload and try again.");
        return;
      }
      // tag defaults to "anchor" and means nothing since labels absorbed the
      // block names; update_recurring writes the same value.
      const { error: err } = await supabase.from("recurring_rules").insert({ user_id: user.id, tag: "anchor", ...row });
      if (err) {
        setBusy(false);
        setError(`Couldn't add that routine: ${err.message}`);
        return;
      }
    }
    await load();
    setBusy(false);
    setDraft(null);
  }

  async function remove(row: RoutineRow) {
    // Its notes go with it and do NOT land in the Trash — recurring_rules has no
    // deleted_at, so the routine_id cascade destroys them (migration 0044). Said
    // with a count first, because this is the last path in the app that can
    // silently lose typed text.
    const attached = notes.filter((n) => n.routine_id === row.id).length;
    if (attached > 0) {
      const ok = await ask({
        title: `Remove “${row.title}”?`,
        lines: [
          `${attached} note${attached === 1 ? "" : "s"} attached to it, destroyed with it`,
        ],
        footnote:
          "Unlike everything else in this app, routine notes do not go to the Trash — this cannot be undone. A backup taken before now would still have them (npm run backup).",
        confirmLabel: "Remove it",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error: err } = await supabase.from("recurring_rules").delete().eq("id", row.id);
    if (err) setError(`Couldn't remove “${row.title}”: ${err.message}`);
    else await load();
    setBusy(false);
    if (draft?.id === row.id) setDraft(null);
  }

  const field =
    "rounded border border-border bg-surface px-1.5 py-1 text-text text-xs outline-none focus-visible:border-accent";

  return (
    <div className="mt-8 pt-5 border-t border-border">
      {confirmDialog}
      <h2 id="routines" className="text-base font-medium mb-1 scroll-mt-4">
        Routines
      </h2>
      <p className="text-xs text-muted mb-4">
        The standing slots in a normal week — email time, lunch, a weekly lit scan. They are placed before any
        flexible work, so everything else fits around them, and they don&apos;t count against a
        commitment&apos;s weekly hours. Weekdays only: the scheduler never places one at a weekend, so offering
        Saturday here would be a control that quietly does nothing.
      </p>

      {rows === null ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) =>
            draft?.id === row.id ? (
              <RoutineEditor
                key={row.id}
                draft={draft}
                setDraft={setDraft}
                onSave={() => void save()}
                onCancel={() => setDraft(null)}
                busy={busy}
                problems={problems}
                field={field}
                categories={categories}
              />
            ) : (
              <div key={row.id} className="rounded-md border border-border bg-panel px-3 py-2">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setDraft(routineDraft(row))}
                    className="flex-1 min-w-0 text-left"
                    title="Change this routine"
                  >
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-xs text-text">{row.title}</span>
                      {(() => {
                        const cat = categories.find((c) => c.id === row.category_id);
                        return cat ? (
                          <span className="text-[9.5px] tracking-wide uppercase" style={{ color: cat.color }}>
                            {cat.name}
                          </span>
                        ) : null;
                      })()}
                    </div>
                    <div className="text-[11px] text-muted">{describeRoutine(row)}</div>
                  </button>
                  <button
                    onClick={() => void remove(row)}
                    disabled={busy}
                    title="Remove this routine"
                    className="flex-none text-muted hover:text-text disabled:opacity-50"
                  >
                    <TrashIcon size={13} />
                  </button>
                </div>
                <RoutineNotes
                  routine={row}
                  notes={notes.filter((n) => n.routine_id === row.id)}
                  onChanged={load}
                  onError={setError}
                />
              </div>
            ),
          )}

          {rows.length === 0 && !draft && <p className="text-xs text-muted">No routines yet.</p>}

          {draft && !draft.id && (
            <RoutineEditor
              draft={draft}
              setDraft={setDraft}
              onSave={() => void save()}
              onCancel={() => setDraft(null)}
              busy={busy}
              problems={problems}
              field={field}
              categories={categories}
            />
          )}

          {!draft && (
            <button
              onClick={() => setDraft(blankDraft())}
              className="self-start flex items-center gap-1 text-xs text-muted hover:text-text"
            >
              <PlusIcon size={12} /> add a routine
            </button>
          )}

          {error && (
            <div className="text-[11px]" style={{ color: "#e5484d" }}>
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The notes on one routine: what to do in it, for a stretch of days.
 *
 * The panel half of add_routine_note. It exists because the chat must never be
 * the only way to set something — but the two paths are not merely equivalent
 * here, they parse identically: the quick buttons call windowFromText with the
 * same phrases the chat accepts, so "next week" typed here and "next week" said
 * to the chat cannot drift into meaning different weeks.
 *
 * Sorted by state rather than by date, because the question this list answers is
 * "what am I about to be reminded of": what's live now, then what's coming, and
 * the closed ones folded away behind a count since a note going quiet is the
 * whole point of the feature and re-showing them would undo it. */
function RoutineNotes({
  routine,
  notes,
  onChanged,
  onError,
}: {
  routine: RoutineRow;
  notes: RoutineNoteRow[];
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [body, setBody] = useState("");
  const [whenText, setWhenText] = useState("next week");
  const [showPast, setShowPast] = useState(false);
  const [busy, setBusy] = useState(false);

  const today = new Date();
  const todayKey = localDateKey(today);
  const live = notes.filter((n) => !n.done_at && !hasExpired(n, todayKey));
  const past = notes.filter((n) => n.done_at || hasExpired(n, todayKey));
  const window_ = windowFromText(whenText, today) ?? nextWeekWindow(today);
  const problems = validateNote({ body, window: windowFromText(whenText, today) }, today);

  async function save() {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return onError("You appear to be signed out — reload and try again.");
    setBusy(true);
    const message = await writeError(
      "Couldn't save that note",
      supabase.from("routine_notes").insert({
        user_id: user.id,
        routine_id: routine.id,
        body: body.trim(),
        starts_on: window_.startsOn,
        ends_on: window_.endsOn,
      }),
    );
    setBusy(false);
    if (message) return onError(message);
    setBody("");
    setWhenText("next week");
    setAdding(false);
    await onChanged();
  }

  async function tick(note: RoutineNoteRow) {
    const supabase = createClient();
    const message = await writeError(
      "Couldn't tick that off",
      supabase.from("routine_notes").update({ done_at: new Date().toISOString() }).eq("id", note.id),
    );
    if (message) return onError(message);
    await onChanged();
  }

  async function drop(note: RoutineNoteRow) {
    const supabase = createClient();
    const message = await softDelete(supabase, "routine_notes", note.id, "Couldn't remove that note");
    if (message) return onError(message);
    await onChanged();
  }

  /** Does the routine actually run inside the note's window? A note on a Mon/Wed
   * routine scoped to a Saturday can never be read out, and silence is precisely
   * the failure this feature is meant to prevent — so it is flagged on the row. */
  const unreachable = (note: RoutineNoteRow): boolean => {
    const start = new Date(note.starts_on + "T00:00:00");
    const end = new Date(note.ends_on + "T00:00:00");
    for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      if (routine.days.includes((d.getDay() + 6) % 7)) return false;
    }
    return true;
  };

  const field =
    "rounded border border-border bg-surface px-1.5 py-1 text-text text-[11px] outline-none focus-visible:border-accent";

  return (
    <div className="mt-1.5 pl-0.5 flex flex-col gap-1">
      {live.map((note) => (
        <div key={note.id} className="group flex items-baseline gap-1.5">
          <span
            className="flex-none text-[9.5px] tracking-wide uppercase"
            style={{
              color: isActiveOn(note, todayKey) ? "var(--color-accent-text, #d2cefd)" : "var(--color-muted-2, #75798c)",
            }}
            title={
              isActiveOn(note, todayKey)
                ? "Being read back to you now"
                : "Starts later — it stays quiet until then"
            }
          >
            {describeWindow(note, today)}
          </span>
          <span className="text-[11px] text-text flex-1 min-w-0">{note.body}</span>
          {unreachable(note) && (
            <span
              className="flex-none text-[9.5px]"
              style={{ color: "#e0a94e" }}
              title={`${routine.title} doesn't run on any day in that window, so this will never come up.`}
            >
              never comes up
            </span>
          )}
          <button
            onClick={() => void tick(note)}
            title="I've done this — stop mentioning it, but keep it in the history"
            className="flex-none text-muted-2 opacity-0 group-hover:opacity-100 hover:text-text"
          >
            <CheckIcon size={11} />
          </button>
          <button
            onClick={() => void drop(note)}
            title="Delete this note (goes to the Trash)"
            className="flex-none text-[10px] text-muted-2 opacity-0 group-hover:opacity-100 hover:text-text"
          >
            ✕
          </button>
        </div>
      ))}

      {adding ? (
        <div className="mt-0.5 flex flex-col gap-1.5 rounded border border-accent bg-surface px-2 py-1.5">
          <input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !problems.errors.length && void save()}
            placeholder={`what to do in ${routine.title} — e.g. "search foundation MHW grants"`}
            autoFocus
            className={field}
          />
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-muted-2">when:</span>
            {["next week", "this week", "tomorrow", "the next 3 weeks"].map((phrase) => (
              <button
                key={phrase}
                onClick={() => setWhenText(phrase)}
                className="rounded border px-1.5 py-0.5 text-[10px]"
                style={
                  whenText === phrase
                    ? { borderColor: "var(--color-accent, #9184d9)", color: "var(--color-accent-text, #d2cefd)" }
                    : { borderColor: "var(--color-border, #2a2d3d)", color: "var(--color-muted, #9397ab)" }
                }
              >
                {phrase}
              </button>
            ))}
            {/* Free text as well as the buttons: the same parser the chat uses,
               so anything sayable there is typeable here ("the week of Aug 17",
               "August 20", "next month"). */}
            <input
              value={whenText}
              onChange={(e) => setWhenText(e.target.value)}
              placeholder="or type a date"
              className={`${field} w-[124px]`}
            />
          </div>
          <div className="text-[10px] text-muted">
            {windowFromText(whenText, today)
              ? `Comes up in ${routine.title} ${describeWindow({ starts_on: window_.startsOn, ends_on: window_.endsOn }, today)}, then goes quiet on its own.`
              : "Couldn't read those dates — try “next week”, “Tuesday”, or “Aug 17”."}
          </div>
          {problems.warnings.map((w) => (
            <div key={w} className="text-[10px]" style={{ color: "#e0a94e" }}>
              {w}
            </div>
          ))}
          <div className="flex items-center gap-2">
            <button
              onClick={() => void save()}
              disabled={busy || problems.errors.length > 0}
              className="rounded border border-accent text-accent px-2 py-0.5 text-[10px] font-medium hover:bg-accent/10 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Add note"}
            </button>
            <button
              onClick={() => {
                setAdding(false);
                setBody("");
              }}
              className="text-[10px] text-muted-2 hover:text-text"
            >
              cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 text-[10px] text-muted-2 hover:text-text"
            title="Leave yourself a note for a particular week's run of this routine"
          >
            <PlusIcon size={10} /> note for a specific week
          </button>
          {past.length > 0 && (
            <button
              onClick={() => setShowPast((s) => !s)}
              className="text-[10px] text-muted-2 hover:text-text"
            >
              {showPast ? "hide" : `${past.length} past`}
            </button>
          )}
        </div>
      )}

      {showPast &&
        past.map((note) => (
          <div key={note.id} className="group flex items-baseline gap-1.5">
            <span className="flex-none text-[9.5px] tracking-wide uppercase text-muted-2">
              {describeWindow(note, today)}
              {note.done_at ? " · done" : ""}
            </span>
            <span className="text-[11px] text-muted-2 flex-1 min-w-0 line-through">{note.body}</span>
            <button
              onClick={() => void drop(note)}
              title="Delete this note (goes to the Trash)"
              className="flex-none text-[10px] text-muted-2 opacity-0 group-hover:opacity-100 hover:text-text"
            >
              ✕
            </button>
          </div>
        ))}
    </div>
  );
}

function RoutineEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
  busy,
  problems,
  field,
  categories,
}: {
  draft: RoutineDraft;
  setDraft: (draft: RoutineDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  problems: { errors: string[]; warnings: string[] };
  field: string;
  categories: CategoryRow[];
}) {
  const toggleDay = (day: number) =>
    setDraft({
      ...draft,
      days: draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day].sort(),
    });

  return (
    <div className="rounded-md border border-accent bg-panel px-3 py-2.5 flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <input
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          placeholder="what it's called on the calendar"
          className={`${field} flex-1 min-w-0`}
        />
        <input
          value={draft.lengthText}
          onChange={(e) => setDraft({ ...draft, lengthText: e.target.value })}
          className={`${field} w-14`}
        />
        <span className="text-xs text-muted flex-none">minutes</span>
      </div>

      <div className="flex items-center gap-1.5">
        {ROUTINE_DAYS.map((label, day) => (
          <button
            key={label}
            onClick={() => toggleDay(day)}
            className="rounded border px-2 py-1 text-[11px]"
            style={
              draft.days.includes(day)
                ? { borderColor: "var(--color-accent, #9184d9)", color: "var(--color-accent-text, #d2cefd)" }
                : { borderColor: "var(--color-border, #2a2d3d)", color: "var(--color-muted, #9397ab)" }
            }
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        {PLACEMENTS.map((p) => (
          <label key={p.id} className="flex items-baseline gap-1.5 text-xs text-text">
            <input
              type="radio"
              checked={draft.placement === p.id}
              onChange={() => setDraft({ ...draft, placement: p.id })}
            />
            <span>
              {p.label} <span className="text-[11px] text-muted">— {p.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {(draft.placement === "fixed" || draft.placement === "window") && (
        <div className="flex items-center gap-2 text-xs text-muted pl-5">
          <input
            type="time"
            value={draft.startText}
            onChange={(e) => setDraft({ ...draft, startText: e.target.value })}
            className={field}
          />
          {draft.placement === "window" && (
            <>
              <span>to</span>
              <input
                type="time"
                value={draft.endText}
                onChange={(e) => setDraft({ ...draft, endText: e.target.value })}
                className={field}
              />
            </>
          )}
        </div>
      )}

      {/* The one thing that isn't obvious about an anchored routine: what
         happens on a day where a meeting is already sitting on the edge it
         wants. Said here rather than left to be discovered on such a day. */}
      {(draft.placement === "day_start" || draft.placement === "day_end") && (
        <p className="text-[11px] text-muted pl-5">
          No fixed time — it moves with your hours, and nothing else is scheduled{" "}
          {draft.placement === "day_start" ? "before" : "after"} it. If something is already on that edge of the day
          it takes the first free slot in that {draft.placement === "day_start" ? "first" : "last"} half of the day,
          and is skipped for the day if there isn&apos;t one.
        </p>
      )}

      {/* Optional, and "no label" is the right answer for most: a standing email
         slot belongs to no weekly share. Giving one a label is how a weekly
         literature scan comes to count as research. */}
      <div className="flex items-center gap-2">
        <select
          value={draft.categoryId}
          onChange={(e) => setDraft({ ...draft, categoryId: e.target.value })}
          className={field}
        >
          <option value="">no label</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-muted">
          {draft.categoryId
            ? "counts toward this label's share of the week"
            : "counts toward no weekly share"}
        </span>
      </div>

      {problems.warnings.map((w) => (
        <div key={w} className="text-[11px]" style={{ color: "#e0a94e" }}>
          {w}
        </div>
      ))}
      {problems.errors.length > 0 && (
        <div className="text-[11px]" style={{ color: "#e5484d" }}>
          {problems.errors[0]}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={onSave}
          disabled={busy || problems.errors.length > 0}
          className="rounded-md border border-accent text-accent px-2.5 py-1 text-xs font-medium hover:bg-accent/10 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button onClick={onCancel} className="text-[11px] text-muted hover:text-text">
          cancel
        </button>
      </div>
    </div>
  );
}
