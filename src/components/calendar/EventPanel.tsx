"use client";

// A meeting or an away day, entered by hand.
//
// Events could arrive from a synced calendar, from the chat (add_event), or as a
// to-do that "happens at a set time" — but not from the calendar itself, which is
// where you are when someone tells you about a meeting. Editing one had no path at
// all, so a time that moved by half an hour meant deleting and re-describing it.
//
// Only MANUAL events are editable here. A synced one is a copy of a row that
// belongs to Google or an ICS feed: the next sync would overwrite the change, so
// offering to edit it would be offering something the sync takes back.

import { useCallback, useEffect, useState } from "react";
import { XIcon, TrashIcon } from "@phosphor-icons/react";
import { createClient } from "@/lib/supabase/client";
import { softDelete } from "@/lib/db/soft-delete";
import type { Database } from "@/lib/supabase/database.types";

type EventRow = Database["public"]["Tables"]["events"]["Row"];

const pad = (n: number) => String(n).padStart(2, "0");

/** Local parts, never toISOString().slice() — that converts to UTC first and
 * lands the previous day west of Greenwich. */
const localDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const localTime = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const at = (date: string, time: string): string => {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time ? time.split(":").map(Number) : [0, 0];
  return new Date(y, m - 1, d, hh, mm).toISOString();
};

/** Loads the row before showing the form, so the calendar doesn't have to carry
 * raw event rows around just for this. An id that no longer exists (deleted in
 * another tab, or removed by a sync) closes rather than showing a blank form. */
export function EventPanel({
  eventId,
  onClose,
  onSaved,
}: {
  /** An events-table id, or null to create one. */
  eventId: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [event, setEvent] = useState<EventRow | null>(null);
  const [loading, setLoading] = useState(eventId != null);

  const load = useCallback(async () => {
    if (!eventId) return;
    const supabase = createClient();
    const { data } = await supabase.from("events").select("*").is("deleted_at", null).eq("id", eventId).maybeSingle();
    setEvent(data ?? null);
    setLoading(false);
    if (!data) onClose();
  }, [eventId, onClose]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="fixed inset-0 z-40 flex justify-end">
        <div className="flex-1" style={{ background: "rgba(0,0,0,0.45)" }} />
        <div className="relative w-full max-w-[380px] h-full border-l border-border bg-panel p-4 text-[12px] text-muted">
          Loading…
        </div>
      </div>
    );
  }

  return <EventForm key={event?.id ?? "new"} event={event} onClose={onClose} onSaved={onSaved} />;
}

function EventForm({
  event,
  onClose,
  onSaved,
}: {
  event: EventRow | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const today = new Date();
  const [title, setTitle] = useState(event?.title ?? "");
  const [allDay, setAllDay] = useState(!!event?.all_day);
  const [date, setDate] = useState(
    event ? localDate(event.starts_at) : `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
  );
  const [startTime, setStartTime] = useState(event && !event.all_day ? localTime(event.starts_at) : "10:00");
  const [endTime, setEndTime] = useState(event && !event.all_day ? localTime(event.ends_at) : "11:00");
  const [endDate, setEndDate] = useState(event ? localDate(event.ends_at) : "");
  const [location, setLocation] = useState(event?.location ?? "");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errors: string[] = [];
  if (!title.trim()) errors.push("An event needs a name.");
  if (!date) errors.push("An event needs a date.");
  if (!allDay && endTime <= startTime) errors.push("It ends before it starts.");
  if (allDay && endDate && endDate < date) errors.push("The last day is before the first.");

  async function save() {
    if (errors.length) {
      setError(errors[0]);
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = createClient();

    // An all-day event runs to the END of its last day, so a one-day entry covers
    // that whole day rather than collapsing to midnight.
    const fields = {
      title: title.trim(),
      all_day: allDay,
      starts_at: allDay ? at(date, "00:00") : at(date, startTime),
      ends_at: allDay ? at(endDate || date, "23:59") : at(date, endTime),
      location: location.trim() || null,
    };

    if (event) {
      const { error: err } = await supabase.from("events").update(fields).eq("id", event.id);
      if (err) {
        setBusy(false);
        setError(`Couldn't save that event: ${err.message}`);
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
      // source "manual" is what keeps it out of the calendar sync's delete scope.
      const { error: err } = await supabase.from("events").insert({ user_id: user.id, source: "manual", ...fields });
      if (err) {
        setBusy(false);
        setError(`Couldn't add that event: ${err.message}`);
        return;
      }
    }

    await onSaved();
    setBusy(false);
    onClose();
  }

  async function remove() {
    if (!event) return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const err = await softDelete(supabase, "events", event.id, "Couldn't remove that event");
    if (err) {
      setBusy(false);
      setError(err);
      return;
    }
    await onSaved();
    setBusy(false);
    onClose();
  }

  const field =
    "rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text outline-none focus-visible:border-accent";
  const legend = "text-[10px] tracking-wide uppercase text-muted-2";
  const hint = "text-[10px] text-muted-2";

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        aria-label="Close"
        onClick={onClose}
        className="flex-1 cursor-default"
        style={{ background: "rgba(0,0,0,0.45)" }}
      />
      <div className="relative w-full max-w-[380px] h-full overflow-y-auto border-l border-border bg-panel p-4 flex flex-col gap-4">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className={legend}>{event ? "Event" : "New event"}</div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="what's happening"
              className="w-full bg-transparent text-[13px] text-text leading-snug outline-none border-b border-transparent focus-visible:border-accent"
            />
          </div>
          <button onClick={onClose} aria-label="Close" className="text-muted-2 hover:text-text">
            <XIcon size={14} />
          </button>
        </div>

        <section className="flex flex-col gap-1.5">
          <div className={legend}>When</div>
          <div className="flex items-center gap-1.5">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${field} w-32`} />
            {!allDay && (
              <>
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className={field}
                />
                <span className="text-[11px] text-muted">to</span>
                <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={field} />
              </>
            )}
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-text">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
            All day
          </label>
          {allDay && (
            <div className="flex items-center gap-1.5 pl-5">
              <span className="text-[11px] text-muted">through</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className={`${field} w-32`}
              />
              <span className={hint}>empty = just that day</span>
            </div>
          )}
          <div className={hint}>
            {allDay
              ? "An all-day entry stops anyone booking you, and your own work still gets scheduled around it."
              : "The slot is held — flexible work moves out of the way."}
          </div>
        </section>

        <section className="flex flex-col gap-1.5">
          <div className={legend}>Where</div>
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="optional"
            className={field}
          />
        </section>

        {(error || errors.length > 0) && (
          <div className="text-[10.5px] leading-snug" style={{ color: "#e5484d" }}>
            {error ?? errors[0]}
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={() => void save()}
            disabled={busy || errors.length > 0}
            className="rounded-md border border-accent text-accent px-2.5 py-1 text-[11px] font-medium hover:bg-accent/10 disabled:opacity-50"
          >
            {busy ? "Saving…" : event ? "Save" : "Add it"}
          </button>
          <button onClick={onClose} className="text-[10.5px] text-muted-2 hover:text-text">
            cancel
          </button>
          {event && (
            <div className="ml-auto">
              {confirmDelete ? (
                <span className="text-[10px] text-muted-2">
                  Remove it?{" "}
                  <button onClick={() => void remove()} disabled={busy} className="text-accent-text hover:underline">
                    yes
                  </button>{" "}
                  <button onClick={() => setConfirmDelete(false)} className="hover:underline">
                    no
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  title="The freed time refills automatically"
                  className="flex items-center gap-1 text-[10px] text-muted-2 hover:text-text"
                >
                  <TrashIcon size={11} /> it&apos;s not happening
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
