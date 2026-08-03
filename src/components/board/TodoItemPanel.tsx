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
import { availableCapacity } from "@/lib/assistant/status";
import type { WeeklyHours } from "@/lib/scheduling/types";
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

// A date without a time, for the plenty of dates that genuinely have none —
// "due August 11". Every input below can be either kind, and which one it is
// travels with the row (todo_items.due_all_day, tasks.deadline_all_day) so
// nothing downstream has to guess whether an hour was chosen or invented.
//
// These mirror all-day-due.ts's convention using the BROWSER's timezone, as
// every other date in this panel already does — the datetime-local inputs are
// local by definition, and mixing the two would make the same field mean
// different instants depending on which control wrote it.

/** The last minute of the day: a date-only due date still has to sort and
 * compare as that day. Matches ALL_DAY_DUE_MIN in all-day-due.ts. */
const DAY_END = { hour: 23, minute: 59 };

/** <input type="date"> wants "YYYY-MM-DD". */
function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A date-only value as an instant: the end of that day for a due date or
 * finish-by, the start of it for an earliest-start (where a bare date means
 * "any time from this day on", not "from 23:59 on"). */
function fromDateInput(value: string, edge: "start" | "end"): string | null {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  const at = edge === "end" ? DAY_END : { hour: 0, minute: 0 };
  return new Date(y, m - 1, d, at.hour, at.minute).toISOString();
}

/** Carries the date part across a switch between the two modes, so choosing
 * "at a set time" after typing a date doesn't blank what you just entered. */
function dateInputToLocal(value: string): string {
  return value ? `${value}T09:00` : "";
}
const localInputToDate = (value: string): string => value.slice(0, 10);

/** One date field, either a plain date or a date and time. `edge` decides what
 * a date-only value means as an instant — see fromDateInput. */
function DateField({
  value,
  allDay,
  onChange,
  edge,
  fieldClass,
}: {
  value: string;
  allDay: boolean;
  onChange: (value: string, allDay: boolean) => void;
  edge: "start" | "end";
  fieldClass: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <input
          type={allDay ? "date" : "datetime-local"}
          value={value}
          onChange={(e) => onChange(e.target.value, allDay)}
          className={fieldClass}
        />
        <label className="flex items-center gap-1 text-[10px] text-muted-2 whitespace-nowrap">
          <input
            type="checkbox"
            checked={!allDay}
            onChange={(e) =>
              e.target.checked
                ? onChange(dateInputToLocal(value), false)
                : onChange(localInputToDate(value), true)
            }
          />
          at a set time
        </label>
      </div>
      {allDay && edge === "end" && !!value && (
        <div className="text-[10px] text-muted-2">Any time that day counts as on time.</div>
      )}
    </div>
  );
}

export function TodoItemPanel({
  item,
  categories,
  tasks,
  weeklyHours,
  onClose,
  onSaved,
}: {
  item: ItemRow;
  categories: CategoryRow[];
  tasks: TaskRow[];
  /** Standard working hours, used to say how much room a booking window really
   * has before it's saved. */
  weeklyHours: WeeklyHours;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const linked = tasks.find((t) => t.id === item.task_id) ?? null;

  // Each date starts in whichever mode it was saved in. A new item defaults to
  // date-only, since that's what most dates are and it's the one you couldn't
  // express before.
  const [dueAllDay, setDueAllDay] = useState(item.due_at ? item.due_all_day : true);
  const [dueAt, setDueAt] = useState(
    item.due_at && item.due_all_day ? toDateInput(item.due_at) : toLocalInput(item.due_at),
  );
  const [leads, setLeads] = useState<number[]>(item.lead_minutes);
  const [notes, setNotes] = useState(item.notes ?? "");

  const [wantsTime, setWantsTime] = useState(linked != null);
  const [hours, setHours] = useState(linked ? String(linked.duration_min / 60) : "1");
  // A start has no stored flag: a date-only start just means that day's
  // midnight, which is a real instant with nothing invented about it. Midnight
  // is therefore also how we recognise one on the way back in.
  const [startAllDay, setStartAllDay] = useState(
    linked?.floor_at ? new Date(linked.floor_at).getHours() === 0 && new Date(linked.floor_at).getMinutes() === 0 : true,
  );
  const [start, setStart] = useState(
    linked?.floor_at && new Date(linked.floor_at).getHours() === 0 && new Date(linked.floor_at).getMinutes() === 0
      ? toDateInput(linked.floor_at)
      : toLocalInput(linked?.floor_at ?? null),
  );
  const [noDeadline, setNoDeadline] = useState(linked ? linked.deadline_at == null : false);
  const [deadlineAllDay, setDeadlineAllDay] = useState(linked?.deadline_at ? linked.deadline_all_day : true);
  const [deadline, setDeadline] = useState(
    linked?.deadline_at && linked.deadline_all_day
      ? toDateInput(linked.deadline_at)
      : toLocalInput(linked?.deadline_at ?? null),
  );
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>(
    (linked?.priority as (typeof PRIORITIES)[number]) ?? "medium",
  );
  const [categoryId, setCategoryId] = useState(linked?.category_id ?? "");
  const [maxPerDay, setMaxPerDay] = useState(linked?.max_per_day_min ? String(linked.max_per_day_min / 60) : "");

  const [wantsEvent, setWantsEvent] = useState(item.event_id != null);
  const [eventEnd, setEventEnd] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // How much working time the chosen window actually contains. A window that
  // can't hold the hours is the failure that looks like the scheduler ignoring
  // a deadline: it places the task as early as it can, which is still late.
  const startIso = startAllDay ? fromDateInput(start, "start") : fromLocalInput(start);
  const deadlineIso = noDeadline ? null : deadlineAllDay ? fromDateInput(deadline, "end") : fromLocalInput(deadline);
  const startDate = startIso ? new Date(startIso) : new Date();
  const deadlineDate = deadlineIso ? new Date(deadlineIso) : null;
  const capacity = deadlineDate ? availableCapacity(startDate, deadlineDate, weeklyHours) : null;
  const hoursWanted = Number(hours);
  const windowTooSmall =
    wantsTime && capacity != null && Number.isFinite(hoursWanted) && capacity.minutes < hoursWanted * 60;
  const windowInverted = deadlineDate != null && start !== "" && deadlineDate <= startDate;

  // Hours booked toward something that happens at a known time are preparation
  // for it, and are titled that way on the calendar.
  // Only against a due date with a real time on it: "finished by the morning of
  // the talk" is preparation, but hours to be finished by the end of the day
  // something is due are the work itself, not preparation for it.
  const isPrep =
    item.due_at != null && !item.due_all_day && deadlineDate != null && deadlineDate <= new Date(item.due_at);

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

    const due = dueAllDay ? fromDateInput(dueAt, "end") : fromLocalInput(dueAt);
    // A lead time is measured back from the due date, so leads without one
    // would never fire — say so rather than silently keeping dead settings.
    if (leads.length && !due) {
      setBusy(false);
      setError("Reminders need a date to count back from — set when it happens, or clear the reminders.");
      return;
    }

    const patch: Database["public"]["Tables"]["todo_items"]["Update"] = {
      due_at: due,
      due_all_day: due ? dueAllDay : false,
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

    if (windowInverted) {
      setBusy(false);
      setError("The finish-by is before the start — the task would have nowhere to go.");
      return;
    }

    if (wantsTime) {
      // user_id belongs on the insert only — it isn't an updatable column.
      const taskFields = {
        title: isPrep ? `Prep: ${item.text}` : item.text,
        duration_min: Math.round(hoursNum * 60),
        chunk_min: Math.min(120, Math.round(hoursNum * 60)),
        priority,
        // Empty start means "any time from now", which is the scheduler's
        // default anyway.
        floor_at: startIso ?? new Date().toISOString(),
        deadline_at: deadlineIso,
        deadline_all_day: deadlineIso ? deadlineAllDay : false,
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

    if (wantsEvent) {
      // Deliberately not the date-only branch: an event occupies a span between
      // two clock times, so a date with no time can't produce one.
      const startsAt = dueAllDay ? null : fromLocalInput(dueAt);
      const endsAt = fromLocalInput(eventEnd);
      if (!startsAt) {
        setBusy(false);
        setError("An event needs a set time — give it one above, or turn the event off.");
        return;
      }
      if (!endsAt || new Date(endsAt) <= new Date(startsAt)) {
        setBusy(false);
        setError("The event's end time has to be after it starts.");
        return;
      }
      // connection_id stays null: ICS resync deletes by connection, so a null
      // one survives every sync. Flexible tasks reflow around it automatically,
      // and a clash with another event renders side by side.
      const eventFields = { title: item.text, starts_at: startsAt, ends_at: endsAt };
      if (item.event_id) {
        await supabase.from("events").update(eventFields).eq("id", item.event_id);
      } else {
        const { data: made, error: err } = await supabase
          .from("events")
          .insert({ ...eventFields, user_id: user.id, source: "manual" })
          .select("id")
          .single();
        if (err) {
          setBusy(false);
          setError(`Couldn't put it on the calendar: ${err.message}`);
          return;
        }
        patch.event_id = made!.id;
      }
    } else if (item.event_id) {
      await supabase.from("events").delete().eq("id", item.event_id);
      patch.event_id = null;
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
        <DateField
          value={dueAt}
          allDay={dueAllDay}
          edge="end"
          fieldClass={field}
          onChange={(v, allDay) => {
            setDueAt(v);
            setDueAllDay(allDay);
            // An event is a span between two clock times; a date-only item has
            // neither, so the option can't apply to it.
            if (allDay) setWantsEvent(false);
          }}
        />
        <div className="text-[10px] text-muted-2">
          Leave empty if it has no particular date. A date on its own is fine — a deadline usually is one.
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-text mt-1">
          <input
            type="checkbox"
            checked={wantsEvent}
            disabled={dueAllDay}
            onChange={(e) => setWantsEvent(e.target.checked)}
          />
          <span className={dueAllDay ? "text-muted-2" : undefined}>
            Put it on my calendar as an event
            {dueAllDay ? " — needs a set time" : ""}
          </span>
        </label>
        {wantsEvent && (
          <div className="flex flex-col gap-1 pl-5">
            <label className="text-[10px] text-muted-2">ends at</label>
            <input
              type="datetime-local"
              value={eventEnd}
              onChange={(e) => setEventEnd(e.target.value)}
              className={field}
            />
            <div className="text-[10px] text-muted-2">
              That time is held: flexible tasks are moved out of the way, and another event at the same time sits
              beside it rather than on top.
            </div>
          </div>
        )}
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
            <DateField
              value={start}
              allDay={startAllDay}
              edge="start"
              fieldClass={field}
              onChange={(v, allDay) => {
                setStart(v);
                setStartAllDay(allDay);
              }}
            />
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
                <DateField
                  value={deadline}
                  allDay={deadlineAllDay}
                  edge="end"
                  fieldClass={field}
                  onChange={(v, allDay) => {
                    setDeadline(v);
                    setDeadlineAllDay(allDay);
                  }}
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
            {isPrep && (
              <div className="text-[10px] text-muted-2">
                This finishes before the thing itself, so it&apos;s preparation — it&apos;ll appear on the calendar
                as &ldquo;Prep: {item.text}&rdquo;.
              </div>
            )}
            {windowInverted ? (
              <div className="text-[10px]" style={{ color: "#e5484d" }}>
                The finish-by is before the start.
              </div>
            ) : capacity ? (
              <div className="text-[10px]" style={{ color: windowTooSmall ? "#e0a94e" : "var(--color-muted-2, #75798c)" }}>
                {(capacity.minutes / 60).toFixed(1)}h of working time between those two dates
                {windowTooSmall
                  ? ` — not enough for ${hours}h, so it would be scheduled late however it's arranged.`
                  : "."}
              </div>
            ) : null}
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
