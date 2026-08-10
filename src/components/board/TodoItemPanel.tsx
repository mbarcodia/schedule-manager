"use client";

// Everything you can attach to a single to-do. An item is one of three things,
// chosen up front, and only that kind's fields are shown:
//
//   a line       nothing scheduled, nothing notified
//   a deadline   due by a DAY (usually no clock time), optionally with hours
//                booked to do it in
//   an event     happens at a set TIME and holds that slot on the calendar,
//                optionally with hours booked to prepare beforehand
//
// The kind used to be implied by which of three independent checkboxes happened
// to be ticked, so a deadline and an event were half-configurable into each
// other and the panel asked for a clock time it did not need. Being explicit is
// what lets the deadline case stop mentioning times at all.
//
// Booked time always carries both ends of its window — a start, before which the
// scheduler may not place it, and a finish-by. The finish-by is INHERITED from
// the thing itself (a deadline's date, an event's start) so it is never entered
// twice; overriding it earlier is what expresses preparation.

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { availableCapacity } from "@/lib/assistant/status";
import { SPLIT_MODES, blankTaskDraft, labelMinChunkClash, type SplitMode } from "@/lib/planner/task-form";
import type { WeeklyHours } from "@/lib/scheduling/types";
import type { Database } from "@/lib/supabase/database.types";

type ItemRow = Database["public"]["Tables"]["todo_items"]["Row"];
type CategoryRow = Database["public"]["Tables"]["categories"]["Row"];
type TaskRow = Database["public"]["Tables"]["tasks"]["Row"];
type EventRow = Database["public"]["Tables"]["events"]["Row"];

/** Lead times offered as one-click chips. Stored as minutes before due_at. */
const LEAD_OPTIONS: [string, number][] = [
  ["2 weeks", 20160],
  ["1 week", 10080],
  ["3 days", 4320],
  ["1 day", 1440],
  ["2 hours", 120],
];

const PRIORITIES = ["high", "medium", "low"] as const;

type Kind = "line" | "deadline" | "event";

const KINDS: { id: Kind; label: string; hint: string }[] = [
  { id: "line", label: "Just a line", hint: "nothing scheduled" },
  { id: "deadline", label: "Due by a date", hint: "a deadline" },
  { id: "event", label: "Happens at a set time", hint: "goes on the calendar" },
];

/** <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" in local time. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fromLocalInput = (value: string): string | null => (value ? new Date(value).toISOString() : null);

// A date without a time, for the plenty of dates that genuinely have none —
// "due August 11". Which kind a date is travels with the row
// (todo_items.due_all_day, tasks.deadline_all_day) so nothing downstream has to
// guess whether an hour was chosen or invented.
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

const fmtDay = (value: string): string => {
  if (!value) return "";
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** A date field that can optionally carry a clock time. `edge` decides what a
 * date-only value means as an instant — see fromDateInput. */
function DateField({
  value,
  allDay,
  onChange,
  edge,
  fieldClass,
  allowTime = true,
}: {
  value: string;
  allDay: boolean;
  onChange: (value: string, allDay: boolean) => void;
  edge: "start" | "end";
  fieldClass: string;
  /** False where a clock time is meaningless (an all-day deadline's own date). */
  allowTime?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type={allDay ? "date" : "datetime-local"}
        value={value}
        onChange={(e) => onChange(e.target.value, allDay)}
        className={fieldClass}
      />
      {allowTime && (
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
      )}
      {allDay && edge === "end" && !!value && (
        <span className="text-[10px] text-muted-2">any time that day</span>
      )}
    </div>
  );
}

export function TodoItemPanel({
  item,
  categories,
  tasks,
  events,
  weeklyHours,
  onClose,
  onSaved,
}: {
  item: ItemRow;
  categories: CategoryRow[];
  tasks: TaskRow[];
  /** Manual events, so an existing one's END time can be shown. */
  events: EventRow[];
  /** Standard working hours, used to say how much room a booking window really
   * has before it's saved. */
  weeklyHours: WeeklyHours;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const linked = tasks.find((t) => t.id === item.task_id) ?? null;

  const [kind, setKind] = useState<Kind>(
    item.event_id ? "event" : item.due_at || linked ? "deadline" : "line",
  );

  // A new date defaults to date-only: that's what most deadlines are, and the
  // one the panel previously couldn't express without inventing an hour.
  const [dueAllDay, setDueAllDay] = useState(item.due_at ? item.due_all_day : true);
  const [dueAt, setDueAt] = useState(
    item.due_at && item.due_all_day ? toDateInput(item.due_at) : toLocalInput(item.due_at),
  );
  // Seeded from the existing event: this used to start empty on every re-edit,
  // so reopening an event and pressing Save failed on an end time that was
  // already set — and the panel stayed open, looking like Save did nothing.
  const linkedEvent = events.find((e) => e.id === item.event_id) ?? null;
  const [eventEnd, setEventEnd] = useState(toLocalInput(linkedEvent?.ends_at ?? null));
  const [leads, setLeads] = useState<number[]>(item.lead_minutes);
  const [notes, setNotes] = useState(item.notes ?? "");

  const [wantsTime, setWantsTime] = useState(linked != null);
  const [hours, setHours] = useState(linked ? String(linked.duration_min / 60) : "1");
  // A start has no stored flag: a date-only start just means that day's
  // midnight, which is a real instant with nothing invented about it. Midnight
  // is therefore also how we recognise one on the way back in.
  const startWasMidnight = linked?.floor_at
    ? new Date(linked.floor_at).getHours() === 0 && new Date(linked.floor_at).getMinutes() === 0
    : true;
  const [startAllDay, setStartAllDay] = useState(startWasMidnight);
  const [start, setStart] = useState(
    linked?.floor_at
      ? startWasMidnight
        ? toDateInput(linked.floor_at)
        : toLocalInput(linked.floor_at)
      : "",
  );

  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>(
    (linked?.priority as (typeof PRIORITIES)[number]) ?? "medium",
  );
  const [categoryId, setCategoryId] = useState(linked?.category_id ?? "");
  const [maxPerDay, setMaxPerDay] = useState(linked?.max_per_day_min ? String(linked.max_per_day_min / 60) : "");
  const [splitMode, setSplitMode] = useState<SplitMode>(linked?.split_mode ?? "free");
  const [minChunk, setMinChunk] = useState(linked?.min_chunk_min != null ? String(linked.min_chunk_min) : "");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What the hours must be finished by, taken from the thing itself rather than
  // asked for twice. An override is how preparation is expressed: hours due
  // earlier than the deadline or the event they belong to.
  const inheritedFinishIso =
    kind === "event" ? fromLocalInput(dueAt) : dueAllDay ? fromDateInput(dueAt, "end") : fromLocalInput(dueAt);
  const [overrideFinish, setOverrideFinish] = useState(
    // Already overridden if the stored finish-by is earlier than the thing itself.
    !!linked?.deadline_at && !!item.due_at && new Date(linked.deadline_at) < new Date(item.due_at),
  );
  const [finishAllDay, setFinishAllDay] = useState(linked?.deadline_at ? linked.deadline_all_day : true);
  const [finish, setFinish] = useState(
    linked?.deadline_at
      ? linked.deadline_all_day
        ? toDateInput(linked.deadline_at)
        : toLocalInput(linked.deadline_at)
      : "",
  );

  const finishIso = overrideFinish
    ? finishAllDay
      ? fromDateInput(finish, "end")
      : fromLocalInput(finish)
    : inheritedFinishIso;
  const finishIsAllDay = overrideFinish ? finishAllDay : kind !== "event" && dueAllDay;

  // How much working time the chosen window actually contains. A window that
  // can't hold the hours is the failure that looks like the scheduler ignoring
  // a deadline: it places the task as early as it can, which is still late.
  const startIso = startAllDay ? fromDateInput(start, "start") : fromLocalInput(start);
  const startDate = startIso ? new Date(startIso) : new Date();
  const finishDate = finishIso ? new Date(finishIso) : null;
  const capacity = finishDate ? availableCapacity(startDate, finishDate, weeklyHours) : null;
  const hoursWanted = Number(hours);
  const windowTooSmall =
    wantsTime && capacity != null && Number.isFinite(hoursWanted) && capacity.minutes < hoursWanted * 60;
  const windowInverted = finishDate != null && start !== "" && finishDate <= startDate;

  // Hours finishing before something that happens at a known TIME are
  // preparation for it. Hours finishing by the end of the day something is due
  // are the work itself, not preparation — which is why this is limited to
  // events rather than any earlier finish-by.
  const isPrep = kind === "event" && !!inheritedFinishIso && !!finishIso && finishIso <= inheritedFinishIso;

  // A minimum set here OVERRIDES the label's rather than being capped by it (see
  // migration 0042), so the panel says so at the moment it's typed — the only
  // place the two figures are ever visible together.
  const label = categories.find((c) => c.id === categoryId) ?? null;
  const minChunkClash = labelMinChunkClash({ ...blankTaskDraft(), minChunkText: minChunk }, label ? { name: label.name, minChunkMin: label.min_chunk_min } : null);

  function toggleLead(minutes: number) {
    setLeads((prev) =>
      prev.includes(minutes) ? prev.filter((m) => m !== minutes) : [...prev, minutes].sort((a, b) => b - a),
    );
  }

  const fail = (message: string) => {
    setBusy(false);
    setError(message);
  };

  async function save() {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return fail("You appear to be signed out — reload and try again.");

    const wantsEvent = kind === "event";
    const keepTime = kind !== "line" && wantsTime;
    const due = kind === "line" ? null : wantsEvent ? fromLocalInput(dueAt) : dueAllDay ? fromDateInput(dueAt, "end") : fromLocalInput(dueAt);
    const keptLeads = kind === "line" ? [] : leads;

    if (kind === "deadline" && !due && keptLeads.length) {
      return fail("Reminders need a date to count back from — set the due date, or clear the reminders.");
    }
    if (wantsEvent && !due) return fail("An event needs a date and time — set when it happens.");

    const patch: Database["public"]["Tables"]["todo_items"]["Update"] = {
      due_at: due,
      due_all_day: due && !wantsEvent ? dueAllDay : false,
      lead_minutes: keptLeads,
      notes: notes.trim() || null,
      // Leads already sent are tracked by value; dropping a lead should let it
      // fire again if it's re-added later, so prune what no longer applies.
      sent_leads: item.sent_leads.filter((m) => keptLeads.includes(m)),
    };

    const hoursNum = Number(hours);
    if (keepTime && (!Number.isFinite(hoursNum) || hoursNum <= 0)) {
      return fail("How many hours should be booked for it?");
    }
    if (keepTime && windowInverted) {
      return fail("The finish-by is before the start — the hours would have nowhere to go.");
    }

    if (keepTime) {
      const durationMin = Math.round(hoursNum * 60);
      const capMin = maxPerDay ? Math.round(Number(maxPerDay) * 60) : null;
      // Refused rather than described, because the engine's answer to the pair
      // is to schedule NOTHING — and a to-do whose hours silently never appear
      // is exactly the failure this panel exists to prevent.
      if (splitMode !== "free" && capMin != null && capMin < durationMin) {
        return fail(
          splitMode === "one_block"
            ? `It can't be one unbroken block of ${hoursNum}h and also capped at ${capMin / 60}h a day.`
            : `It can't all fall on one day and also be capped at ${capMin / 60}h a day — that's ${hoursNum}h of work.`,
        );
      }
      const minChunkMin = minChunk.trim() ? Math.round(Number(minChunk.trim())) : null;
      if (minChunk.trim() && (!Number.isFinite(minChunkMin) || (minChunkMin ?? 0) <= 0)) {
        return fail("The smallest block has to be a number of minutes above zero — leave it empty for the default.");
      }
      // user_id belongs on the insert only — it isn't an updatable column.
      const taskFields = {
        title: isPrep ? `Prep: ${item.text}` : item.text,
        duration_min: durationMin,
        // In one sitting the preferred size IS the whole task; capping it at 120
        // would leave the engine trying to place a 120-minute block for a task
        // that must not be split, and one_block ignores it anyway.
        chunk_min: splitMode === "one_block" ? durationMin : Math.min(120, durationMin),
        split_mode: splitMode,
        min_chunk_min: minChunkMin,
        priority,
        // Empty start means "any time from now", which is the scheduler's
        // default anyway.
        floor_at: startIso ?? new Date().toISOString(),
        deadline_at: finishIso,
        deadline_all_day: finishIso ? finishIsAllDay : false,
        category_id: categoryId || null,
        max_per_day_min: capMin,
      };
      if (linked) {
        const { error: err } = await supabase.from("tasks").update(taskFields).eq("id", linked.id);
        if (err) return fail(`Couldn't update the booked time: ${err.message}`);
      } else {
        const { data: created, error: err } = await supabase
          .from("tasks")
          .insert({ ...taskFields, user_id: user.id })
          .select("id")
          .single();
        if (err || !created) return fail(`Couldn't book the time: ${err?.message ?? "unknown error"}`);
        patch.task_id = created.id;
      }
    } else if (linked) {
      // Dropping the hours removes them from the calendar but keeps the to-do
      // itself, which is the whole point of the two being separate.
      const { error: err } = await supabase.from("tasks").delete().eq("id", linked.id);
      if (err) return fail(`Couldn't remove the booked time: ${err.message}`);
      patch.task_id = null;
    }

    if (wantsEvent) {
      const endsAt = fromLocalInput(eventEnd);
      if (!endsAt || new Date(endsAt) <= new Date(due!)) {
        return fail("The event's end time has to be after it starts.");
      }
      // connection_id stays null: ICS resync deletes by connection, so a null
      // one survives every sync. Flexible tasks reflow around it automatically,
      // and a clash with another event renders side by side.
      const eventFields = { title: item.text, starts_at: due!, ends_at: endsAt };
      if (item.event_id) {
        const { error: err } = await supabase.from("events").update(eventFields).eq("id", item.event_id);
        if (err) return fail(`Couldn't update the calendar entry: ${err.message}`);
      } else {
        const { data: made, error: err } = await supabase
          .from("events")
          .insert({ ...eventFields, user_id: user.id, source: "manual" })
          .select("id")
          .single();
        if (err || !made) return fail(`Couldn't put it on the calendar: ${err?.message ?? "unknown error"}`);
        patch.event_id = made.id;
      }
    } else if (item.event_id) {
      const { error: err } = await supabase.from("events").delete().eq("id", item.event_id);
      if (err) return fail(`Couldn't remove the calendar entry: ${err.message}`);
      patch.event_id = null;
    }

    // Previously unchecked, so a rejected write closed the panel as though it
    // had saved.
    const { error: err } = await supabase.from("todo_items").update(patch).eq("id", item.id);
    if (err) return fail(`Couldn't save: ${err.message}`);

    await onSaved();
    setBusy(false);
    onClose();
  }

  const field =
    "rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text outline-none focus-visible:border-accent";
  const legend = "text-[10px] tracking-wide uppercase text-muted-2";
  const hint = "text-[10px] text-muted-2";

  /** Hours to spend on it — identical either side, only the wording differs. */
  const bookingSection = (
    <section className="flex flex-col gap-1">
      <label className="flex items-center gap-1.5 text-[11px] text-text">
        <input type="checkbox" checked={wantsTime} onChange={(e) => setWantsTime(e.target.checked)} />
        {kind === "event" ? "Book time to prepare" : "Book time to work on it"}
      </label>
      {wantsTime && (
        <div className="flex flex-col gap-1.5 pl-5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <input value={hours} onChange={(e) => setHours(e.target.value)} className={`${field} w-12`} />
            <span className="text-[11px] text-muted">hours</span>
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
            <span className={`${hint} w-14`}>start</span>
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
          </div>
          <div className={`${hint} pl-[62px]`}>Earliest it may be scheduled. Empty allows any time from now.</div>

          <div className="flex items-start gap-1.5">
            <span className={`${hint} w-14 pt-0.5`}>finish by</span>
            {overrideFinish ? (
              <div className="flex flex-col gap-1">
                <DateField
                  value={finish}
                  allDay={finishAllDay}
                  edge="end"
                  fieldClass={field}
                  onChange={(v, allDay) => {
                    setFinish(v);
                    setFinishAllDay(allDay);
                  }}
                />
                <button
                  onClick={() => setOverrideFinish(false)}
                  className="text-[10px] text-accent hover:underline self-start"
                >
                  ↩ back to {kind === "event" ? "when it happens" : "the deadline"}
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-text">
                  {inheritedFinishIso
                    ? kind === "event"
                      ? "when it happens"
                      : `the deadline, ${dueAllDay ? fmtDay(dueAt) : new Date(inheritedFinishIso).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                    : "no deadline"}
                </span>
                <button
                  onClick={() => {
                    setOverrideFinish(true);
                    if (!finish) {
                      setFinish(kind === "event" ? localInputToDate(dueAt) : dueAllDay ? dueAt : localInputToDate(dueAt));
                      setFinishAllDay(true);
                    }
                  }}
                  className="text-[10px] text-accent hover:underline self-start"
                >
                  ↳ earlier, to prepare
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <input
              value={maxPerDay}
              onChange={(e) => setMaxPerDay(e.target.value)}
              placeholder="—"
              className={`${field} w-12`}
            />
            <span className="text-[11px] text-muted">max hours per day (optional)</span>
          </div>

          {/* How the hours may be broken up. The default is what the panel did
             before this existed, so an item nobody touches behaves unchanged. */}
          <div className="flex flex-col gap-0.5 pt-0.5">
            <span className={hint}>How it&apos;s split</span>
            {SPLIT_MODES.map((m) => (
              <label key={m.id} className="flex items-center gap-1.5 text-[11px] text-text">
                <input type="radio" checked={splitMode === m.id} onChange={() => setSplitMode(m.id)} />
                {m.label} <span className={hint}>— {m.hint}</span>
              </label>
            ))}
          </div>
          {splitMode !== "free" && (
            <div className={hint}>
              A hard rule: if no {splitMode === "one_block" ? "single gap" : "one day"} in the window is big enough, the
              hours stay off the calendar and the board says why, rather than being split anyway.
            </div>
          )}

          {splitMode !== "one_block" && (
            <>
              <div className="flex items-center gap-1.5">
                <input
                  value={minChunk}
                  onChange={(e) => setMinChunk(e.target.value)}
                  placeholder={label?.min_chunk_min ? String(label.min_chunk_min) : "30"}
                  className={`${field} w-12`}
                />
                <span className="text-[11px] text-muted">smallest block, in minutes</span>
              </div>
              {minChunkClash && (
                <div
                  className="text-[10px] leading-snug"
                  style={{ color: minChunkClash.loosens ? "#e0a94e" : "var(--color-muted-2, #75798c)" }}
                >
                  {minChunkClash.text}
                </div>
              )}
            </>
          )}

          {isPrep && (
            <div className={hint}>Finishes before the thing itself, so it appears as “Prep: {item.text}”.</div>
          )}
          {windowInverted ? (
            <div className="text-[10px]" style={{ color: "#e5484d" }}>
              The finish-by is before the start.
            </div>
          ) : capacity ? (
            <div
              className="text-[10px]"
              style={{ color: windowTooSmall ? "#e0a94e" : "var(--color-muted-2, #75798c)" }}
            >
              {(capacity.minutes / 60).toFixed(1)}h of working time in that window
              {windowTooSmall ? ` — not enough for ${hours}h, so it would run late however it's arranged.` : "."}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );

  const remindersSection = (
    <section className="flex flex-col gap-1">
      <div className={legend}>Remind me before</div>
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
      {kind === "deadline" && dueAllDay && leads.length > 0 && (
        <div className={hint}>With no set time, these arrive at the start of your working day.</div>
      )}
    </section>
  );

  return (
    <div className="mt-1.5 mb-2 rounded-md border border-border bg-surface p-2.5 flex flex-col gap-2.5">
      <section className="flex flex-col gap-1">
        <div className={legend}>What is this?</div>
        <div className="flex flex-col gap-0.5">
          {KINDS.map((k) => (
            <label key={k.id} className="flex items-center gap-1.5 text-[11px] text-text">
              <input type="radio" checked={kind === k.id} onChange={() => setKind(k.id)} />
              {k.label} <span className={hint}>— {k.hint}</span>
            </label>
          ))}
        </div>
      </section>

      {kind === "line" && (
        <div className={hint}>
          {item.due_at || linked || item.event_id
            ? "Saving removes its date, reminders and any booked hours."
            : "Nothing is scheduled or notified for it."}
        </div>
      )}

      {kind === "deadline" && (
        <>
          <section className="flex flex-col gap-1">
            <div className={legend}>Due</div>
            <DateField
              value={dueAt}
              allDay={dueAllDay}
              edge="end"
              fieldClass={field}
              onChange={(v, allDay) => {
                setDueAt(v);
                setDueAllDay(allDay);
              }}
            />
          </section>
          {remindersSection}
          {bookingSection}
        </>
      )}

      {kind === "event" && (
        <>
          <section className="flex flex-col gap-1">
            <div className={legend}>When</div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <input
                type="datetime-local"
                value={dueAllDay ? dateInputToLocal(dueAt) : dueAt}
                onChange={(e) => {
                  setDueAt(e.target.value);
                  setDueAllDay(false);
                }}
                className={field}
              />
              <span className={hint}>to</span>
              <input
                type="datetime-local"
                value={eventEnd}
                onChange={(e) => setEventEnd(e.target.value)}
                className={field}
              />
            </div>
            <div className={hint}>That slot is held — flexible work moves out of the way.</div>
          </section>
          {remindersSection}
          {bookingSection}
        </>
      )}

      <section className="flex flex-col gap-1">
        <div className={legend}>Notes</div>
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
