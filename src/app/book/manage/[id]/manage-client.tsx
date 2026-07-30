"use client";

// Cancel or move an existing booking. Reachable by whoever holds the link:
// the guest (from their confirmation/invite) or the owner (from Settings).

import { useCallback, useEffect, useState } from "react";

interface BookingInfo {
  startIso: string;
  durationMin: number;
  status: "confirmed" | "cancelled";
  visitorName: string;
  locationMode: "zoom" | "office";
  officeLocation: string | null;
  ownerName: string | null;
  title: string;
  slug: string | null;
  locationModes: ("zoom" | "office")[];
}

interface Slot {
  startIso: string;
  durationMin: number;
}

const visitorTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const fmtFull = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export function ManageClient({ bookingId }: { bookingId: string }) {
  const [info, setInfo] = useState<BookingInfo | null>(null);
  const [mode, setMode] = useState<"view" | "picking">("view");
  /** Changing a meeting re-asks where it happens, not just when. Seeded from
   * the booking's current location once info arrives. */
  const [locationMode, setLocationMode] = useState<"zoom" | "office" | null>(null);
  const [week, setWeek] = useState(0);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"cancelled" | "moved" | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/book/manage/${bookingId}`);
    if (res.ok) {
      const data: BookingInfo = await res.json();
      setInfo(data);
      setLocationMode(data.locationMode);
    }
  }, [bookingId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const loadSlots = useCallback(async () => {
    if (!info?.slug) return;
    setSlots(null);
    const res = await fetch(`/api/book/${info.slug}/slots?duration=${info.durationMin}&week=${week}`);
    setSlots(res.ok ? (await res.json()).slots : []);
  }, [info, week]);

  useEffect(() => {
    if (mode !== "picking") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSlots();
  }, [mode, loadSlots]);

  async function act(body: Record<string, unknown>, outcome: "cancelled" | "moved") {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/book/manage/${bookingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      setError(
        data.error === "slot_taken"
          ? "That time was just taken — pick another."
          : data.error === "already_cancelled"
            ? "This meeting was already cancelled."
            : "That didn't work — please reload and try again.",
      );
      if (data.error === "slot_taken") void loadSlots();
      return;
    }
    if (!res.ok) {
      setError("Something went wrong — please try again.");
      return;
    }
    const data = await res.json();
    if (data.ics) {
      const blob = new Blob([data.ics], { type: "text/calendar" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = outcome === "cancelled" ? "cancelled-meeting.ics" : "updated-meeting.ics";
      a.click();
      URL.revokeObjectURL(a.href);
    }
    setDone(outcome);
    void load();
  }

  if (!info) {
    return (
      <div className="flex-1 flex justify-center px-6 py-10">
        <p className="text-sm text-muted">Loading…</p>
      </div>
    );
  }

  const heading = info.ownerName ? `${info.visitorName} <> ${info.ownerName}` : info.title;

  return (
    <div className="flex-1 overflow-y-auto flex justify-center px-6 py-10">
      <div className="w-full max-w-md">
        <h1 className="text-lg font-medium mb-1">{heading}</h1>

        {done === "cancelled" || info.status === "cancelled" ? (
          <p className="text-sm text-muted">
            This meeting is cancelled. Nothing further is needed — the calendar entry has been removed.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted mb-1">
              {fmtFull(info.startIso)} · {info.durationMin} min ({visitorTz()})
            </p>
            <p className="text-xs text-muted mb-5">
              {info.locationMode === "office"
                ? `In person${info.officeLocation ? ` — ${info.officeLocation}` : ""}`
                : "Video call — the join link is in your calendar invitation."}
            </p>

            {done === "moved" && (
              <p className="text-sm mb-4" style={{ color: "#3dd68c" }}>
                Changed — everyone&apos;s calendars have been updated.
              </p>
            )}
            {error && (
              <p className="text-sm mb-4" style={{ color: "#e5484d" }}>
                {error}
              </p>
            )}

            {mode === "view" ? (
              <div className="flex gap-2">
                {info.slug && (
                  <button
                    onClick={() => setMode("picking")}
                    className="rounded-md border border-accent text-accent px-3.5 py-2 text-sm font-medium hover:bg-accent/10"
                  >
                    Change
                  </button>
                )}
                <button
                  onClick={() => void act({ action: "cancel" }, "cancelled")}
                  disabled={busy}
                  className="rounded-md border border-border text-muted px-3.5 py-2 text-sm hover:text-text disabled:opacity-50"
                >
                  {busy ? "Cancelling…" : "Cancel meeting"}
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 mb-3 text-sm">
                  <button
                    onClick={() => setWeek((w) => Math.max(0, w - 1))}
                    disabled={week === 0}
                    className="text-accent-text hover:underline disabled:opacity-40"
                  >
                    ← earlier
                  </button>
                  <span className="text-xs text-muted">
                    {week === 0 ? "This week" : `${week} week${week > 1 ? "s" : ""} out`}
                  </span>
                  <button
                    onClick={() => setWeek((w) => Math.min(11, w + 1))}
                    disabled={week === 11}
                    className="text-accent-text hover:underline disabled:opacity-40"
                  >
                    later →
                  </button>
                  <button onClick={() => setMode("view")} className="ml-auto text-xs text-muted hover:text-text">
                    keep current booking
                  </button>
                </div>

                {info.locationModes.length > 1 && (
                  <div className="mb-3">
                    <div className="text-xs text-muted mb-1.5">Where should it happen?</div>
                    <div className="flex gap-1.5 flex-wrap">
                      {info.locationModes.map((m) => (
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
                        ? info.officeLocation
                          ? `We'll meet at ${info.officeLocation}.`
                          : "We'll meet in person."
                        : "Your meeting link will be emailed to you."}
                    </p>
                  </div>
                )}

                {slots === null ? (
                  <p className="text-sm text-muted py-6">Loading times…</p>
                ) : slots.length === 0 ? (
                  <p className="text-sm text-muted py-6">No times available this week — try a later week.</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {Object.entries(
                      slots.reduce<Record<string, Slot[]>>((acc, s) => {
                        const key = new Date(s.startIso).toLocaleDateString(undefined, {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                        });
                        (acc[key] ??= []).push(s);
                        return acc;
                      }, {}),
                    ).map(([day, daySlots]) => (
                      <div key={day}>
                        <div className="text-xs font-medium text-muted mb-1.5">{day}</div>
                        <div className="flex gap-1.5 flex-wrap">
                          {daySlots.map((s) => (
                            <button
                              key={s.startIso}
                              disabled={busy}
                              onClick={() =>
                                void act(
                                  { action: "reschedule", startIso: s.startIso, locationMode: locationMode ?? undefined },
                                  "moved",
                                )
                              }
                              className="rounded-md border border-border px-2.5 py-1.5 text-sm hover:border-accent disabled:opacity-50"
                            >
                              {new Date(s.startIso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
