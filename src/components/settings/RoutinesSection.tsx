"use client";

// Settings section for routines — the standing weekly slots that make up a
// normal week, alongside the standard hours they sit inside.
//
// These existed only as a chat tool (update_recurring), so five rows were
// shaping every scheduled week with nothing on screen to show them, let alone
// change them. Both paths write the same columns; the arithmetic and the wording
// live in lib/planner/routine-form.ts so they can be tested without a browser.

import { useCallback, useEffect, useState } from "react";
import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { createClient } from "@/lib/supabase/client";
import {
  ROUTINE_DAYS,
  describeRoutine,
  routineDraft,
  routineRow,
  validateRoutine,
  type RoutineDraft,
  type RoutinePlacement,
} from "@/lib/planner/routine-form";
import type { Database } from "@/lib/supabase/database.types";

type RoutineRow = Database["public"]["Tables"]["recurring_rules"]["Row"];
type CategoryRow = Database["public"]["Tables"]["categories"]["Row"];

const PLACEMENTS: { id: RoutinePlacement; label: string; hint: string }[] = [
  { id: "fixed", label: "At a set time", hint: "it holds that slot" },
  { id: "window", label: "Somewhere in a window", hint: "the scheduler picks when, inside it" },
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
  const [draft, setDraft] = useState<RoutineDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase.from("recurring_rules").select("*").order("created_at");
    setRows(data ?? []);
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
              <div
                key={row.id}
                className="flex items-center gap-3 rounded-md border border-border bg-panel px-3 py-2"
              >
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

      {draft.placement !== "anywhere" && (
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
