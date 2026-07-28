"use client";

// Dated nudges grouped under free-text headings. A reminder holds no hours and
// never appears on the calendar — it exists to arrive as a push notification at
// each of its lead times.

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";

type ReminderRow = Database["public"]["Tables"]["reminders"]["Row"];

const LEAD_CHOICES: { minutes: number; label: string }[] = [
  { minutes: 0, label: "at the time" },
  { minutes: 60, label: "1 hour" },
  { minutes: 24 * 60, label: "1 day" },
  { minutes: 3 * 24 * 60, label: "3 days" },
  { minutes: 7 * 24 * 60, label: "1 week" },
  { minutes: 14 * 24 * 60, label: "2 weeks" },
];

function describeLead(minutes: number): string {
  const found = LEAD_CHOICES.find((c) => c.minutes === minutes);
  if (found) return found.minutes === 0 ? found.label : `${found.label} before`;
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} days before`;
  return `${Math.round(minutes / 60)} hours before`;
}

export function RemindersView() {
  const [reminders, setReminders] = useState<ReminderRow[] | null>(null);
  const [showPast, setShowPast] = useState(false);
  const [title, setTitle] = useState("");
  const [heading, setHeading] = useState("");
  const [due, setDue] = useState("");
  const [leads, setLeads] = useState<number[]>([24 * 60]);

  const load = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("reminders").select("*").order("due_at");
    setReminders(data ?? []);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function add() {
    if (!title.trim() || !due) return;
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from("reminders").insert({
      user_id: user.id,
      title: title.trim(),
      heading: heading.trim() || null,
      // datetime-local has no zone; treat it as this device's local time.
      due_at: new Date(due).toISOString(),
      lead_minutes: leads.length ? [...leads].sort((a, b) => b - a) : [24 * 60],
    });
    setTitle("");
    setDue("");
    await load();
  }

  async function remove(id: string) {
    const supabase = createClient();
    await supabase.from("reminders").delete().eq("id", id);
    await load();
  }

  if (reminders === null) return <div className="px-5 py-4 text-[12px] text-muted">Loading…</div>;

  const now = Date.now();
  const visible = reminders.filter((r) => showPast || new Date(r.due_at).getTime() >= now - 24 * 60 * 60 * 1000);
  const groups = new Map<string, ReminderRow[]>();
  for (const r of visible) {
    const key = r.heading?.trim() || "Ungrouped";
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      {/* New reminder */}
      <div className="rounded-lg border border-border bg-panel p-3 mb-4 max-w-3xl">
        <div className="flex gap-2 flex-wrap items-end">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-muted-2">What</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Present IDSC seminar"
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text outline-none focus-visible:border-accent"
              style={{ minWidth: 220 }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-muted-2">Heading</span>
            <input
              value={heading}
              onChange={(e) => setHeading(e.target.value)}
              placeholder="e.g. Presentations"
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text outline-none focus-visible:border-accent"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-muted-2">When</span>
            <input
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text outline-none focus-visible:border-accent"
            />
          </div>
          <button
            onClick={add}
            disabled={!title.trim() || !due}
            className="rounded-md border border-accent text-accent px-3 py-1.5 text-xs font-medium hover:bg-accent/10 disabled:opacity-50"
          >
            Add reminder
          </button>
        </div>

        <div className="mt-2.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-2 mb-1">Notify me (pick any number)</div>
          <div className="flex gap-1.5 flex-wrap">
            {LEAD_CHOICES.map((c) => {
              const on = leads.includes(c.minutes);
              return (
                <button
                  key={c.minutes}
                  onClick={() => setLeads((l) => (on ? l.filter((x) => x !== c.minutes) : [...l, c.minutes]))}
                  className="rounded-md px-2 py-1 text-[11px] border"
                  style={{
                    borderColor: on ? "var(--color-accent)" : "var(--color-border)",
                    background: on ? "rgba(145,132,217,0.08)" : "transparent",
                  }}
                >
                  {c.minutes === 0 ? c.label : `${c.label} before`}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-2">
        <span className="text-[10.5px] text-muted-2">
          Reminders arrive as push notifications. They hold no calendar time — ask the chat for hours separately if
          something needs preparing.
        </span>
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted flex-none">
          <input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} />
          show past
        </label>
      </div>

      {visible.length === 0 && (
        <p className="text-[12px] text-muted">
          Nothing upcoming. Try telling the chat: &ldquo;set a reminder under Presentations that I present the IDSC
          seminar on November 10, and remind me 1 week before and 1 day before&rdquo;.
        </p>
      )}

      <div className="flex flex-col gap-4 max-w-3xl">
        {Array.from(groups.entries()).map(([group, rows]) => (
          <div key={group}>
            <div className="text-[10px] tracking-wide uppercase text-muted-2 mb-1.5">{group}</div>
            <div className="flex flex-col gap-1.5">
              {rows.map((r) => {
                const dueMs = new Date(r.due_at).getTime();
                const past = dueMs < now;
                return (
                  <div
                    key={r.id}
                    className="rounded-md border border-border bg-surface px-3 py-2 flex items-center gap-3"
                    style={{ opacity: past ? 0.55 : 1 }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] text-text truncate">{r.title}</div>
                      <div className="text-[10.5px] text-muted-2">
                        {new Date(r.due_at).toLocaleString(undefined, {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}{" "}
                        · notifies {r.lead_minutes.map(describeLead).join(", ")}
                        {r.sent_leads.length > 0 && ` · ${r.sent_leads.length} sent`}
                      </div>
                    </div>
                    <button
                      onClick={() => remove(r.id)}
                      className="flex-none text-[10.5px] text-muted-2 hover:text-text"
                    >
                      delete
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
