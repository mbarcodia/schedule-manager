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
  WeeklyHoursJson,
} from "@/lib/supabase/database.types";
import { getPushSubscriptionStatus, subscribeToPush, unsubscribeFromPush } from "@/lib/push/subscribe";
import { BookingSection } from "@/components/settings/BookingSection";
import {
  DEFAULT_VIEW_DAYS,
  VIEW_DAY_OPTIONS,
  onViewDaysChange,
  readViewDays,
  writeViewDays,
  type ViewDays,
} from "@/lib/calendar/view-prefs";

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

/** Left-hand jump list. Order matches the page. */
/** How long an un-ticked past block stays completable in place. Mirrors the
 * profiles.grace_hours default; the engine falls back to the same number. */
const DEFAULT_GRACE_HOURS = 4;
const GRACE_HOUR_OPTIONS = [1, 2, 4, 8, 24];

/** The shared vocabulary, spelled out once. Kept beside SECTIONS so the words
 * on this page and the words in the chat persona can be checked against each
 * other in one place. */
const VOCABULARY: [string, string][] = [
  [
    "Project",
    "anything you are currently working on — a research project, a proposal, a literature review, a manuscript. One kind of thing with optional parts, mixed however you like: weekly hours the scheduler defends (optionally only between two dates, and optionally fixed to mornings or afternoons), a hard deadline, an ongoing cadence.",
  ],
  [
    "To-do",
    "something to do, on a list you name. It occupies no calendar time by itself, and can gain a date, notification lead times, and booked hours (with a start and a finish-by, which is how preparation gets booked) at any point after you jot it down — a reminder is simply a to-do that has a date and a lead time.",
  ],
  [
    "Target",
    "a date inside a project that takes no time of its own — “first round of analysis done by the end of August”. It shows as a marker on the timeline and you click it when you hit it. If getting there needs hours, that's Work, added separately.",
  ],
  [
    "Work",
    "hours that get scheduled onto the calendar, usually belonging to a project. This is the only one of these that consumes time.",
  ],
  ["Routine", "a standing weekly slot — email, lunch, gym, a lab meeting. It repeats on its own."],
  ["Time block", "what any of the above looks like once it's sitting on the calendar."],
  [
    "Label",
    "a colour-coded grouping you name yourself, like Research, Writing or Teaching. Work wears its label's colour on the left edge of its time block.",
  ],
];

/** The jump list, grouped so twelve entries read as four short lists rather
 * than one long one. Order follows how often a setting is actually touched:
 * how the schedule behaves first, then what things look like, then the parts
 * you set up once and forget. */
const SECTION_GROUPS: { group: string; items: { id: string; label: string }[] }[] = [
  {
    group: "Start here",
    items: [
      { id: "vocabulary", label: "Overview" },
      { id: "planner-guide", label: "How the planner works" },
    ],
  },
  {
    group: "Your time",
    items: [
      { id: "standard-hours", label: "Standard hours" },
      { id: "grace-window", label: "Un-ticked work" },
      { id: "categories", label: "Labels" },
      { id: "block-labels", label: "Time block names" },
      { id: "calendar-view", label: "Calendar view" },
    ],
  },
  {
    group: "Connections",
    items: [
      { id: "calendars", label: "Connected calendars" },
      { id: "booking", label: "Booking page" },
      { id: "notifications", label: "Notifications" },
    ],
  },
  {
    group: "AI setup",
    items: [
      { id: "claude-access", label: "Claude access" },
      { id: "planner-ai", label: "Planner AI" },
    ],
  },
];

export default function SettingsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [viewDays, setViewDays] = useState<ViewDays>(DEFAULT_VIEW_DAYS);
  const [graceHours, setGraceHours] = useState(DEFAULT_GRACE_HOURS);
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
  }>({ hasSecret: false });
  const [plannerKeyInput, setPlannerKeyInput] = useState("");
  const [credMode, setCredMode] = useState<PlannerCredentialProvider>("api_key");
  const [plannerCredBusy, setPlannerCredBusy] = useState(false);
  const [plannerCredError, setPlannerCredError] = useState<string | null>(null);
  const [tagLabels, setTagLabels] = useState({ task: "", research: "", deepFocus: "", block: "" });

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
            "planner_model,grace_hours,weekly_hours,eod_checkin_enabled,eod_checkin_time,weekly_summary_enabled,weekly_summary_dow,weekly_summary_time,label_task,label_research,label_deep_focus,label_block",
          )
          .eq("id", user.id)
          .single(),
        supabase.from("categories").select("*").order("sort_order"),
        supabase.from("calendar_connections").select("*").order("created_at"),
        getPushSubscriptionStatus(),
      ]);
      if (ignore) return;
      if (data) {
        setPlannerModel(data.planner_model);
        setGraceHours(data.grace_hours ?? DEFAULT_GRACE_HOURS);
        setHours(data.weekly_hours);
        setNotif({
          eodEnabled: data.eod_checkin_enabled,
          eodTime: data.eod_checkin_time,
          weeklyEnabled: data.weekly_summary_enabled,
          weeklyDow: data.weekly_summary_dow,
          weeklyTime: data.weekly_summary_time,
        });
        setTagLabels({
          task: data.label_task ?? "",
          research: data.label_research ?? "",
          deepFocus: data.label_deep_focus ?? "",
          block: data.label_block ?? "",
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setViewDays(readViewDays());
    return onViewDaysChange(setViewDays);
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

  async function setCategoryMinChunk(id: string, minChunkMin: number | null) {
    setCategories((prev) => prev.map((c) => (c.id === id ? { ...c, min_chunk_min: minChunkMin } : c)));
    const supabase = createClient();
    await supabase.from("categories").update({ min_chunk_min: minChunkMin }).eq("id", id);
  }

  const TAG_LABEL_COLUMN = {
    task: "label_task",
    research: "label_research",
    deepFocus: "label_deep_focus",
    block: "label_block",
  } as const;

  async function saveTagLabel(field: keyof typeof TAG_LABEL_COLUMN, value: string) {
    setTagLabels((prev) => ({ ...prev, [field]: value }));
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const val = value.trim() || null;
    const patch =
      field === "task"
        ? { label_task: val }
        : field === "research"
          ? { label_research: val }
          : field === "deepFocus"
            ? { label_deep_focus: val }
            : { label_block: val };
    await supabase.from("profiles").update(patch).eq("id", user.id);
  }

  async function deleteCategory(id: string) {
    setCategories((prev) => prev.filter((c) => c.id !== id));
    const supabase = createClient();
    await supabase.from("categories").delete().eq("id", id);
  }

  async function saveGraceHours(hours: number) {
    setGraceHours(hours);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) await supabase.from("profiles").update({ grace_hours: hours }).eq("id", user.id);
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
    // Catch pasting the wrong credential type into the wrong tab — the two
    // token formats are distinguishable by prefix (oat01 = subscription).
    if (provider === "oauth_token" && !secret.startsWith("sk-ant-oat")) {
      setPlannerCredError(
        "That doesn't look like a subscription token (expected sk-ant-oat01-…). If it's an API key, switch to the API key tab.",
      );
      return;
    }
    if (provider === "api_key" && secret.startsWith("sk-ant-oat")) {
      setPlannerCredError(
        "That looks like a subscription token, not an API key — switch to the Claude Pro/Max subscription tab to save it.",
      );
      return;
    }
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
    <div className="flex-1 flex flex-col min-h-0">
      {/* Sits OUTSIDE the scroll container, so getting back to the calendar and
          re-syncing are one click away from anywhere in the page. */}
      <div className="flex-none border-b border-border px-6 py-2.5 flex items-center gap-4">
        <Link href="/" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-text">
          <CaretLeftIcon size={12} weight="bold" />
          Back to schedule
        </Link>
        <span className="text-xs text-muted-2">Settings</span>
        <button
          onClick={syncNow}
          disabled={syncing || connections.length === 0}
          title={connections.length === 0 ? "No calendars connected yet" : "Re-fetch every connected calendar feed"}
          className="ml-auto text-xs text-accent hover:underline disabled:opacity-50 disabled:no-underline"
        >
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-8 flex gap-10">
          {/* Jump list — sticky so it stays put while the content scrolls. */}
          <nav className="hidden lg:flex flex-none w-44 flex-col gap-0.5 sticky top-0 self-start">
            {SECTION_GROUPS.map((g) => (
              <div key={g.group} className="mb-2">
                <div className="px-2 pb-1 text-[9.5px] tracking-wide uppercase text-muted-2 font-medium">
                  {g.group}
                </div>
                {g.items.map((sec) => (
                  <button
                    key={sec.id}
                    onClick={() =>
                      document.getElementById(sec.id)?.scrollIntoView({ behavior: "smooth", block: "start" })
                    }
                    className="block w-full text-left text-xs text-muted hover:text-text rounded-md px-2 py-1.5 hover:bg-white/5"
                  >
                    {sec.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div className="flex-1 min-w-0 max-w-lg">
        <div id="vocabulary" className="mb-8 pb-5 border-b border-border scroll-mt-4">
          <h2 className="text-base font-medium mb-1">Overview</h2>
          <p className="text-xs text-muted mb-3 leading-relaxed">
            These words do all the work here. The calendar, the chat and this page use them the same way, so you can
            say what you mean and be understood.
          </p>
          <dl className="rounded-lg border border-border bg-panel p-3.5 text-xs text-muted leading-relaxed flex flex-col gap-2.5">
            {VOCABULARY.map(([term, meaning]) => (
              <div key={term}>
                <dt className="inline text-text font-medium">{term}</dt>
                <dd className="inline"> — {meaning}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-[11px] text-muted-2 leading-relaxed">
            Two more things sit deliberately outside that list because they take no calendar time at all: to-dos
            (items on a named checklist) and reminders (a dated push notification with as many lead times as you
            want). Both live on the planner board.
          </p>
        </div>

        <h1 id="claude-access" className="text-base font-medium mb-1 scroll-mt-4">Claude access</h1>
        <p className="text-xs text-muted mb-3 leading-relaxed">
          The chat needs a Claude credential. Every account brings its own; there&apos;s no shared or fallback
          credential, so usage only ever bills to you. Two options — you can switch anytime:
        </p>
        <div className="rounded-lg border border-border bg-panel p-3.5 mb-8">
          {plannerCred.hasSecret ? (
            <div className="flex items-center gap-2.5 text-xs">
              <span className="text-text">
                {plannerCred.provider === "oauth_token" ? (
                  <>
                    Using your Claude subscription token (ending <span className="font-mono">{plannerCred.last4}</span>)
                  </>
                ) : (
                  <>
                    Using your API key (ending <span className="font-mono">{plannerCred.last4}</span>)
                  </>
                )}
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
            <>
              <div className="flex gap-1.5 mb-3">
                {(
                  [
                    { mode: "api_key", label: "API key" },
                    { mode: "oauth_token", label: "Claude Pro/Max subscription" },
                  ] as const
                ).map(({ mode, label }) => (
                  <button
                    key={mode}
                    onClick={() => {
                      setCredMode(mode);
                      setPlannerCredError(null);
                    }}
                    className="rounded-md px-2.5 py-1.5 text-xs font-medium border transition-colors"
                    style={{
                      borderColor: credMode === mode ? "var(--color-accent)" : "var(--color-border)",
                      background: credMode === mode ? "rgba(145,132,217,0.08)" : "transparent",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {credMode === "api_key" ? (
                <p className="text-xs text-muted mb-3 leading-relaxed">
                  Pay-per-use billing to your own Anthropic account (separate from a claude.ai subscription). Unlocks
                  every model including Fable 5. Get one at{" "}
                  <a
                    href="https://console.anthropic.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent-text hover:underline"
                  >
                    console.anthropic.com
                  </a>{" "}
                  — add a payment method under Billing, then create a key under{" "}
                  <span className="text-text">API Keys</span> and paste it below.
                </p>
              ) : (
                <div className="text-xs text-muted mb-3 leading-relaxed">
                  <p className="mb-2">
                    Uses the flat-rate claude.ai plan you already pay for — no per-message charges. Requires a paid
                    plan (Pro or higher; the free plan doesn&apos;t qualify). Usage draws from your plan&apos;s normal
                    limits, shared with your own claude.ai and Claude Code use. Models up to Opus 4.8 (subscriptions
                    don&apos;t include Fable 5).
                  </p>
                  <p>
                    To mint your token, run <span className="font-mono text-text">claude setup-token</span> in a
                    terminal (requires{" "}
                    <a
                      href="https://claude.com/claude-code"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent-text hover:underline"
                    >
                      Claude Code
                    </a>
                    ), log in with your claude.ai account, and paste the{" "}
                    <span className="font-mono text-text">sk-ant-oat01-…</span> token below. Note: this option also
                    requires the deployment&apos;s planner relay to be set up — see the README if planner replies say
                    it isn&apos;t enabled.
                  </p>
                </div>
              )}

              <div className="flex gap-2">
                <input
                  type="password"
                  value={plannerKeyInput}
                  onChange={(e) => setPlannerKeyInput(e.target.value)}
                  placeholder={credMode === "oauth_token" ? "sk-ant-oat01-…" : "sk-ant-…"}
                  className="flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text outline-none focus-visible:border-accent"
                />
                <button
                  onClick={() => savePlannerKey(credMode)}
                  disabled={plannerCredBusy || !plannerKeyInput.trim()}
                  className="rounded-md border border-accent text-accent px-3 py-1.5 text-xs font-medium hover:bg-accent/10 disabled:opacity-60"
                >
                  Save
                </button>
              </div>
            </>
          )}
          {plannerCredError && <p className="mt-2 text-xs text-red-300">{plannerCredError}</p>}
        </div>

        <div className="mt-8 pt-5 border-t border-border">
          <h2 id="planner-ai" className="text-base font-medium mb-1 scroll-mt-4">Planner AI</h2>
          <p className="text-xs text-muted mb-4">
            The chat panel on your calendar is the planner — full scheduling plus notes tools, running on whichever
            credential you set at the top of this page (API key or Claude subscription). Pick its model here.
          </p>

          <div className="rounded-lg border border-border bg-panel p-3.5 mb-5 text-xs text-muted leading-relaxed">
            <div className="text-sm font-medium text-text mb-1.5">How the Planner works</div>
            <p className="mb-2">
              Chat with it on the calendar page; the <span className="text-text">Planner</span> link opens the board
              and notes. Each note has a kind (idea, todo, paper, update, other) and can be linked to a
              project/proposal/task or left unlinked. Create and edit notes either by asking in chat (&quot;add a
              note to the model study about…&quot;) or directly in the sidebar. The sidebar groups notes under their linked
              project; &quot;Export notes&quot; in the sidebar header downloads everything as one Markdown file.
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
        </div>

        <div id="calendar-view" className="mt-8 pt-5 border-t border-border scroll-mt-4">
          <h2 className="text-base font-medium mb-1">Calendar view</h2>
          <p className="text-xs text-muted mb-3 leading-relaxed">
            How many days the calendar shows at once. You can also change this from the{" "}
            <span className="text-text">Viewer</span> buttons in the calendar&apos;s top bar, and slide the visible
            window a day at a time with the arrows beside it — so a week can start on any weekday, not just Monday.
          </p>
          <div className="flex items-center gap-1.5 mb-2">
            {VIEW_DAY_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => {
                  writeViewDays(d);
                  setViewDays(d);
                }}
                className="rounded-md px-3 py-1.5 text-xs font-medium border"
                style={{
                  borderColor: viewDays === d ? "var(--color-accent)" : "var(--color-border)",
                  background: viewDays === d ? "rgba(145,132,217,0.08)" : "transparent",
                }}
              >
                {d} day{d > 1 ? "s" : ""}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-2">
            Saved on this device rather than your account — a laptop and a phone want different widths.
          </p>
        </div>

        <div id="grace-window" className="mt-8 pt-5 border-t border-border scroll-mt-4">
          <h2 className="text-base font-medium mb-1">Un-ticked work</h2>
          <p className="text-xs text-muted mb-3 leading-relaxed">
            When a block&apos;s time passes and you haven&apos;t ticked it off, it stays exactly where it is — greyed
            out and labelled <span className="text-text">DID YOU?</span> — for this long, so you can still tick it if
            you simply forgot. Its hours are re-planned straight away either way, which keeps the rest of the week
            honest; ticking the box inside the window takes the replacement back out. Once the window passes, the block
            counts as genuinely missed and the replacement time stands.
          </p>
          <div className="flex items-center gap-1.5 mb-2">
            {GRACE_HOUR_OPTIONS.map((h) => (
              <button
                key={h}
                onClick={() => void saveGraceHours(h)}
                className="rounded-md px-3 py-1.5 text-xs font-medium border"
                style={{
                  borderColor: graceHours === h ? "var(--color-accent)" : "var(--color-border)",
                  background: graceHours === h ? "rgba(145,132,217,0.08)" : "transparent",
                }}
              >
                {h} hour{h > 1 ? "s" : ""}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-2">
            You&apos;ll get a notification shortly before a window runs out (if notifications are on). Ticking something
            off early, or late inside the window, asks whether you did it in its original slot or just now — so the
            hours are logged where they actually happened.
          </p>
        </div>

        <div id="planner-guide" className="mt-8 pt-5 border-t border-border scroll-mt-4">
          <h2 className="text-base font-medium mb-1">How the planner works</h2>
          <p className="text-xs text-muted mb-4 leading-relaxed">
            The <span className="text-text">Planner</span> link opens a board with six views. The first three read
            the live schedule rather than being lists you maintain by hand, so what you see there and what&apos;s on
            your calendar can never drift apart. The last three are yours to write in.
          </p>

          <div className="rounded-lg border border-border bg-panel p-3.5 mb-3 text-xs text-muted leading-relaxed flex flex-col gap-2.5">
            <div>
              <span className="text-text font-medium">Progress</span> — your work grouped by what the schedule says
              about it this week. Something is in <span className="text-text">Backlog</span> when no time is booked for
              it this week, <span className="text-text">This Week</span> when time is booked but nothing has started,{" "}
              <span className="text-text">In Progress</span> when a block is running now or partly logged, and{" "}
              <span className="text-text">Done</span> when every block for it this week is checked off. Dragging a card
              changes the actual schedule: In Progress pins it to today, This Week moves it up the queue, Backlog
              unpins it. Done is display-only on purpose — completion comes from checking blocks off on the calendar,
              so your logged hours stay honest. Because the engine re-plans each week, Done clears every Monday;
              archive something when it&apos;s genuinely finished.
            </div>
            <div>
              <span className="text-text font-medium">Priorities</span> — the same work split by importance against
              urgency. You set importance with the ★ on any card; urgency is derived from the deadline (within three
              days counts, no deadline never does). The useful signal is the quadrants you&apos;d rather not be in:
              urgent-but-unimportant work eating the week, and important-but-not-urgent work that never gets booked.
            </div>
            <div>
              <span className="text-text font-medium">Timeline</span> — one bar per project with a date to work
              toward over the next six months, coloured by whether the hours booked can still cover what&apos;s left;
              overdue turns red. Targets appear as dots along each bar, and projects with no dates at all sit in a
              separate lane.
            </div>
            <div>
              <span className="text-text font-medium">To-Do</span> — lists you name, for things you have to do. An item
              can stay a bare line, or gain a date, notification lead times, booked hours and a fixed slot on the
              calendar — added whenever you decide it needs them, not up front.
            </div>
            <div>
              <span className="text-text font-medium">Lists</span> — things you&apos;re keeping rather than doing: a
              reading list, questions for a supervision, what to pack. A paragraph, a checklist, or both. Nothing here
              is ever scheduled or notified.
            </div>
            <div>
              <span className="text-text font-medium">Archive</span> — finished work, kept rather than deleted so
              their logged hours survive. The weekly review archives anything fully done with nothing left scheduled;
              you can archive or restore by hand any time. Because the record stays intact, the chat can answer
              &ldquo;what did I get done this semester?&rdquo; from real hours.
            </div>
            <div>
              <span className="text-text font-medium">The strip along the top</span> shows this week live: done out of
              total, how many pieces of work are in progress against a soft limit of three, missed blocks, and at-risk
              deadlines. <span className="text-text">Time to plan</span> and{" "}
              <span className="text-text">Discuss this week&apos;s review</span> both drop you into the chat with a
              prompt filled in — they never send on their own, so you can edit first.
            </div>
          </div>

          <div className="rounded-lg border border-border bg-panel p-3.5 mb-3 text-xs text-muted leading-relaxed">
            <div className="text-sm font-medium text-text mb-1.5">Two modes in the chat</div>
            <p className="mb-2">
              The buttons above the message box pick which job the chat is doing, because the two want opposite
              behaviour:
            </p>
            <p className="mb-2">
              Booking-page rules are the exception to &ldquo;just ask the chat&rdquo;: they live in{" "}
              <span className="text-text">Settings → Booking page</span> only, because they govern what strangers can
              do to your calendar and that shouldn&apos;t be changeable by a sentence in a chat window. Each link
              lists its own rules underneath it, and <span className="text-text">edit</span> exposes all of them:
              meeting lengths, which days and the earliest/latest time each day, minimum notice before a booking,
              a gap around meetings, a daily cap, and which labels are protected from being booked over.
            </p>
            <p className="mb-2">
              <span className="text-text">Quick task</span> — for a single change. It acts immediately with no
              questions and no plan: &ldquo;log 45 minutes on grading&rdquo;, &ldquo;move my gym block to 6pm&rdquo;,
              &ldquo;archive the outreach task&rdquo;. Routine one-liners are also sent to a smaller model here, which
              is cheaper and quicker at no cost to the answer.
            </p>
            <p>
              <span className="text-text">Planning session</span> — for a stretch of time: a semester, a month, a new
              proposal. It interviews you a few questions at a time and fills the board in as your answers land,
              working outward from what can&apos;t move (term dates, teaching, deadlines, travel) to what can
              (research hours, writing). It always uses your chosen model, never a smaller one. The suggested
              openers beneath the buttons fill the box for you — edit them before sending. A semester plan is a real
              conversation, so expect to spend a few minutes on it, and expect to be told when the term you&apos;ve
              described doesn&apos;t fit the hours you actually have.
            </p>
          </div>

          <p className="text-xs text-muted leading-relaxed">
            Where the chat fits: it sits beside your calendar and shares every one of these tools. Saying &ldquo;I&apos;m
            working on the model study right now for an hour&rdquo; puts a real block on the calendar and reflows the rest;
            &ldquo;time to plan&rdquo; starts a short interview that fills the board out for you. The board is for
            seeing where things stand; the chat is for changing it.
          </p>
        </div>

        <div className="mt-8 pt-5 border-t border-border">
          <h2 id="block-labels" className="text-base font-medium mb-1 scroll-mt-4">Time block names</h2>
          <p className="text-xs text-muted mb-4 leading-relaxed">
            Every time block on the calendar shows a small tag naming what kind it is. What each one actually means:
          </p>
          <div className="rounded-lg border border-border bg-panel p-3.5 mb-4 text-xs text-muted leading-relaxed flex flex-col gap-2.5">
            <div>
              <span className="text-text font-medium">Work</span> — a one-off piece of work you or the chat added.
              No special placement rule beyond priority and deadline.
            </div>
            <div>
              <span className="text-text font-medium">Research</span> — hours generated automatically each week for
              a project that has a weekly-hours minimum (set on the project, not here) — placed in mornings
              first.
            </div>
            <div>
              <span className="text-text font-medium">Deep focus</span> — work explicitly restricted to mornings
              before noon. This is different from Research: it&apos;s one-off work with the morning-only rule turned
              on, not a project with a weekly minimum.
            </div>
            <div>
              <span className="text-text font-medium">Routine</span> — a standing weekly slot (like Emails or
              Lunch) that repeats on its own schedule.
            </div>
          </div>
          <p className="text-xs text-muted mb-3 leading-relaxed">
            Rename any of these — only the label changes, not the behavior. Leave blank to use the default.
          </p>
          <div className="flex flex-col gap-2">
            {(
              [
                ["task", "Work"],
                ["research", "Research"],
                ["deepFocus", "Deep focus"],
                ["block", "Routine"],
              ] as const
            ).map(([field, defaultLabel]) => (
              <div key={field} className="flex items-center gap-2.5">
                <span className="w-20 flex-none text-xs text-muted">{defaultLabel}</span>
                <input
                  defaultValue={tagLabels[field]}
                  placeholder={defaultLabel}
                  onBlur={(e) => {
                    if (e.target.value !== tagLabels[field]) saveTagLabel(field, e.target.value);
                  }}
                  className="flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text outline-none focus-visible:border-accent"
                />
              </div>
            ))}
          </div>
        </div>

        <div className="mt-8 pt-5 border-t border-border">
          <h2 id="standard-hours" className="text-base font-medium mb-1 scroll-mt-4">Standard hours</h2>
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
          <h2 id="categories" className="text-base font-medium mb-1 scroll-mt-4">Labels</h2>
          <p className="text-xs text-muted mb-4">
            Groups your work and projects, and colours the calendar: work carries its label&apos;s colour as a
            bar down the left edge of its time block, and weekly-hours blocks pick up their project&apos;s label.
            Name these whatever fits your work — Research, Writing, Teaching, Service. Add, rename, recolour, or
            remove any of them anytime. &quot;Min chunk&quot; is a hard floor in minutes — the scheduler will never
            shrink a block with this label smaller than this to fill a gap (default 30 if left blank).
          </p>

          <div className="flex flex-col gap-2">
            {categories.map((cat) => (
              <div key={cat.id} className="flex items-center gap-2.5 rounded-md border border-border bg-panel px-3 py-2">
                <input
                  type="color"
                  value={cat.color}
                  onChange={(e) => recolorCategory(cat.id, e.target.value)}
                  className="w-7 h-7 rounded border border-border bg-transparent p-0 cursor-pointer"
                  title="Label colour"
                />
                <input
                  defaultValue={cat.name}
                  onBlur={(e) => {
                    if (e.target.value.trim() && e.target.value !== cat.name) renameCategory(cat.id, e.target.value.trim());
                  }}
                  className="flex-1 bg-transparent text-sm text-text outline-none border-b border-transparent focus-visible:border-accent"
                />
                <input
                  type="number"
                  min={0}
                  step={5}
                  defaultValue={cat.min_chunk_min ?? ""}
                  placeholder="30"
                  title="Minimum chunk size (minutes)"
                  onBlur={(e) => {
                    const raw = e.target.value.trim();
                    const parsed = raw === "" ? null : Math.max(0, parseInt(raw, 10) || 0);
                    if (parsed !== (cat.min_chunk_min ?? null)) setCategoryMinChunk(cat.id, parsed);
                  }}
                  className="w-16 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text outline-none focus-visible:border-accent"
                />
                <button
                  onClick={() => deleteCategory(cat.id)}
                  title="Remove label"
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
                title="New label colour"
              />
              <input
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addCategory()}
                placeholder="New label name"
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
            <h2 id="calendars" className="text-base font-medium scroll-mt-4">Connected calendars</h2>
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

        <BookingSection categories={categories} />

        <div className="mt-8 pt-5 border-t border-border">
          <h2 id="notifications" className="text-base font-medium mb-1 scroll-mt-4">Notifications</h2>
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
      </div>
    </div>
  );
}
