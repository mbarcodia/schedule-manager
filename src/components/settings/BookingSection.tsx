"use client";

// Settings section for the public booking feature: Google Calendar
// connection, the static meeting-room URL, and booking-link management.
// Extracted from settings/page.tsx (which is already ~1100 lines).

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Database, BookingDayWindowsJson, BookingLocationMode } from "@/lib/supabase/database.types";

type BookingLinkRow = Database["public"]["Tables"]["booking_links"]["Row"];
type CategoryRow = Database["public"]["Tables"]["categories"]["Row"];

interface UpcomingBooking {
  id: string;
  starts_at: string;
  duration_min: number;
  visitor_name: string;
  visitor_email: string;
  location_mode: BookingLocationMode;
}

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
  const [displayName, setDisplayName] = useState("");
  const [officeLocation, setOfficeLocation] = useState("");
  const [profileSaved, setProfileSaved] = useState(false);
  /** False until the profile row is actually in hand. Saving before that would
   * write the empty initial state over real values — which is exactly how a
   * previously-saved meeting URL got wiped. */
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [bookings, setBookings] = useState<UpcomingBooking[]>([]);
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
    const [statusRes, { data: profile }, { data: linkRows }, { data: bookingRows }] = await Promise.all([
      fetch("/api/google/status").then((r) => (r.ok ? r.json() : null)),
      supabase
        .from("profiles")
        .select("booking_meeting_url,display_name,office_location")
        .eq("id", user.id)
        .single(),
      supabase.from("booking_links").select("*").order("created_at"),
      supabase
        .from("bookings")
        .select("id,starts_at,duration_min,visitor_name,visitor_email,location_mode")
        .eq("status", "confirmed")
        .gte("starts_at", new Date().toISOString())
        .order("starts_at")
        .limit(20),
    ]);
    if (statusRes) setGoogle(statusRes);
    if (profile) {
      setMeetingUrl(profile.booking_meeting_url ?? "");
      setDisplayName(profile.display_name ?? "");
      setOfficeLocation(profile.office_location ?? "");
      setProfileLoaded(true);
    }
    setLinks(linkRows ?? []);
    setBookings(bookingRows ?? []);
  }, []);

  useEffect(() => {
    // Fetch-on-mount, same caveat as useScheduleData.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function saveProfile() {
    if (!profileLoaded) return; // never overwrite with un-loaded state
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase
      .from("profiles")
      .update({
        booking_meeting_url: meetingUrl.trim() || null,
        display_name: displayName.trim() || null,
        office_location: officeLocation.trim() || null,
      })
      .eq("id", user.id);
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2000);
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
    // Offer whichever locations are set up — a link with both is what makes the
    // visitor-facing "where should this happen?" choice appear.
    const location_modes: BookingLocationMode[] = [
      ...(meetingUrl.trim() ? (["zoom"] as const) : []),
      ...(officeLocation.trim() ? (["office"] as const) : []),
    ];
    for (let attempt = 0; attempt < 3; attempt++) {
      const { error } = await supabase.from("booking_links").insert({
        user_id: user.id,
        slug: randomSlug(),
        title: "Meeting",
        durations: [20, 30, 60],
        day_windows,
        ...(location_modes.length ? { location_modes } : {}),
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
      <h2 id="booking" className="text-base font-medium mb-1 scroll-mt-4">Booking page</h2>
      <p className="text-xs text-muted mb-4">
        A public link (like Calendly) where anyone can book time with you. Slots come from your working hours,
        connected calendars, and protected task categories — booked meetings land on your calendar automatically.
      </p>

      {/* Setup checklist — guides a brand-new account through its own setup
          rather than assuming everything is already configured. */}
      {(() => {
        const steps = [
          { done: displayName.trim().length > 0, label: "Add your name" },
          { done: meetingUrl.trim().length > 0 || officeLocation.trim().length > 0, label: "Add a meeting location" },
          { done: !!google?.connected, label: "Connect Google Calendar (optional — sends email invites)" },
          { done: links.length > 0, label: "Create a booking link" },
        ];
        const remaining = steps.filter((st) => !st.done);
        if (remaining.length === 0) return null;
        return (
          <div className="rounded-lg border border-border bg-panel p-3.5 mb-3">
            <div className="text-xs text-text mb-1.5">Finish setting up your booking page</div>
            <ul className="flex flex-col gap-1">
              {steps.map((st) => (
                <li key={st.label} className="text-[11px] flex items-center gap-1.5">
                  <span style={{ color: st.done ? "#3dd68c" : "var(--color-muted-2, #75798c)" }}>
                    {st.done ? "✓" : "○"}
                  </span>
                  <span className={st.done ? "text-muted-2 line-through" : "text-muted"}>{st.label}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })()}

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

      {/* Your details: name + the two meeting locations */}
      <div className="rounded-lg border border-border bg-panel p-3.5 mb-3 flex flex-col gap-3">
        <div>
          <div className="text-xs text-text mb-1">Your name, as guests should see it</div>
          <p className="text-[11px] text-muted mb-1.5">
            Invitations are titled &ldquo;Guest name &lt;&gt; your name&rdquo;. Without this they fall back to the
            link&apos;s title.
          </p>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Jordan Ellis"
            className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text outline-none focus-visible:border-accent"
          />
        </div>
        <div>
          <div className="text-xs text-text mb-1">Video meeting link</div>
          <p className="text-[11px] text-muted mb-1.5">
            Your personal meeting room (e.g. Zoom). Emailed with the invitation rather than shown on the public page.
          </p>
          <input
            value={meetingUrl}
            onChange={(e) => setMeetingUrl(e.target.value)}
            placeholder="https://your-org.zoom.us/j/…"
            className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text outline-none focus-visible:border-accent"
          />
        </div>
        <div>
          <div className="text-xs text-text mb-1">In-person location</div>
          <p className="text-[11px] text-muted mb-1.5">
            Shown to guests who choose to meet in person, and written onto the calendar event.
          </p>
          <input
            value={officeLocation}
            onChange={(e) => setOfficeLocation(e.target.value)}
            placeholder="e.g. Science Building, room 412"
            className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text outline-none focus-visible:border-accent"
          />
        </div>
        <button
          onClick={saveProfile}
          disabled={!profileLoaded}
          title={profileLoaded ? undefined : "Still loading your current settings"}
          className="self-start rounded-md border border-accent text-accent px-3 py-1.5 text-xs font-medium hover:bg-accent/10 disabled:opacity-50"
        >
          {profileSaved ? "Saved" : "Save details"}
        </button>
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
              <span className="text-[10px] text-muted-2 flex-none">
                {link.location_modes.length > 1
                  ? "guest picks video or in person"
                  : link.location_modes[0] === "office"
                    ? "in person only"
                    : "video only — enable “In person” in edit to let guests choose"}
              </span>
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

            {/* Every rule this link enforces, in words — so you don't have to
                open the editor to know what guests can and can't do. */}
            <p className="mt-1.5 text-[10.5px] text-muted leading-relaxed">
              {link.durations.join(" / ")} min ·{" "}
              {(() => {
                const open = DOW_LABELS.map((d, i) => ({ d, w: link.day_windows[String(i)] ?? null })).filter((x) => x.w);
                if (!open.length) return "no bookable days set";
                const earliest = Math.min(...open.map((x) => x.w!.start));
                const latest = Math.max(...open.map((x) => x.w!.end));
                return `${open.map((x) => x.d).join(", ")}, no earlier than ${minToLabel(earliest)} and no later than ${minToLabel(latest)}`;
              })()}{" "}
              · at least {link.min_notice_hours}h notice · max {link.max_per_day}/day
              {link.buffer_min > 0 ? ` · ${link.buffer_min}m gap around meetings` : " · no gap enforced"}
              {link.blocking_category_ids.length > 0
                ? ` · ${link.blocking_category_ids.length} protected categor${link.blocking_category_ids.length > 1 ? "ies" : "y"}`
                : ""}
            </p>

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

                {/* Locations offered */}
                <div>
                  <div className="text-[11px] text-muted mb-1">
                    Where can this meeting happen? (guests pick when both are offered)
                  </div>
                  <div className="flex gap-1.5 flex-wrap">
                    {(["zoom", "office"] as BookingLocationMode[]).map((m) => {
                      const on = link.location_modes.includes(m);
                      const missing = m === "zoom" ? !meetingUrl.trim() : !officeLocation.trim();
                      return (
                        <button
                          key={m}
                          onClick={() => {
                            const next = on
                              ? link.location_modes.filter((x) => x !== m)
                              : [...link.location_modes, m];
                            if (next.length === 0) return; // at least one
                            void updateLink(link.id, { location_modes: next });
                          }}
                          title={missing ? "Add this location above first" : undefined}
                          className="rounded-md px-2 py-1 text-[11px] border"
                          style={{
                            borderColor: on ? "var(--color-accent)" : "var(--color-border)",
                            background: on ? "rgba(145,132,217,0.08)" : "transparent",
                            opacity: on && missing ? 0.6 : 1,
                          }}
                        >
                          {m === "zoom" ? "Video call" : "In person"}
                          {on && missing ? " (not set up)" : ""}
                        </button>
                      );
                    })}
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

      {/* Upcoming bookings */}
      {bookings.length > 0 && (
        <div className="mt-5">
          <div className="text-xs text-text mb-2">Upcoming bookings</div>
          <div className="flex flex-col gap-1.5">
            {bookings.map((b) => (
              <div
                key={b.id}
                className="rounded-md border border-border bg-surface px-3 py-2 flex items-center gap-3 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-text truncate">
                    {b.visitor_name} · {b.duration_min}m · {b.location_mode === "office" ? "in person" : "video"}
                  </div>
                  <div className="text-[10.5px] text-muted-2">
                    {new Date(b.starts_at).toLocaleString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}{" "}
                    · {b.visitor_email}
                  </div>
                </div>
                <a
                  href={`/book/manage/${b.id}`}
                  className="flex-none text-accent-text hover:underline whitespace-nowrap"
                >
                  Reschedule / cancel
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
