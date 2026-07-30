"use client";

// Everything you can attach to a single to-do, in one place: when it happens,
// what warning you want, and hours booked for it. All three are optional and
// all three are editable later — the common case is a bare line of text, and
// the panel only opens when you ask for it.
//
// Booked time carries both ends of its window: a start, before which the
// scheduler may not place it, and a finish-by. That pair is what makes
// preparation expressible without a second kind of booking — "two hours,
// finished by the morning of the talk" is just a booking whose deadline is
// earlier than the thing it's for.

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";

type ItemRow = Database["public"]["Tables"]["todo_items"]["Row"];
type CategoryRow = Database["public"]["Tables"]["categories"]["Row"];
type TaskRow = Database["public"]["Tables"]["tasks"]["Row"];

/** Lead times offered as one-click chips. Stored as minutes before due_at. */
const LEAD_OPTIONS: [string, number][] = [
  ["2 weeks", 20160],
  ["1 week", 10080],
  ["3 days", 4320],
  ["1 day", 1440],
  ["2 hours", 120],
];

const PRIORITIES = ["high", "medium", "low"] as const;

/** <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" in local time. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fromLocalInput = (value: string): string | null => (value ? new Date(value).toISOString() : null);

export function TodoItemPanel({
  item,
  categories,
  tasks,
  onClose,
  onSaved,
}: {
  item: ItemRow;
  categories: CategoryRow[];
  tasks: TaskRow[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const linked = tasks.find((t) => t.id === item.task_id) ?? null;

  const [dueAt, setDueAt] = useState(toLocalInput(item.due_at));
  const [leads, setLeads] = useState<number[]>(item.lead_minutes);
  const [notes, setNotes] = useState(item.notes ?? "");

  const [wantsTime, setWantsTime] = useState(linked != null);
  const [hours, setHours] = useState(linked ? String(linked.duration_min / 60) : "1");
  const [start, setStart] = useState(toLocalInput(linked?.floor_at ?? null));
  const [noDeadline, setNoDeadline] = useState(linked ? linked.deadline_at == null : false);
  const [deadline, setDeadline] = useState(toLocalInput(linked?.deadline_at ?? null));
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>(
    (linked?.priority as (typeof PRIORITIES)[number]) ?? "medium",
  );
  const [categoryId, setCategoryId] = useState(linked?.category_id ?? "");
  const [maxPerDay, setMaxPerDay] = useState(linked?.max_per_day_min ? String(linked.max_per_day_min / 60) : "");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleLead(minutes: number) {
    setLeads((prev) => (prev.includes(minutes) ? prev.filter((m) => m !== minutes) : [...prev, minutes].sort((a, b) => b - a)));
  }

  async function save() {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setBusy(false);
      return;
    }

    const due = fromLocalInput(dueAt);
    // A lead time is measured back from the due date, so leads without one
    // would never fire — say so rather than silently keeping dead settings.
    if (leads.length && !due) {
      setBusy(false);
      setError("Reminders need a date to count back from — set when it happens, or clear the reminders.");
      return;
    }

    const patch: Database["public"]["Tables"]["todo_items"]["Update"] = {
      due_at: due,
      lead_minutes: leads,
      notes: notes.trim() || null,
    };
    // Leads already sent are tracked by value; dropping a lead should let it
    // fire again if it's re-added later, so prune what no longer applies.
    patch.sent_leads = item.sent_leads.filter((m) => leads.includes(m));

    const hoursNum = Number(hours);
    if (wantsTime && (!Number.isFinite(hoursNum) || hoursNum <= 0)) {
      setBusy(false);
      setError("How many hours should be booked for it?");
      return;
    }

    if (wantsTime) {
      // user_id belongs on the insert only — it isn't an updatable column.
      const taskFields = {
        title: item.text,
        duration_min: Math.round(hoursNum * 60),
        chunk_min: Math.min(120, Math.round(hoursNum * 60)),
        priority,
        // Empty start means "any time from now", which is the scheduler's
        // default anyway.
        floor_at: fromLocalInput(start) ?? new Date().toISOString(),
        deadline_at: noDeadline ? null : fromLocalInput(deadline),
        category_id: categoryId || null,
        max_per_day_min: maxPerDay ? Math.round(Number(maxPerDay) * 60) : null,
      };
      if (linked) {
        await supabase.from("tasks").update(taskFields).eq("id", linked.id);
      } else {
        const { data: created, error: err } = await supabase
          .from("tasks")
          .insert({ ...taskFields, user_id: user.id })
          .select("id")
          .single();
        if (err) {
          setBusy(false);
          setError(`Couldn't book the time: ${err.message}`);
          return;
        }
        patch.task_id = created!.id;
      }
    } else if (linked) {
      // Unticking "book time" removes the hours from the calendar but keeps the
      // to-do itself, which is the whole point of the two being separate.
      await supabase.from("tasks").delete().eq("id", linked.id);
      patch.task_id = null;
    }

    await supabase.from("todo_items").update(patch).eq("id", item.id);
    await onSaved();
    setBusy(false);
    onClose();
  }

  const field = "rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text outline-none focus-visible:border-accent";

  return (
    <div className="mt-1.5 mb-2 rounded-md border border-border bg-surface p-2.5 flex flex-col gap-2.5">
      <section className="flex flex-col gap-1">
        <div className="text-[10px] tracking-wide uppercase text-muted-2">When it happens</div>
        <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className={field} />
        <div className="text-[10px] text-muted-2">Leave empty if it has no particular date.</div>
      </section>

      <section className="flex flex-col gap-1">
        <div className="text-[10px] tracking-wide uppercase text-muted-2">Remind me before</div>
        <div className="flex flex-wrap gap-1">
          {LEAD_OPTIONS.map(([label, minutes]) => (
            <button
              key={minutes}
              onClick={() => toggleLead(minutes)}
              className="rounded-md px-2 py-0.5 text-[10.5px] border"
              style={{
                borderColor: leads.includes(minutes) ? "var(--color-accent)" : "var(--color-border)",
                background: leads.includes(minutes) ? "rgba(145,132,217,0.08)" : "transparent",
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-muted-2">Pick as many as you like — each one is a separate notification.</div>
      </section>

      <section className="flex flex-col gap-1">
        <label className="flex items-center gap-1.5 text-[11px] text-text">
          <input type="checkbox" checked={wantsTime} onChange={(e) => setWantsTime(e.target.checked)} />
          Book time for this on my calendar
        </label>
        {wantsTime && (
          <div className="flex flex-col gap-1.5 pl-5">
            <div className="flex items-center gap-1.5">
              <input value={hours} onChange={(e) => setHours(e.target.value)} className={`${field} w-14`} />
              <span className="text-[11px] text-muted">hours needed</span>
            </div>
            <label className="text-[10px] text-muted-2">start</label>
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={field} />
            <div className="text-[10px] text-muted-2">
              The earliest it may be scheduled. Leave empty to allow any time from now.
            </div>
            <label className="flex items-center gap-1.5 text-[11px] text-muted">
              <input type="checkbox" checked={noDeadline} onChange={(e) => setNoDeadline(e.target.checked)} />
              no deadline
            </label>
            {!noDeadline && (
              <>
                <label className="text-[10px] text-muted-2">finish by</label>
                <input
                  type="datetime-local"
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                  className={field}
                />
                <div className="text-[10px] text-muted-2">
                  Set this earlier than the thing itself to book preparation — say two hours finished by the morning
                  of a talk.
                </div>
              </>
            )}
            <div className="flex gap-1.5 flex-wrap">
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as (typeof PRIORITIES)[number])}
                className={field}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p} priority
                  </option>
                ))}
              </select>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={field}>
                <option value="">no label</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                value={maxPerDay}
                onChange={(e) => setMaxPerDay(e.target.value)}
                placeholder="—"
                className={`${field} w-14`}
              />
              <span className="text-[11px] text-muted">max hours per day (optional)</span>
            </div>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-1">
        <div className="text-[10px] tracking-wide uppercase text-muted-2">Notes</div>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={field} />
      </section>

      {error && (
        <div className="text-[10.5px]" style={{ color: "#e5484d" }}>
          {error}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-md border border-accent text-accent px-2.5 py-1 text-[11px] font-medium hover:bg-accent/10 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button onClick={onClose} className="text-[10.5px] text-muted-2 hover:text-text">
          cancel
        </button>
      </div>
    </div>
  );
}
