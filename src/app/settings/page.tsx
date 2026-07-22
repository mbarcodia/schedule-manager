"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CaretLeftIcon, CheckIcon } from "@phosphor-icons/react";
import { createClient } from "@/lib/supabase/client";
import type {
  CalendarProvider,
  Database,
  PlannerCredentialProvider,
  PlannerModel,
  PreferredModel,
  WeeklyHoursJson,
} from "@/lib/supabase/database.types";
import { getPushSubscriptionStatus, subscribeToPush, unsubscribeFromPush } from "@/lib/push/subscribe";

type CategoryRow = Database["public"]["Tables"]["categories"]["Row"];
type ConnectionRow = Database["public"]["Tables"]["calendar_connections"]["Row"];

const DAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const PROVIDER_LABELS: Record<CalendarProvider, string> = {
  outlook_ics: "Outlook",
  icloud_ics: "iCloud",
  google_ics: "Google",
};

const PROVIDER_DEFAULT_COLORS: Record<CalendarProvider, string> = {
  outlook_ics: "#5b8def",
  icloud_ics: "#46c2c2",
  google_ics: "#e8935c",
};

const PROVIDER_INSTRUCTIONS: Record<CalendarProvider, string[]> = {
  outlook_ics: [
    "Go to outlook.office.com (or outlook.com) and sign in.",
    'Click the gear icon (Settings) in the top right, then find "Shared calendars" under Calendar.',
    'Under "Publish a calendar," pick the calendar you want to connect and set permissions to "Can view all details."',
    'Click "Publish," then copy the ICS link (not the HTML link).',
    "Paste that link below.",
  ],
  icloud_ics: [
    "Open the Calendar app (or go to icloud.com/calendar) and sign in.",
    "Hover over the calendar you want to share in the sidebar, click the share icon, and turn on \"Public Calendar.\"",
    'Copy the link it gives you — it starts with "webcal://", which is fine, paste it as-is.',
    "Paste that link below.",
  ],
  google_ics: [
    "Go to calendar.google.com on desktop and sign in.",
    'Find the calendar in the left sidebar, click the three-dot menu, then "Settings and sharing."',
    'Scroll to "Integrate calendar" and copy the "Secret address in iCal format" (not the public address — the secret one works without making your whole calendar public).',
    "Paste that link below.",
  ],
};

function minutesToTimeInput(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
function timeInputToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

// Hour-only, not minute-precision: the cron routes that deliver these
// notifications only run hourly (see time-match.ts), so a minute picker
// would promise timing accuracy the delivery mechanism can't honor.
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => {
  const period = h < 12 ? "AM" : "PM";
  const displayHour = h % 12 === 0 ? 12 : h % 12;
  return { value: h * 60, label: `${displayHour}:00 ${period}` };
});

interface NotifPrefs {
  eodEnabled: boolean;
  eodTime: number;
  weeklyEnabled: boolean;
  weeklyDow: number;
  weeklyTime: number;
}

const MODEL_OPTIONS: {
  id: PreferredModel;
  label: string;
  cost: string;
  description: string;
}[] = [
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    cost: "~$1–3/month",
    description: "Cheapest. Fine for simple task capture; can misparse compound requests or give shallower planning advice.",
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    cost: "~$3–7/month",
    description: "Recommended default — reliable on compound requests, multi-step tool use, and genuine planning advice.",
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    cost: "~$6–15/month",
    description: "Most capable. Strongest reasoning, for anyone who wants that and doesn't mind paying more.",
  },
];

const PLANNER_MODEL_OPTIONS: {
  id: PlannerModel;
  label: string;
  description: string;
}[] = [
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    description: "Cheaper — reliable on planning conversations and multi-step tool use.",
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    description: "Recommended default — strongest at long-horizon planning, pushback, and realism checks.",
  },
  {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    description: "Most capable overall. Premium pricing; requires an API key (not available on subscription plans).",
  },
];

export default function SettingsPage() {
  const router = useRouter();
  const [current, setCurrent] = useState<PreferredModel | null>(null);
  const [saving, setSaving] = useState<PreferredModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [hours, setHours] = useState<WeeklyHoursJson | null>(null);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryColor, setNewCategoryColor] = useState("#9184d9");
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [newConnLabel, setNewConnLabel] = useState("");
  const [newConnUrl, setNewConnUrl] = useState("");
  const [newConnProvider, setNewConnProvider] = useState<CalendarProvider>("outlook_ics");
  const [newConnColor, setNewConnColor] = useState(PROVIDER_DEFAULT_COLORS.outlook_ics);
  const [syncing, setSyncing] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [notif, setNotif] = useState<NotifPrefs | null>(null);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [plannerModel, setPlannerModel] = useState<PlannerModel | null>(null);
  const [plannerModelSaving, setPlannerModelSaving] = useState<PlannerModel | null>(null);
  const [plannerCred, setPlannerCred] = useState<{
    hasSecret: boolean;
    provider?: PlannerCredentialProvider;
    last4?: string;
    isOwner?: boolean;
  }>({ hasSecret: false });
  const [plannerKeyInput, setPlannerKeyInput] = useState("");
  const [plannerCredBusy, setPlannerCredBusy] = useState(false);
  const [plannerCredError, setPlannerCredError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    async function load() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const [{ data }, { data: cats }, { data: conns }, pushOn] = await Promise.all([
        supabase
          .from("profiles")
          .select(
            "preferred_model,planner_model,weekly_hours,eod_checkin_enabled,eod_checkin_time,weekly_summary_enabled,weekly_summary_dow,weekly_summary_time",
          )
          .eq("id", user.id)
          .single(),
        supabase.from("categories").select("*").order("sort_order"),
        supabase.from("calendar_connections").select("*").order("created_at"),
        getPushSubscriptionStatus(),
      ]);
      if (ignore) return;
      if (data) {
        setCurrent(data.preferred_model);
        setPlannerModel(data.planner_model);
        setHours(data.weekly_hours);
        setNotif({
          eodEnabled: data.eod_checkin_enabled,
          eodTime: data.eod_checkin_time,
          weeklyEnabled: data.weekly_summary_enabled,
          weeklyDow: data.weekly_summary_dow,
          weeklyTime: data.weekly_summary_time,
        });
      }
      setCategories(cats ?? []);
      setConnections(conns ?? []);
      setPushEnabled(pushOn);
      setLoading(false);
    }
    void load();
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    let ignore = false;
    async function loadCredential() {
      const res = await fetch("/api/planner/credentials");
      if (ignore || !res.ok) return;
      const data = await res.json();
      setPlannerCred(data);
    }
    void loadCredential();
    return () => {
      ignore = true;
    };
  }, []);

  async function addConnection() {
    setConnError(null);
    const label = newConnLabel.trim();
    // webcal:// is the same feed as https://, just a different scheme some
    // calendar apps use for their "subscribe" links — normalize so fetch()
    // (used by the sync job) can actually request it.
    const ics_url = newConnUrl.trim().replace(/^webcal:\/\//i, "https://");
    if (!label) return setConnError("Give this connection a label first.");
    if (!ics_url) return setConnError("Paste the calendar's ICS feed URL first.");
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return setConnError("Not signed in — try refreshing the page.");
    const { data, error } = await supabase
      .from("calendar_connections")
      .insert({ user_id: user.id, provider: newConnProvider, label, ics_url, color: newConnColor })
      .select()
      .single();
    if (error) return setConnError(error.message);
    if (data) {
      setConnections((prev) => [...prev, data]);
      setNewConnLabel("");
      setNewConnUrl("");
    }
  }

  async function recolorConnection(id: string, color: string) {
    setConnections((prev) => prev.map((c) => (c.id === id ? { ...c, color } : c)));
    const supabase = createClient();
    await supabase.from("calendar_connections").update({ color }).eq("id", id);
  }

  async function deleteConnection(id: string) {
    setConnections((prev) => prev.filter((c) => c.id !== id));
    const supabase = createClient();
    await supabase.from("calendar_connections").delete().eq("id", id);
  }

  async function renameConnection(id: string, label: string) {
    setConnections((prev) => prev.map((c) => (c.id === id ? { ...c, label } : c)));
    const supabase = createClient();
    await supabase.from("calendar_connections").update({ label }).eq("id", id);
  }

  async function syncNow() {
    setSyncing(true);
    try {
      await fetch("/api/calendar/sync", { method: "POST" });
      const supabase = createClient();
      const { data: conns } = await supabase.from("calendar_connections").select("*").order("created_at");
      setConnections(conns ?? []);
    } finally {
      setSyncing(false);
    }
  }

  async function addCategory() {
    const name = newCategoryName.trim();
    if (!name) return;
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { data, error } = await supabase
      .from("categories")
      .insert({ user_id: user.id, name, color: newCategoryColor, sort_order: categories.length })
      .select()
      .single();
    if (!error && data) {
      setCategories((prev) => [...prev, data]);
      setNewCategoryName("");
      setNewCategoryColor("#9184d9");
    }
  }

  async function renameCategory(id: string, name: string) {
    setCategories((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)));
    const supabase = createClient();
    await supabase.from("categories").update({ name }).eq("id", id);
  }

  async function recolorCategory(id: string, color: string) {
    setCategories((prev) => prev.map((c) => (c.id === id ? { ...c, color } : c)));
    const supabase = createClient();
    await supabase.from("categories").update({ color }).eq("id", id);
  }

  async function deleteCategory(id: string) {
    setCategories((prev) => prev.filter((c) => c.id !== id));
    const supabase = createClient();
    await supabase.from("categories").delete().eq("id", id);
  }

  async function saveHours(next: WeeklyHoursJson) {
    setHours(next);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) await supabase.from("profiles").update({ weekly_hours: next }).eq("id", user.id);
  }

  function toggleDay(dow: number, on: boolean) {
    if (!hours) return;
    const next = { ...hours, [String(dow)]: on ? { start: 9 * 60, end: 17 * 60 } : null };
    void saveHours(next);
  }

  function setDayTime(dow: number, field: "start" | "end", minutes: number) {
    if (!hours) return;
    const existing = hours[String(dow)];
    if (!existing) return;
    const next = { ...hours, [String(dow)]: { ...existing, [field]: minutes } };
    void saveHours(next);
  }

  async function togglePush(enabled: boolean) {
    setPushBusy(true);
    setPushError(null);
    if (enabled) {
      const res = await subscribeToPush();
      if (res.ok) setPushEnabled(true);
      else setPushError(res.error ?? "Something went wrong.");
    } else {
      await unsubscribeFromPush();
      setPushEnabled(false);
    }
    setPushBusy(false);
  }

  async function saveNotif(next: NotifPrefs) {
    setNotif(next);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase
      .from("profiles")
      .update({
        eod_checkin_enabled: next.eodEnabled,
        eod_checkin_time: next.eodTime,
        weekly_summary_enabled: next.weeklyEnabled,
        weekly_summary_dow: next.weeklyDow,
        weekly_summary_time: next.weeklyTime,
      })
      .eq("id", user.id);
  }

  function toggleEodCheckin(on: boolean) {
    if (!notif) return;
    void saveNotif({ ...notif, eodEnabled: on });
  }

  function setEodCheckinTime(minutes: number) {
    if (!notif) return;
    void saveNotif({ ...notif, eodTime: minutes });
  }

  function toggleWeeklySummary(on: boolean) {
    if (!notif) return;
    void saveNotif({ ...notif, weeklyEnabled: on });
  }

  function setWeeklySummaryDow(dow: number) {
    if (!notif) return;
    void saveNotif({ ...notif, weeklyDow: dow });
  }

  function setWeeklySummaryTime(minutes: number) {
    if (!notif) return;
    void saveNotif({ ...notif, weeklyTime: minutes });
  }

  async function choose(model: PreferredModel) {
    setSaving(model);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      await supabase.from("profiles").update({ preferred_model: model }).eq("id", user.id);
      setCurrent(model);
    }
    setSaving(null);
  }

  async function choosePlannerModel(model: PlannerModel) {
    setPlannerModelSaving(model);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      await supabase.from("profiles").update({ planner_model: model }).eq("id", user.id);
      setPlannerModel(model);
    }
    setPlannerModelSaving(null);
  }

  async function savePlannerKey(provider: PlannerCredentialProvider) {
    const secret = plannerKeyInput.trim();
    if (!secret) return;
    setPlannerCredBusy(true);
    setPlannerCredError(null);
    const res = await fetch("/api/planner/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, secret }),
    });
    if (res.ok) {
      setPlannerCred(await res.json());
      setPlannerKeyInput("");
    } else {
      setPlannerCredError("Couldn't save that — please try again.");
    }
    setPlannerCredBusy(false);
  }

  async function removePlannerKey() {
    setPlannerCredBusy(true);
    setPlannerCredError(null);
    const res = await fetch("/api/planner/credentials", { method: "DELETE" });
    if (res.ok) setPlannerCred(await res.json());
    setPlannerCredBusy(false);
  }

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex-1 flex justify-center overflow-y-auto">
      <div className="w-full max-w-lg px-6 py-8">
        <Link href="/" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-text mb-6">
          <CaretLeftIcon size={12} weight="bold" />
          Back to schedule
        </Link>

        <h1 className="text-base font-medium mb-1">Assistant model</h1>
        <p className="text-xs text-muted mb-5">
          Pick which Claude model powers the chat assistant. Approximate monthly cost is based on typical personal
          usage (20–50 short messages/day) — billed directly to your own Anthropic API key, separate from this app.
        </p>

        {loading ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {MODEL_OPTIONS.map((opt) => {
              const selected = current === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => choose(opt.id)}
                  disabled={saving != null}
                  className="text-left rounded-lg border p-3.5 transition-colors disabled:opacity-70"
                  style={{
                    borderColor: selected ? "var(--color-accent)" : "var(--color-border)",
                    background: selected ? "rgba(145,132,217,0.08)" : "var(--color-panel)",
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{opt.label}</span>
                      {selected && <CheckIcon size={14} weight="bold" className="text-accent" />}
                    </div>
                    <span className="text-xs text-accent-text font-medium">{opt.cost}</span>
                  </div>
                  <p className="mt-1.5 text-xs text-muted leading-relaxed">{opt.description}</p>
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-8 pt-5 border-t border-border">
          <h2 className="text-base font-medium mb-1">Planner AI</h2>
          <p className="text-xs text-muted mb-4">
            The Planner is a separate, longer-horizon chat for discussing projects and keeping notes — it uses its
            own model choice and, optionally, its own API key.
          </p>

          <div className="rounded-lg border border-border bg-panel p-3.5 mb-5 text-xs text-muted leading-relaxed">
            <div className="text-sm font-medium text-text mb-1.5">How the Planner works</div>
            <p className="mb-2">
              Open it from the calendar via the <span className="text-text">Planner</span> link. It has everything
              the quick assistant has, plus notes: each note has a kind (idea, todo, paper, update, other) and can be
              linked to a project/proposal/task or left unlinked. Create and edit notes either by asking the planner
              in chat (&quot;add a note to ACE2 about…&quot;) or directly in the sidebar. The sidebar groups notes
              under their linked project; &quot;Export notes&quot; in the sidebar header downloads everything as one
              Markdown file.
            </p>
            <p>The planner reads your existing notes when relevant, so you don&apos;t need to repeat context.</p>
          </div>

          {loading ? (
            <p className="text-xs text-muted">Loading…</p>
          ) : (
            <div className="flex flex-col gap-2.5 mb-5">
              {PLANNER_MODEL_OPTIONS.filter(
                (opt) => !(opt.id === "claude-fable-5" && plannerCred.provider === "oauth_token"),
              ).map((opt) => {
                const selected = plannerModel === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => choosePlannerModel(opt.id)}
                    disabled={plannerModelSaving != null}
                    className="text-left rounded-lg border p-3.5 transition-colors disabled:opacity-70"
                    style={{
                      borderColor: selected ? "var(--color-accent)" : "var(--color-border)",
                      background: selected ? "rgba(145,132,217,0.08)" : "var(--color-panel)",
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{opt.label}</span>
                      {selected && <CheckIcon size={14} weight="bold" className="text-accent" />}
                    </div>
                    <p className="mt-1.5 text-xs text-muted leading-relaxed">{opt.description}</p>
                  </button>
                );
              })}
            </div>
          )}

          <div className="rounded-lg border border-border bg-panel p-3.5">
            <div className="text-sm font-medium mb-1">Your own Anthropic API key</div>
            <p className="text-xs text-muted mb-3 leading-relaxed">
              {plannerCred.isOwner
                ? "Optional — as this deployment's owner, the assistant and planner already run on the shared key from your environment config. Add your own here only if you want to bill usage separately (e.g. for Claude Fable 5) or track it apart from the deployment's overall usage."
                : "Required to use the assistant or planner. This deployment's shared key is reserved for its owner only — everyone else must add their own Anthropic API key here; there's no fallback."}{" "}
              This is a separate thing from a claude.ai subscription: it&apos;s billed per-token, not a flat monthly
              fee.
            </p>
            <p className="text-xs text-muted mb-3 leading-relaxed">
              To get one: go to{" "}
              <a
                href="https://console.anthropic.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-text hover:underline"
              >
                console.anthropic.com
              </a>
              , sign in or create an account, add a payment method under Billing, then open{" "}
              <span className="text-text">API Keys</span> and create a new key. Paste it below.
            </p>
            {plannerCred.hasSecret ? (
              <div className="flex items-center gap-2.5 text-xs">
                <span className="text-text">
                  Using your API key (ending <span className="font-mono">{plannerCred.last4}</span>)
                </span>
                <button
                  onClick={removePlannerKey}
                  disabled={plannerCredBusy}
                  className="text-accent-text hover:underline disabled:opacity-60"
                >
                  Remove
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input
                  type="password"
                  value={plannerKeyInput}
                  onChange={(e) => setPlannerKeyInput(e.target.value)}
                  placeholder="sk-ant-…"
                  className="flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text outline-none focus-visible:border-accent"
                />
                <button
                  onClick={() => savePlannerKey("api_key")}
                  disabled={plannerCredBusy || !plannerKeyInput.trim()}
                  className="rounded-md border border-accent text-accent px-3 py-1.5 text-xs font-medium hover:bg-accent/10 disabled:opacity-60"
                >
                  Save
                </button>
              </div>
            )}
            {plannerCredError && <p className="mt-2 text-xs text-red-300">{plannerCredError}</p>}
          </div>
        </div>

        <div className="mt-8 pt-5 border-t border-border">
          <h2 className="text-base font-medium mb-1">Standard hours</h2>
          <p className="text-xs text-muted mb-4">
            Your normal working window for each day of the week — this is what the calendar compares against for
            &quot;starts early/late&quot; and what the assistant schedules within by default. Turn on a day
            (including weekends) to make it schedulable normally; leave it off and it stays free unless you
            explicitly allow a specific date.
          </p>

          {loading || !hours ? (
            <p className="text-xs text-muted">Loading…</p>
          ) : (
            <div className="flex flex-col gap-2">
              {DAY_LABELS.map((label, dow) => {
                const window = hours[String(dow)];
                const on = !!window;
                return (
                  <div
                    key={dow}
                    className="flex items-center gap-3 rounded-md border border-border bg-panel px-3 py-2"
                  >
                    <label className="flex items-center gap-2 text-xs w-28 flex-none">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => toggleDay(dow, e.target.checked)}
                        className="accent-accent"
                      />
                      {label}
                    </label>
                    {on ? (
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <input
                          type="time"
                          value={minutesToTimeInput(window.start)}
                          onChange={(e) => setDayTime(dow, "start", timeInputToMinutes(e.target.value))}
                          className="rounded border border-border bg-surface px-1.5 py-1 text-text text-xs outline-none focus-visible:border-accent"
                        />
                        <span>to</span>
                        <input
                          type="time"
                          value={minutesToTimeInput(window.end)}
                          onChange={(e) => setDayTime(dow, "end", timeInputToMinutes(e.target.value))}
                          className="rounded border border-border bg-surface px-1.5 py-1 text-text text-xs outline-none focus-visible:border-accent"
                        />
                      </div>
                    ) : (
                      <span className="text-xs text-muted">Off</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-8 pt-5 border-t border-border">
          <h2 className="text-base font-medium mb-1">Categories</h2>
          <p className="text-xs text-muted mb-4">
            Groups your tasks and projects for the calendar&apos;s block color (research chunks pick up their
            project&apos;s category). Add, rename, recolor, or remove any of these anytime.
          </p>

          <div className="flex flex-col gap-2">
            {categories.map((cat) => (
              <div key={cat.id} className="flex items-center gap-2.5 rounded-md border border-border bg-panel px-3 py-2">
                <input
                  type="color"
                  value={cat.color}
                  onChange={(e) => recolorCategory(cat.id, e.target.value)}
                  className="w-7 h-7 rounded border border-border bg-transparent p-0 cursor-pointer"
                  title="Category color"
                />
                <input
                  defaultValue={cat.name}
                  onBlur={(e) => {
                    if (e.target.value.trim() && e.target.value !== cat.name) renameCategory(cat.id, e.target.value.trim());
                  }}
                  className="flex-1 bg-transparent text-sm text-text outline-none border-b border-transparent focus-visible:border-accent"
                />
                <button
                  onClick={() => deleteCategory(cat.id)}
                  title="Remove category"
                  className="text-xs text-muted hover:text-accent-text"
                >
                  Remove
                </button>
              </div>
            ))}

            <div className="flex items-center gap-2.5 rounded-md border border-dashed border-border px-3 py-2">
              <input
                type="color"
                value={newCategoryColor}
                onChange={(e) => setNewCategoryColor(e.target.value)}
                className="w-7 h-7 rounded border border-border bg-transparent p-0 cursor-pointer"
                title="New category color"
              />
              <input
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addCategory()}
                placeholder="New category name"
                className="flex-1 bg-transparent text-sm text-text outline-none placeholder:text-muted"
              />
              <button onClick={addCategory} className="text-xs text-accent hover:underline">
                Add
              </button>
            </div>
          </div>
        </div>

        <div className="mt-8 pt-5 border-t border-border">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h2 className="text-base font-medium">Connected calendars</h2>
            <button
              onClick={syncNow}
              disabled={syncing || connections.length === 0}
              className="text-xs text-accent hover:underline disabled:opacity-50 disabled:no-underline flex-none"
            >
              {syncing ? "Syncing…" : "Sync now"}
            </button>
          </div>
          <p className="text-xs text-muted mb-4">
            Read-only — meetings show up as fixed time on your calendar and your tasks reschedule around them, but
            nothing is ever written back. Syncs automatically every hour, or click &quot;Sync now&quot; anytime.
          </p>

          <div className="flex flex-col gap-2">
            {connections.map((c) => (
              <div key={c.id} className="flex items-center gap-2.5 rounded-md border border-border bg-panel px-3 py-2">
                <input
                  type="color"
                  value={c.color}
                  onChange={(e) => recolorConnection(c.id, e.target.value)}
                  className="w-6 h-6 flex-none rounded border border-border bg-transparent p-0 cursor-pointer"
                  title="Accent color on the calendar"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1">
                    <input
                      defaultValue={c.label}
                      onBlur={(e) => {
                        const next = e.target.value.trim();
                        if (next && next !== c.label) renameConnection(c.id, next);
                        else e.target.value = c.label;
                      }}
                      className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none border-b border-transparent focus-visible:border-accent"
                    />
                    <span className="text-muted text-xs flex-none">· {PROVIDER_LABELS[c.provider]}</span>
                  </div>
                  <div className="text-[10.5px] text-muted mt-0.5">
                    {c.last_sync_error
                      ? `Sync failed: ${c.last_sync_error}`
                      : c.last_synced_at
                        ? `Last synced ${new Date(c.last_synced_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${c.last_sync_event_count ?? 0} events`
                        : "Not synced yet"}
                  </div>
                </div>
                <button
                  onClick={() => deleteConnection(c.id)}
                  title="Disconnect"
                  className="text-xs text-muted hover:text-accent-text flex-none"
                >
                  Disconnect
                </button>
              </div>
            ))}

            <div className="flex flex-col gap-2 rounded-md border border-dashed border-border px-3 py-2.5">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={newConnColor}
                  onChange={(e) => setNewConnColor(e.target.value)}
                  className="w-6 h-6 flex-none rounded border border-border bg-transparent p-0 cursor-pointer"
                  title="Accent color on the calendar"
                />
                <select
                  value={newConnProvider}
                  onChange={(e) => {
                    const provider = e.target.value as CalendarProvider;
                    setNewConnProvider(provider);
                    setNewConnColor(PROVIDER_DEFAULT_COLORS[provider]);
                  }}
                  className="rounded border border-border bg-surface px-1.5 py-1 text-text text-xs outline-none focus-visible:border-accent"
                >
                  <option value="outlook_ics">Outlook</option>
                  <option value="icloud_ics">iCloud</option>
                  <option value="google_ics">Google</option>
                </select>
                <input
                  value={newConnLabel}
                  onChange={(e) => setNewConnLabel(e.target.value)}
                  placeholder="Label, e.g. Work Outlook"
                  className="flex-1 bg-transparent text-sm text-text outline-none placeholder:text-muted border-b border-transparent focus-visible:border-accent"
                />
              </div>

              <div className="rounded bg-surface px-2.5 py-2">
                <p className="text-[10.5px] tracking-wide uppercase text-muted-2 mb-1.5">
                  Steps to connect {PROVIDER_LABELS[newConnProvider]}
                </p>
                <ol className="text-[11px] text-muted leading-relaxed list-decimal list-inside space-y-0.5">
                  <li>Pick a name for this connection above (anything you want, e.g. &quot;Work Outlook&quot;) — it&apos;s just for you to tell calendars apart, not something from {PROVIDER_LABELS[newConnProvider]}.</li>
                  {PROVIDER_INSTRUCTIONS[newConnProvider].map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
                <p className="text-[10.5px] text-muted-2 mt-1.5">
                  This link works like a password — anyone who has it can view your event times and titles (not edit
                  anything). Keep it private, and you can revoke/regenerate it from your calendar&apos;s sharing
                  settings anytime.
                </p>
              </div>

              <input
                value={newConnUrl}
                onChange={(e) => setNewConnUrl(e.target.value)}
                placeholder="Paste the calendar's ICS feed URL"
                className="bg-transparent text-xs text-text outline-none placeholder:text-muted border-b border-border focus-visible:border-accent pb-1"
              />
              {connError && <p className="text-[11px] text-accent-text">{connError}</p>}
              <button onClick={addConnection} className="self-start text-xs text-accent hover:underline">
                Connect
              </button>
            </div>
          </div>
        </div>

        <div className="mt-8 pt-5 border-t border-border">
          <h2 className="text-base font-medium mb-1">Notifications</h2>
          <p className="text-xs text-muted mb-4">
            Real push notifications from your browser. Delivery is checked hourly by the server, so times below are
            rounded to the hour rather than exact-minute.
          </p>

          <div className="flex items-center gap-3 rounded-md border border-border bg-panel px-3 py-2 mb-2">
            <label className="flex items-center gap-2 text-xs flex-1">
              <input
                type="checkbox"
                checked={pushEnabled}
                disabled={pushBusy}
                onChange={(e) => togglePush(e.target.checked)}
                className="accent-accent"
              />
              Enable push notifications
            </label>
            {pushBusy && <span className="text-xs text-muted">Working…</span>}
          </div>
          {pushError && <p className="text-[11px] text-accent-text mb-2">{pushError}</p>}

          {loading || !notif ? (
            <p className="text-xs text-muted">Loading…</p>
          ) : (
            <div className="flex flex-col gap-2">
              <div
                className={`flex items-center gap-3 rounded-md border border-border bg-panel px-3 py-2 ${pushEnabled ? "" : "opacity-50"}`}
              >
                <label className="flex items-center gap-2 text-xs w-40 flex-none">
                  <input
                    type="checkbox"
                    checked={notif.eodEnabled}
                    disabled={!pushEnabled}
                    onChange={(e) => toggleEodCheckin(e.target.checked)}
                    className="accent-accent"
                  />
                  End-of-day check-in
                </label>
                <select
                  value={notif.eodTime}
                  disabled={!pushEnabled || !notif.eodEnabled}
                  onChange={(e) => setEodCheckinTime(Number(e.target.value))}
                  className="rounded border border-border bg-surface px-1.5 py-1 text-text text-xs outline-none focus-visible:border-accent"
                >
                  {HOUR_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              <div
                className={`flex items-center gap-2 flex-wrap rounded-md border border-border bg-panel px-3 py-2 ${pushEnabled ? "" : "opacity-50"}`}
              >
                <label className="flex items-center gap-2 text-xs w-40 flex-none">
                  <input
                    type="checkbox"
                    checked={notif.weeklyEnabled}
                    disabled={!pushEnabled}
                    onChange={(e) => toggleWeeklySummary(e.target.checked)}
                    className="accent-accent"
                  />
                  Weekly research summary
                </label>
                <select
                  value={notif.weeklyDow}
                  disabled={!pushEnabled || !notif.weeklyEnabled}
                  onChange={(e) => setWeeklySummaryDow(Number(e.target.value))}
                  className="rounded border border-border bg-surface px-1.5 py-1 text-text text-xs outline-none focus-visible:border-accent"
                >
                  {DAY_LABELS.map((label, dow) => (
                    <option key={dow} value={dow}>
                      {label}
                    </option>
                  ))}
                </select>
                <select
                  value={notif.weeklyTime}
                  disabled={!pushEnabled || !notif.weeklyEnabled}
                  onChange={(e) => setWeeklySummaryTime(Number(e.target.value))}
                  className="rounded border border-border bg-surface px-1.5 py-1 text-text text-xs outline-none focus-visible:border-accent"
                >
                  {HOUR_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              {!pushEnabled && <p className="text-[11px] text-muted">Turn on push notifications above first.</p>}
            </div>
          )}
        </div>

        <div className="mt-8 pt-5 border-t border-border">
          <button onClick={signOut} className="text-xs text-muted underline underline-offset-2 hover:text-text">
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
