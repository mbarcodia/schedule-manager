// A full snapshot of the database, on disk, before you change its shape
// (run: npm run backup).
//
// Trash protects you from deleting something during ordinary use. It does
// nothing about the other way data goes missing: a migration. Migrations in this
// repo have dropped columns and deleted rows, and one of them —
// 0003_weekly_hours.sql — really did silently reset a setting because it added a
// default and dropped the original in the same file with no backfill. Nobody
// noticed at the time. There was nothing to compare against.
//
// So this exists to be run immediately before `supabase db push`, and the README
// says so. It is deliberately dumb: read every table, write one JSON file, print
// what it saw. No incremental logic, no cloud service, no scheduling — anything
// cleverer is a thing that can fail quietly, which defeats the point.
//
// The output goes to backups/, which .gitignore excludes. That is not
// housekeeping: a snapshot is the plaintext of every note and to-do you own, and
// this repo is a public template.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env.local"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local.");
  process.exit(1);
}

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Every table holding anything a person entered or the app derived. Ordered
// roughly parent-before-child so the file reads sensibly; restoring follows the
// same order.
//
// A table missing from this list is a table that is not in your backup, which is
// the failure mode this script would have if nobody maintained it. The check
// below compares against what the database actually has, so adding a table and
// forgetting this list is loud rather than silent.
const TABLES = [
  "profiles",
  "categories",
  "projects",
  "targets",
  "tasks",
  "recurring_rules",
  // Worth backing up for a reason the other tables don't share: removing a
  // routine hard-deletes its notes via the routine_id cascade, and they do not
  // reach the Trash (migration 0044). A snapshot is the only way back.
  "routine_notes",
  "preference_notes",
  "day_overrides",
  "events",
  "progress_log",
  "pinned_chunks",
  "research_pins",
  "notes",
  "todo_lists",
  "todo_items",
  "lists",
  "list_items",
  "calendar_connections",
  "booking_links",
  "bookings",
  "planner_messages",
  // The retired assistant's history. Nothing reads it since the two chats were
  // merged, and the table was never dropped — which makes it exactly the sort of
  // thing a future migration cleans up. It is still a record of real
  // conversations, so it is backed up rather than written off; the completeness
  // check below is what surfaced it.
  "chat_messages",
];

// Deliberately NOT backed up: planner_credentials, google_credentials,
// push_subscriptions. They hold secrets and device tokens, they are all
// re-obtainable by signing in again, and writing them to an unencrypted file on
// disk would create a worse problem than the one this solves.
const EXCLUDED = ["planner_credentials", "google_credentials", "push_subscriptions"];

// Is the list above still complete? Derived from the migrations rather than
// trusted, because "somebody remembered to add the new table here" is exactly
// the kind of promise that quietly stops being true — and the failure would be a
// backup that looks successful while missing a table entirely.
{
  const dirPath = join(ROOT, "supabase/migrations");
  const created = new Set();
  for (const f of readdirSync(dirPath).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(dirPath, f), "utf8");
    for (const m of sql.matchAll(/create table (?:if not exists )?public\.([a-z_]+)/gi)) created.add(m[1]);
    for (const m of sql.matchAll(/drop table (?:if exists )?public\.([a-z_]+)/gi)) created.delete(m[1]);
  }
  const known = new Set([...TABLES, ...EXCLUDED]);
  const unlisted = [...created].filter((t) => !known.has(t)).sort();
  if (unlisted.length) {
    console.error(
      `This backup would be INCOMPLETE. Tables in the schema but not in this script:\n` +
        unlisted.map((t) => `  - ${t}`).join("\n") +
        `\n\nAdd each to TABLES (to back it up) or EXCLUDED (with a reason), then re-run.`,
    );
    process.exit(1);
  }
}

const stamp = new Date().toISOString().replace(/:/g, "-").slice(0, 16);
const dir = join(ROOT, "backups");
mkdirSync(dir, { recursive: true });
const outPath = join(dir, `${stamp}.json`);

const snapshot = { taken_at: new Date().toISOString(), tables: {} };
let total = 0;
let failed = 0;
/** Listed here and in a migration, but not in the live database yet — i.e. the
 * migration about to be applied is the one that creates it.
 *
 * This is NOT an incomplete backup, and treating it as one deadlocks the only
 * safe way to migrate: the completeness check above (rightly) demands the new
 * table be listed, the live read then (rightly) fails because it doesn't exist,
 * and `npm run migrate` can never run for any change that adds a table. The
 * distinction that resolves it is that a table which doesn't exist holds nothing,
 * so there is nothing it could be losing. A table that EXISTS and fails to read
 * is still a hard stop. */
const pending = [];

for (const table of TABLES) {
  // Paged: a default select caps out and would truncate a large table into a
  // backup that looks complete.
  const rows = [];
  let from = 0;
  const PAGE = 1000;
  let missing = false;
  for (;;) {
    const { data, error } = await admin.from(table).select("*").range(from, from + PAGE - 1);
    if (error) {
      // PGRST205 is PostgREST's "no such table". Matched on the code rather than
      // the message so a genuine permission or connection failure on an existing
      // table can never be waved through as "not migrated yet".
      if (error.code === "PGRST205" && from === 0) {
        missing = true;
        pending.push(table);
      } else {
        console.error(`  !! ${table}: ${error.message}`);
        failed++;
      }
      break;
    }
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  if (missing) {
    console.log(`       -  ${table} (not created yet — this migration adds it)`);
    continue;
  }
  snapshot.tables[table] = rows;
  total += rows.length;
  console.log(`  ${String(rows.length).padStart(6)}  ${table}`);
}

writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

console.log(`\n${total} rows from ${TABLES.length - pending.length} tables -> backups/${stamp}.json`);
if (EXCLUDED.length) console.log(`(excluded, by design: ${EXCLUDED.join(", ")})`);
if (pending.length)
  console.log(`(not in the database yet, so nothing to snapshot: ${pending.join(", ")})`);

if (failed) {
  console.error(
    `\n${failed} table(s) FAILED to read. This snapshot is incomplete — do not run a migration against it.`,
  );
  process.exit(1);
}

console.log(
  "\nRestoring: this file is plain JSON, one array per table. To put a table back,\n" +
    "read its array and upsert the rows — parents before children, or the foreign\n" +
    "keys will reject them. Restore into a fresh Supabase project first and check it\n" +
    "there before pointing anything at your live one.",
);
