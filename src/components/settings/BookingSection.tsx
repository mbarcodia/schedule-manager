"use client";

// Settings section for the public booking feature: Google Calendar
// connection, the static meeting-room URL, and booking-link management.
// Extracted from settings/page.tsx (which is already ~1100 lines).

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Database, BookingDayWindowsJson } from "@/lib/supabase/database.types";

type BookingLinkRow = Database["public"]["Tables"]["booking_links"]["Row"];
type CategoryRow = Database["public"]["Tables"]["categories"]["Row"];

interface GoogleStatus {
  connected: boolean;
  email?: string;
  needsReconnect?: boolean;
}

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DURATION_CHOICES = [15, 20, 30, 45, 60, 90];

function randomSlug(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => alphabet[b % 62]).join("");
}

function minToLabel(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const ampm = h >= 12 ? "pm" : "am";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return min ? `${hh}:${String(min).padStart(2, "0")}${ampm}` : `${hh}${ampm}`;
}

export function BookingSection({ categories }: { categories: CategoryRow[] }) {
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [meetingUrl, setMeetingUrl] = useState("");
  const [meetingUrlSaved, setMeetingUrlSaved] = useState(false);
  const [links, setLinks] = useState<BookingLinkRow[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const [statusRes, { data: profile }, { data: linkRows }] = await Promise.all([
      fetch("/api/google/status").then((r) => (r.ok ? r.json() : null)),
      supabase.from("profiles").select("booking_meeting_url").eq("id", user.id).single(),
      supabase.from("booking_links").select("*").order("created_at"),
    ]);
    if (statusRes) setGoogle(statusRes);
    setMeetingUrl(profile?.booking_meeting_url ?? "");
    setLinks(linkRows ?? []);
  }, []);

  useEffect(() => {
    // Fetch-on-mount, same caveat as useScheduleData.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function saveMeetingUrl() {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase
      .from("profiles")
      .update({ booking_meeting_url: meetingUrl.trim() || null })
      .eq("id", user.id);
    setMeetingUrlSaved(true);
    setTimeout(() => setMeetingUrlSaved(false), 2000);
  }

  async function disconnectGoogle() {
    if (!confirm("Disconnect Google Calendar? Future bookings will no longer create Google events or email invites.")) return;
    await fetch("/api/google/status", { method: "DELETE" });
    setGoogle({ connected: false });
  }

  async function createLink() {
    setBusy(true);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setBusy(false);
      return;
    }
    // Default: Mon-Fri 10:00-16:00, 30-minute meetings.
    const day_windows: BookingDayWindowsJson = {};
    for (let d = 0; d < 7; d++) day_windows[String(d)] = d < 5 ? { start: 600, end: 960 } : null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { error } = await supabase.from("booking_links").insert({
        user_id: user.id,
        slug: randomSlug(),
        title: "Meeting",
        durations: [20, 30, 60],
        day_windows,
      });
      if (!error) break; // unique slug collision is ~impossible; retry anyway
    }
    await load();
    setBusy(false);
  }

  async function updateLink(id: string, patch: Database["public"]["Tables"]["booking_links"]["Update"]) {
    const supabase = createClient();
    await supabase.from("booking_links").update(patch).eq("id", id);
    setLinks((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } as BookingLinkRow : l)));
  }

  async function deleteLink(id: string) {
    if (!confirm("Delete this booking link? Its page stops working immediately (past bookings are kept).")) return;
    const supabase = createClient();
    await supabase.from("booking_links").delete().eq("id", id);
    setLinks((prev) => prev.filter((l) => l.id !== id));
  }

  function copyUrl(slug: string) {
    void navigator.clipboard.writeText(`${window.location.origin}/book/${slug}`);
    setCopied(slug);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <div className="mt-8 pt-5 border-t border-border">
      <h2 className="text-base font-medium mb-1">Booking page</h2>
      <p className="text-xs text-muted mb-4">
        A public link (like Calendly) where anyone can book time with you. Slots come from your working hours,
        connected calendars, and protected task categories — booked meetings land on your calendar automatically.
      </p>

      {/* Google connection */}
      <div className="rounded-lg border border-border bg-panel p-3.5 mb-3">
        {google === null ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : google.connected ? (
          <div className="flex items-center gap-2.5 text-xs flex-wrap">
            {google.needsReconnect ? (
              <span style={{ color: "#e0a94e" }}>
                Google Calendar needs to be reconnected — invites aren&apos;t sending.
              </span>
            ) : (
              <span className="text-text">
                Google Calendar connected ({google.email || "account"}) — bookings create events with email invites.
              </span>
            )}
            {google.needsReconnect && (
              <a href="/api/google/connect" className="text-accent-text hover:underline">
                Reconnect
              </a>
            )}
            <button onClick={disconnectGoogle} className="text-accent-text hover:underline">
              Disconnect
            </button>
          </div>
        ) : (
          <div className="text-xs text-muted leading-relaxed">
            <p className="mb-2">
              Connect your <span className="text-text">personal</span> Google Calendar so booked meetings are created
            there with the visitor invited by email (they get Google&apos;s standard invitation — no separate email
              service needed). Without it, bookings still appear here in the app and you still get a push
              notification.
            </p>
            <a
              href="/api/google/connect"
              className="inline-block rounded-md border border-accent text-accent px-3 py-1.5 text-xs font-medium hover:bg-accent/10"
            >
              Connect Google Calendar
            </a>
          </div>
        )}
      </div>

      {/* Meeting room URL */}
      <div className="rounded-lg border border-border bg-panel p-3.5 mb-3">
        <div className="text-xs text-text mb-1.5">Meeting link attached to every booking</div>
        <p className="text-[11px] text-muted mb-2">
          Your personal meeting room URL (e.g. Zoom). Included on the calendar event, the Google invite, and the
          visitor&apos;s confirmation.
        </p>
        <div className="flex gap-2">
          <input
            value={meetingUrl}
            onChange={(e) => setMeetingUrl(e.target.value)}
            placeholder="https://miami.zoom.us/j/…"
            className="flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text outline-none focus-visible:border-accent"
          />
          <button
            onClick={saveMeetingUrl}
            className="rounded-md border border-accent text-accent px-3 py-1.5 text-xs font-medium hover:bg-accent/10"
          >
            {meetingUrlSaved ? "Saved" : "Save"}
          </button>
        </div>
      </div>

      {/* Links */}
      <div className="flex flex-col gap-2">
        {links.map((link) => (
          <div key={link.id} className="rounded-lg border border-border bg-panel p-3.5">
            <div className="flex items-center gap-2 flex-wrap">
              <input
                value={link.title}
                onChange={(e) => setLinks((prev) => prev.map((l) => (l.id === link.id ? { ...l, title: e.target.value } : l)))}
                onBlur={(e) => void updateLink(link.id, { title: e.target.value.trim() || "Meeting" })}
                className="bg-transparent text-[13px] font-medium text-text outline-none border-b border-transparent focus-visible:border-accent min-w-0"
                style={{ width: `${Math.max(link.title.length, 8)}ch` }}
              />
              <span className="text-[10px] text-muted-2 font-mono truncate">/book/{link.slug}</span>
              <div className="ml-auto flex items-center gap-2.5 text-[11px]">
                <button onClick={() => copyUrl(link.slug)} className="text-accent-text hover:underline">
                  {copied === link.slug ? "Copied!" : "Copy URL"}
                </button>
                <label className="flex items-center gap-1 text-muted">
                  <input
                    type="checkbox"
                    checked={link.active}
                    onChange={(e) => void updateLink(link.id, { active: e.target.checked })}
                  />
                  active
                </label>
                <button
                  onClick={() => setExpanded(expanded === link.id ? null : link.id)}
                  className="text-muted hover:text-text"
                >
                  {expanded === link.id ? "close" : "edit"}
                </button>
                <button onClick={() => void deleteLink(link.id)} className="text-muted-2 hover:text-text">
                  delete
                </button>
              </div>
            </div>

            {expanded === link.id && (
              <div className="mt-3 pt-3 border-t border-border flex flex-col gap-3 text-xs">
                {/* Durations */}
                <div>
                  <div className="text-[11px] text-muted mb-1">Meeting lengths visitors can pick</div>
                  <div className="flex gap-1.5 flex-wrap">
                    {DURATION_CHOICES.map((d) => {
                      const on = link.durations.includes(d);
                      return (
                        <button
                          key={d}
                          onClick={() => {
                            const next = on ? link.durations.filter((x) => x !== d) : [...link.durations, d].sort((a, b) => a - b);
                            if (next.length === 0) return; // at least one
                            void updateLink(link.id, { durations: next });
                          }}
                          className="rounded-md px-2 py-1 text-[11px] border"
                          style={{
                            borderColor: on ? "var(--color-accent)" : "var(--color-border)",
                            background: on ? "rgba(145,132,217,0.08)" : "transparent",
                          }}
                        >
                          {d}m
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Day windows */}
                <div>
                  <div className="text-[11px] text-muted mb-1">
                    Bookable days & times (also limited by your standard hours)
                  </div>
                  <div className="flex flex-col gap-1">
                    {DOW_LABELS.map((label, dow) => {
                      const win = link.day_windows[String(dow)] ?? null;
                      return (
                        <div key={dow} className="flex items-center gap-2">
                          <label className="flex items-center gap-1.5 w-14">
                            <input
                              type="checkbox"
                              checked={win != null}
                              onChange={(e) => {
                                const next = { ...link.day_windows, [String(dow)]: e.target.checked ? { start: 600, end: 960 } : null };
                                void updateLink(link.id, { day_windows: next });
                              }}
                            />
                            <span className="text-muted">{label}</span>
                          </label>
                          {win && (
                            <>
                              <select
                                value={win.start}
                                onChange={(e) => {
                                  const start = Number(e.target.value);
                                  const next = { ...link.day_windows, [String(dow)]: { start, end: Math.max(win.end, start + 60) } };
                                  void updateLink(link.id, { day_windows: next });
                                }}
                                className="rounded-md border border-border bg-surface px-1.5 py-1 text-[11px] text-text"
                              >
                                {Array.from({ length: 29 }, (_, i) => 6 * 60 + i * 30).map((m) => (
                                  <option key={m} value={m}>
                                    {minToLabel(m)}
                                  </option>
                                ))}
                              </select>
                              <span className="text-muted-2">to</span>
                              <select
                                value={win.end}
                                onChange={(e) => {
                                  const end = Number(e.target.value);
                                  const next = { ...link.day_windows, [String(dow)]: { start: Math.min(win.start, end - 60), end } };
                                  void updateLink(link.id, { day_windows: next });
                                }}
                                className="rounded-md border border-border bg-surface px-1.5 py-1 text-[11px] text-text"
                              >
                                {Array.from({ length: 29 }, (_, i) => 7 * 60 + i * 30).map((m) => (
                                  <option key={m} value={m}>
                                    {minToLabel(m)}
                                  </option>
                                ))}
                              </select>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Blocking categories */}
                <div>
                  <div className="text-[11px] text-muted mb-1">
                    Protected task categories (their scheduled time can&apos;t be booked over; other task time
                    reschedules automatically)
                  </div>
                  <div className="flex gap-1.5 flex-wrap">
                    {categories.map((c) => {
                      const on = link.blocking_category_ids.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          onClick={() => {
                            const next = on
                              ? link.blocking_category_ids.filter((x) => x !== c.id)
                              : [...link.blocking_category_ids, c.id];
                            void updateLink(link.id, { blocking_category_ids: next });
                          }}
                          className="rounded-md px-2 py-1 text-[11px] border"
                          style={{
                            borderColor: on ? c.color : "var(--color-border)",
                            background: on ? "rgba(145,132,217,0.08)" : "transparent",
                          }}
                        >
                          {c.name}
                        </button>
                      );
                    })}
                    {categories.length === 0 && <span className="text-[11px] text-muted-2">no categories yet</span>}
                  </div>
                </div>

                {/* Numbers */}
                <div className="flex gap-4 flex-wrap items-center">
                  <label className="flex items-center gap-1.5 text-muted">
                    Buffer
                    <select
                      value={link.buffer_min}
                      onChange={(e) => void updateLink(link.id, { buffer_min: Number(e.target.value) })}
                      className="rounded-md border border-border bg-surface px-1.5 py-1 text-[11px] text-text"
                    >
                      {[0, 10, 15, 30].map((m) => (
                        <option key={m} value={m}>
                          {m}m
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5 text-muted">
                    Min notice
                    <select
                      value={link.min_notice_hours}
                      onChange={(e) => void updateLink(link.id, { min_notice_hours: Number(e.target.value) })}
                      className="rounded-md border border-border bg-surface px-1.5 py-1 text-[11px] text-text"
                    >
                      {[2, 4, 12, 24, 48].map((h) => (
                        <option key={h} value={h}>
                          {h}h
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5 text-muted">
                    Max/day
                    <select
                      value={link.max_per_day}
                      onChange={(e) => void updateLink(link.id, { max_per_day: Number(e.target.value) })}
                      className="rounded-md border border-border bg-surface px-1.5 py-1 text-[11px] text-text"
                    >
                      {[1, 2, 3, 5, 8].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            )}
          </div>
        ))}

        <button
          onClick={createLink}
          disabled={busy}
          className="self-start text-xs text-accent hover:underline disabled:opacity-50"
        >
          + New booking link
        </button>
      </div>
    </div>
  );
}
