// Re-fetches every calendar feed from scratch, INCLUDING the past
// (run: npx tsx scripts/resync-calendars.mjs [--months-back 24] [--apply]).
//
// The normal hourly/daily sync only rewrites from yesterday forward — anything
// older is left alone on purpose, so the calendar keeps a record of what each
// week actually held. That is the right default and the wrong behaviour exactly
// once: when the stored times were WRONG, and the record is a record of a bug.
//
// That happened. Outlook publishes its feed with `TZID:Customized Time Zone`,
// which node-ical could not resolve and answered with the SERVER's timezone, so
// every meeting on that calendar was stored four hours early. Fixing the parser
// corrects everything from here on; this corrects what was already written.
//
// Dry-run by default. It prints what would change and touches nothing until
// --apply, because "delete a year of calendar rows" should not be one typo away.
//
// SCOPE: only rows with a connection_id, i.e. mirrors of a feed that will be
// re-created from that same feed in the same transaction-ish step. Manual events,
// booked meetings (bookings.event_id) and to-do events have no connection_id and
// are never touched — the same reason sanity-check-deletes.mjs exempts
// calendar-sync/sync.ts from the no-hard-delete rule.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fetchIcsEvents } from "../src/lib/calendar-sync/ics.ts";
import { HORIZON_WEEKS } from "../src/lib/scheduling/horizon.ts";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const monthsBack = Number(args[args.indexOf("--months-back") + 1]) || 24;

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY);

const SOURCE_BY_PROVIDER = { outlook_ics: "outlook", icloud_ics: "icloud", google_ics: "google" };

const now = new Date();
const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
const to = new Date(now.getTime() + HORIZON_WEEKS * 7 * 86400000);

const fmt = (iso, tz) =>
  new Date(iso).toLocaleString("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

console.log(
  `${APPLY ? "APPLYING" : "DRY RUN"} — window ${from.toISOString().slice(0, 10)} .. ${to.toISOString().slice(0, 10)}\n`,
);

const { data: connections, error } = await db
  .from("calendar_connections")
  .select("id,user_id,provider,label,ics_url,all_day_mode");
if (error) {
  console.error("could not read connections:", error.message);
  process.exit(1);
}

let totalMoved = 0;
let totalRows = 0;

for (const c of connections) {
  const { data: profile } = await db.from("profiles").select("timezone").eq("id", c.user_id).maybeSingle();
  const tz = profile?.timezone || "UTC";

  let parsed;
  try {
    parsed = await fetchIcsEvents(c.ics_url, from, to, c.all_day_mode !== "ignore", tz);
  } catch (err) {
    console.log(`## ${c.label}: FEED ERROR — ${err.message}\n   left untouched`);
    continue;
  }
  const { events, resolutions, floatingCount } = parsed;

  // What is stored now, keyed by the identity the sync writes.
  const { data: existing } = await db
    .from("events")
    .select("id,external_id,starts_at,title")
    .eq("connection_id", c.id)
    .gte("starts_at", from.toISOString())
    .lte("starts_at", to.toISOString());
  const before = new Map((existing ?? []).map((e) => [e.external_id, e]));

  // Report which times MOVED rather than calling every row changed. Matching on
  // external_id alone undercounts badly: a recurrence's id embeds its own start
  // instant (`<uid>-<iso>`), so every corrected occurrence gets a NEW id and
  // looks like an unrelated insert. So fall back to matching by title, pairing
  // each stored row with the nearest unclaimed feed event of the same name.
  const byTitle = new Map();
  for (const e of events) {
    if (!byTitle.has(e.title)) byTitle.set(e.title, []);
    byTitle.get(e.title).push({ at: e.startsAt.getTime(), taken: false });
  }
  const MATCH_WINDOW_MS = 26 * 3600000;
  const moved = [];
  for (const row of existing ?? []) {
    const storedAt = new Date(row.starts_at).getTime();
    const exact = before.get(row.external_id) && events.find((e) => e.uid === row.external_id);
    if (exact && exact.startsAt.getTime() === storedAt) continue;

    const candidates = byTitle.get(row.title) ?? [];
    let best = null;
    for (const cand of candidates) {
      if (cand.taken) continue;
      const delta = Math.abs(cand.at - storedAt);
      if (delta <= MATCH_WINDOW_MS && (!best || delta < Math.abs(best.at - storedAt))) best = cand;
    }
    if (!best) continue; // gone from the feed, or too far to be the same meeting
    best.taken = true;
    if (best.at !== storedAt) {
      moved.push({ title: row.title, from: row.starts_at, to: new Date(best.at).toISOString() });
    }
  }

  console.log(`## ${c.label} (${c.provider})`);
  console.log(`   ${resolutions.map((r) => `${r.tzid} => ${r.zone} [${r.kind}]`).join("\n   ") || "no TZIDs"}`);
  for (const r of resolutions.filter((r) => r.warning)) console.log(`   ⚠ ${r.warning}`);
  if (floatingCount) console.log(`   ⚠ ${floatingCount} time(s) had no zone; read as ${tz}`);
  console.log(
    `   stored now: ${existing?.length ?? 0} rows | feed gives: ${events.length} | times being corrected: ${moved.length}`,
  );

  const shifts = new Map();
  for (const m of moved) {
    const hours = (new Date(m.to) - new Date(m.from)) / 3600000;
    shifts.set(hours, (shifts.get(hours) ?? 0) + 1);
  }
  for (const [hours, n] of [...shifts].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${n} event(s) move ${hours > 0 ? "+" : ""}${hours}h`);
  }
  for (const m of moved.slice(0, 4)) {
    console.log(`     e.g. ${m.title.slice(0, 40)}\n          ${fmt(m.from, tz)}  ->  ${fmt(m.to, tz)}`);
  }

  totalMoved += moved.length;
  totalRows += events.length;

  if (!APPLY) {
    console.log("");
    continue;
  }

  const { error: delError } = await db
    .from("events")
    .delete()
    .eq("connection_id", c.id)
    .gte("starts_at", from.toISOString())
    .lte("starts_at", to.toISOString());
  if (delError) {
    console.log(`   FAILED to clear old rows: ${delError.message} — nothing inserted, feed left as it was\n`);
    continue;
  }

  if (events.length > 0) {
    const { error: insError } = await db.from("events").insert(
      events.map((e) => ({
        user_id: c.user_id,
        title: e.title,
        starts_at: e.startsAt.toISOString(),
        ends_at: e.endsAt.toISOString(),
        source: SOURCE_BY_PROVIDER[c.provider],
        all_day: e.allDay,
        external_id: e.uid,
        connection_id: c.id,
        description: e.description,
        location: e.location,
        meeting_url: e.meetingUrl,
      })),
    );
    if (insError) {
      console.log(`   INSERT FAILED: ${insError.message}`);
      console.log("   this feed now has NO rows in the window — re-run to restore it\n");
      continue;
    }
  }

  await db
    .from("calendar_connections")
    .update({ last_synced_at: new Date().toISOString(), last_sync_error: null, last_sync_event_count: events.length })
    .eq("id", c.id);

  // Best-effort, and separate — same reasoning as calendar-sync/sync.ts: the
  // note is an annotation, so it must not be able to fail the repair on a
  // database where migration 0048 has not been applied yet.
  const notes = resolutions.filter((r) => r.warning).map((r) => r.warning);
  if (floatingCount > 0) notes.push(`${floatingCount} time(s) carried no timezone; read as ${tz}`);
  const { error: noteError } = await db
    .from("calendar_connections")
    .update({ last_sync_tz_note: notes.length > 0 ? notes.join("; ") : null })
    .eq("id", c.id);
  if (noteError) console.log(`   (timezone note not recorded: ${noteError.message})`);

  console.log(`   rewritten: ${events.length} rows\n`);
}

console.log(
  `${APPLY ? "done" : "dry run"} — ${totalRows} rows across ${connections.length} feeds, ${totalMoved} times ${APPLY ? "corrected" : "would move"}`,
);
if (!APPLY) console.log("re-run with --apply to write it.");
