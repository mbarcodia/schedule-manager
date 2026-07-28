"use client";

// Visitor-facing booking flow: duration → week-paged slot grid (shown in the
// VISITOR's local timezone) → details form → confirmation with the meeting
// link and an .ics download.

import { useCallback, useEffect, useMemo, useState } from "react";

interface Slot {
  startIso: string;
  durationMin: number;
}

interface Confirmation {
  startIso: string;
  endIso: string;
  title: string;
  locationMode: LocationMode;
  locationText: string | null;
  joinUrl: string | null;
  manageUrl: string;
  googleInviteSent: boolean;
  ics: string;
}

type LocationMode = "zoom" | "office";

const visitorTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

interface BookingClientProps {
  slug: string;
  title: string;
  durations: number[];
  locationModes: LocationMode[];
  officeLocation: string | null;
  ownerName: string | null;
}

export function BookingClient({ slug, title, durations, locationModes, officeLocation, ownerName }: BookingClientProps) {
  const [duration, setDuration] = useState(durations[0]);
  const [locationMode, setLocationMode] = useState<LocationMode>(locationModes[0] ?? "zoom");
  const [week, setWeek] = useState(0);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [selected, setSelected] = useState<Slot | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Confirmation | null>(null);

  const loadSlots = useCallback(async () => {
    setSlots(null);
    const res = await fetch(`/api/book/${slug}/slots?duration=${duration}&week=${week}`);
    if (!res.ok) {
      setSlots([]);
      return;
    }
    const data = await res.json();
    setSlots(data.slots);
  }, [slug, duration, week]);

  useEffect(() => {
    // Fetch-on-parameter-change; standard pattern in this codebase.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected(null);
    void loadSlots();
  }, [loadSlots]);

  // Group slots into visitor-local days.
  const days = useMemo(() => {
    if (!slots) return [];
    const byDay = new Map<string, Slot[]>();
    for (const s of slots) {
      const d = new Date(s.startIso);
      const key = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(s);
    }
    return Array.from(byDay.entries());
  }, [slots]);

  async function submit() {
    if (!selected || !name.trim() || !email.trim()) return;
    setSubmitting(true);
    setError(null);
    const res = await fetch(`/api/book/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startIso: selected.startIso,
        durationMin: selected.durationMin,
        name: name.trim(),
        email: email.trim(),
        note: note.trim() || undefined,
        locationMode,
      }),
    });
    setSubmitting(false);
    if (res.status === 409) {
      setError("That time was just taken — please pick another slot.");
      setSelected(null);
      void loadSlots();
      return;
    }
    if (!res.ok) {
      setError("Something went wrong — please try again.");
      return;
    }
    setConfirmed(await res.json());
  }

  function downloadIcs() {
    if (!confirmed) return;
    const blob = new Blob([confirmed.ics], { type: "text/calendar" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "meeting.ics";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const fmtFull = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  if (confirmed) {
    return (
      <div className="flex-1 overflow-y-auto flex justify-center px-6 py-10">
        <div className="w-full max-w-md">
          <h1 className="text-lg font-medium mb-2">You&apos;re booked ✓</h1>
          <p className="text-sm text-muted mb-4">
            {confirmed.title} — {fmtFull(confirmed.startIso)} ({visitorTz()})
          </p>
          <div className="rounded-lg border border-border bg-panel p-3.5 mb-3 text-sm">
            <div className="text-xs text-muted mb-1">Where</div>
            {confirmed.locationMode === "office" ? (
              <div className="text-text">{confirmed.locationText || "In person"}</div>
            ) : confirmed.joinUrl ? (
              <a href={confirmed.joinUrl} className="text-accent-text hover:underline break-all">
                {confirmed.joinUrl}
              </a>
            ) : (
              <div className="text-text">Video call — your meeting link will be emailed to you.</div>
            )}
          </div>
          <p className="text-xs text-muted mb-4">
            {confirmed.googleInviteSent
              ? "A calendar invitation is on its way to your email."
              : "Save the details — add the meeting to your calendar below."}
          </p>
          <div className="flex flex-col gap-3 items-start">
            <button
              onClick={downloadIcs}
              className="rounded-md border border-accent text-accent px-3.5 py-2 text-sm font-medium hover:bg-accent/10"
            >
              Add to calendar (.ics)
            </button>
            <a href={confirmed.manageUrl} className="text-xs text-muted hover:text-text underline underline-offset-2">
              Need to reschedule or cancel?
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto flex justify-center px-6 py-10">
      <div className="w-full max-w-2xl">
        <h1 className="text-lg font-medium mb-1">
          {ownerName ? `Book a Meeting with ${ownerName}` : title}
        </h1>
        <p className="text-xs text-muted mb-5">
          {ownerName ? `${title} · ` : ""}Times shown in your timezone ({visitorTz()}).
        </p>

        {/* Duration picker */}
        {durations.length > 1 && (
          <div className="flex gap-1.5 mb-5">
            {durations.map((d) => (
              <button
                key={d}
                onClick={() => setDuration(d)}
                className="rounded-md px-3 py-1.5 text-sm border"
                style={{
                  borderColor: duration === d ? "var(--color-accent)" : "var(--color-border)",
                  background: duration === d ? "rgba(145,132,217,0.08)" : "transparent",
                }}
              >
                {d} min
              </button>
            ))}
          </div>
        )}

        {/* Location picker — only shown when the link offers a choice */}
        {locationModes.length > 1 && (
          <div className="mb-5">
            <div className="text-xs text-muted mb-1.5">Where should this meeting happen?</div>
            <div className="flex gap-1.5 flex-wrap">
              {locationModes.map((m) => (
                <button
                  key={m}
                  onClick={() => setLocationMode(m)}
                  className="rounded-md px-3 py-1.5 text-sm border"
                  style={{
                    borderColor: locationMode === m ? "var(--color-accent)" : "var(--color-border)",
                    background: locationMode === m ? "rgba(145,132,217,0.08)" : "transparent",
                  }}
                >
                  {m === "office" ? "In person" : "Video call"}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted">
              {locationMode === "office"
                ? officeLocation
                  ? `We'll meet at ${officeLocation}.`
                  : "We'll meet in person."
                : "Your meeting link will be emailed to you."}
            </p>
          </div>
        )}

        {/* Week pager */}
        <div className="flex items-center gap-3 mb-3 text-sm">
          <button
            onClick={() => setWeek((w) => Math.max(0, w - 1))}
            disabled={week === 0}
            className="text-accent-text hover:underline disabled:opacity-40"
          >
            ← earlier
          </button>
          <span className="text-xs text-muted">{week === 0 ? "This week" : `${week} week${week > 1 ? "s" : ""} out`}</span>
          <button
            onClick={() => setWeek((w) => Math.min(11, w + 1))}
            disabled={week === 11}
            className="text-accent-text hover:underline disabled:opacity-40"
          >
            later →
          </button>
        </div>

        {/* Slot grid */}
        {slots === null ? (
          <p className="text-sm text-muted py-8">Loading times…</p>
        ) : days.length === 0 ? (
          <p className="text-sm text-muted py-8">No times available this week — try a later week.</p>
        ) : (
          <div className="flex flex-col gap-4 mb-6">
            {days.map(([day, daySlots]) => (
              <div key={day}>
                <div className="text-xs font-medium text-muted mb-1.5">{day}</div>
                <div className="flex gap-1.5 flex-wrap">
                  {daySlots.map((s) => (
                    <button
                      key={s.startIso}
                      onClick={() => setSelected(s)}
                      className="rounded-md px-2.5 py-1.5 text-sm border"
                      style={{
                        borderColor: selected?.startIso === s.startIso ? "var(--color-accent)" : "var(--color-border)",
                        background: selected?.startIso === s.startIso ? "rgba(145,132,217,0.12)" : "transparent",
                      }}
                    >
                      {fmtTime(s.startIso)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Details form */}
        {selected && (
          <div className="rounded-lg border border-border bg-panel p-4 mb-6">
            <div className="text-sm text-text mb-3">
              {fmtFull(selected.startIso)} · {selected.durationMin} min
            </div>
            <div className="flex flex-col gap-2.5">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                maxLength={120}
                className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus-visible:border-accent"
              />
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                placeholder="Your email (for the calendar invite)"
                maxLength={254}
                className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus-visible:border-accent"
              />
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What would you like to discuss? (optional)"
                maxLength={1000}
                rows={3}
                className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus-visible:border-accent resize-none"
              />
              {error && <p className="text-xs" style={{ color: "#e5484d" }}>{error}</p>}
              <button
                onClick={submit}
                disabled={submitting || !name.trim() || !email.trim()}
                className="self-start rounded-md border border-accent text-accent px-4 py-2 text-sm font-medium hover:bg-accent/10 disabled:opacity-50"
              >
                {submitting ? "Booking…" : "Confirm booking"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
