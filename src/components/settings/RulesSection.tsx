"use client";

// Standing rules — the free-text instructions the planner carries into every
// conversation ("keep Friday afternoons free", "research in blocks of at least an
// hour").
//
// They were written only by the chat (remember_rule) and read only by the prompt,
// so an account could accumulate rules that shaped every plan with nothing on
// screen to show them, no way to correct one, and no way to tell which were still
// wanted.
//
// THE HONEST PART, and the reason this section says it out loud: a rule is not a
// scheduling constraint. ScheduleInputs has no field for these — the engine never
// sees them. They are instructions the planner reads each turn and honours when it
// chooses what to book. Anything that must be enforced whether or not the chat is
// involved belongs in the standard hours, a day's hours, or a label's settings.

import { useCallback, useEffect, useState } from "react";
import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";

type RuleRow = Database["public"]["Tables"]["preference_notes"]["Row"];

export function RulesSection() {
  const [rows, setRows] = useState<RuleRow[] | null>(null);
  /** id being edited, or "new". */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase.from("preference_notes").select("*").order("created_at");
    setRows(data ?? []);
  }, []);

  useEffect(() => {
    // Fetch-on-mount, same pattern (and lint caveat) as the other sections.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function save() {
    const note = draft.trim();
    if (!note) {
      setError("A rule needs some words — that's the whole of it.");
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = createClient();

    if (editing && editing !== "new") {
      const { error: err } = await supabase.from("preference_notes").update({ note }).eq("id", editing);
      if (err) {
        setBusy(false);
        setError(`Couldn't save that rule: ${err.message}`);
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
      const { error: err } = await supabase.from("preference_notes").insert({ user_id: user.id, note });
      if (err) {
        setBusy(false);
        setError(`Couldn't add that rule: ${err.message}`);
        return;
      }
    }

    await load();
    setBusy(false);
    setEditing(null);
    setDraft("");
  }

  async function remove(row: RuleRow) {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error: err } = await supabase.from("preference_notes").delete().eq("id", row.id);
    if (err) setError(`Couldn't remove that rule: ${err.message}`);
    else await load();
    setBusy(false);
    if (editing === row.id) {
      setEditing(null);
      setDraft("");
    }
  }

  const editor = (
    <div className="rounded-md border border-accent bg-panel px-3 py-2.5 flex flex-col gap-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        placeholder="e.g. keep Friday afternoons free for writing"
        className="w-full rounded border border-border bg-surface px-2 py-1.5 text-xs text-text outline-none focus-visible:border-accent resize-y"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={busy || !draft.trim()}
          className="rounded-md border border-accent text-accent px-2.5 py-1 text-xs font-medium hover:bg-accent/10 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          onClick={() => {
            setEditing(null);
            setDraft("");
            setError(null);
          }}
          className="text-[11px] text-muted hover:text-text"
        >
          cancel
        </button>
      </div>
    </div>
  );

  return (
    <div className="mt-8 pt-5 border-t border-border">
      <h2 id="rules" className="text-base font-medium mb-1 scroll-mt-4">
        Standing rules
      </h2>
      <p className="text-xs text-muted mb-2">
        Things you want the planner to remember about how you may be scheduled, in your own words. It reads every
        one of these on every turn, in the chat and in a planning session, and honours them when it decides what to
        book.
      </p>
      <p className="text-xs text-muted mb-4">
        A rule is an <span className="text-text">instruction to the planner, not a constraint on the scheduler</span>.
        The engine that lays out your calendar never sees them, so anything that has to hold whether or not the chat
        is involved belongs somewhere it can be enforced: the hours in{" "}
        <a href="#standard-hours" className="text-accent-text hover:underline">
          Standard hours
        </a>{" "}
        or on a single day, a{" "}
        <a href="#routines" className="text-accent-text hover:underline">
          routine
        </a>{" "}
        for a standing slot, or a{" "}
        <a href="#categories" className="text-accent-text hover:underline">
          label
        </a>
        &apos;s minimum chunk, time of day and share of the week. A rule is the right place for judgement the
        scheduler can&apos;t express — how much slack to leave, what to do when a week is over-full.
      </p>

      {rows === null ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) =>
            editing === row.id ? (
              <div key={row.id}>{editor}</div>
            ) : (
              <div key={row.id} className="flex items-start gap-3 rounded-md border border-border bg-panel px-3 py-2">
                <button
                  onClick={() => {
                    setEditing(row.id);
                    setDraft(row.note);
                    setError(null);
                  }}
                  className="flex-1 min-w-0 text-left"
                  title="Change the wording"
                >
                  <div className="text-xs text-text leading-relaxed">{row.note}</div>
                  <div className="mt-0.5 text-[10px] text-muted-2">
                    saved {new Date(row.created_at).toLocaleDateString()}
                  </div>
                </button>
                <button
                  onClick={() => void remove(row)}
                  disabled={busy}
                  title="Stop honouring this"
                  className="flex-none mt-0.5 text-muted hover:text-text disabled:opacity-50"
                >
                  <TrashIcon size={13} />
                </button>
              </div>
            ),
          )}

          {rows.length === 0 && editing !== "new" && (
            <p className="text-xs text-muted">
              No rules yet. Anything you find yourself repeating to the planner belongs here.
            </p>
          )}

          {editing === "new" && editor}

          {editing === null && (
            <button
              onClick={() => {
                setEditing("new");
                setDraft("");
                setError(null);
              }}
              className="self-start flex items-center gap-1 text-xs text-muted hover:text-text"
            >
              <PlusIcon size={12} /> add a rule
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
