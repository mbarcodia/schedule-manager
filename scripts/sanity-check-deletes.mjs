// Sanity check for "nothing the user typed can be destroyed"
// (run: npx tsx scripts/sanity-check-deletes.mjs).
//
// This is a source scan, not a behaviour test, because the failure it guards
// against is a line of code that does not exist yet. Migration 0043 moved seven
// tables onto soft delete and every read onto `deleted_at is null`. That is a
// rule about the whole codebase, and a rule about the whole codebase decays the
// first time somebody adds a query without knowing it exists — which is exactly
// how the August audit found eight bugs, one of them live data loss, after a
// state column went onto `projects` and the queries were not swept.
//
// So the invariant is enforced mechanically, in two halves:
//
//   1. NO HARD DELETES on a trashable table. Removing something means stamping
//      `deleted_at`. A `.delete()` on one of those tables destroys a row with no
//      undo, which is the entire thing we are preventing.
//
//   2. NO UNFILTERED READS of a trashable table. A `select` that forgets
//      `deleted_at` shows deleted rows as though they were live — the mirror
//      image of the bug, and worse in the chat, where trashed notes would be fed
//      back into the model as current context.
//
// Both halves take an allow-list, because a few call sites are legitimately
// exempt and each one should have to say why in writing. Exemptions are matched
// on `file:reason`, so moving the code does not silently carry the exemption
// with it.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

// Kept in sync with TRASHABLE in src/lib/db/soft-delete.ts. Duplicated rather
// than imported because this script is plain .mjs run before/independent of the
// TypeScript build, and a stale copy is caught by the check below.
const TRASHABLE = ["notes", "todo_items", "todo_lists", "lists", "list_items", "targets", "events"];

// Every exemption states the reason it is safe. Adding one is a deliberate act.
const ALLOWED_HARD_DELETE = {
  // The ICS mirror. These rows are not user data — they are a cache of an
  // external feed, re-fetched hourly. Soft-deleting them would put thousands of
  // meetings nobody deleted into Trash, and losing one costs nothing because the
  // next sync brings it back. Scoped to rows with a connection_id.
  "src/lib/calendar-sync/sync.ts": "ICS mirror rows, re-fetched every sync",
  // Purging Trash is the one place a hard delete is the point. It only ever
  // touches rows that already have deleted_at set, and the user asked twice.
  "src/lib/db/purge-trash.ts": "emptying Trash, on explicit request",
  // A booking that was never confirmed holds a slot for minutes. The row is
  // machinery, not something the user wrote down.
  "src/app/api/book/[slug]/route.ts": "unconfirmed hold, released on failure",
  "src/app/api/book/manage/[id]/route.ts": "cancelling a booking removes its calendar event",
};

const ALLOWED_UNFILTERED_READ = {
  // Reads Trash itself, so filtering to live rows would return nothing.
  "src/components/board/TrashView.tsx": "reads the complement — deleted rows are the point",
  "src/lib/db/purge-trash.ts": "operates on trashed rows only",
  // Counts what a delete is about to take; filters explicitly per-query.
  "src/lib/db/soft-delete.ts": "the helper that implements the rule",
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

let failures = 0;
let checks = 0;
function fail(msg) {
  failures++;
  console.log(`FAIL ${msg}`);
}

const files = walk(SRC);

// --- Half 1: no hard deletes on a trashable table -------------------------
//
// Matches `.from("notes")` ... `.delete()` on the same logical statement.
// Supabase chains can wrap across lines, so the file is flattened first and the
// line number recovered from the offset.
/** Line number of a byte offset, 1-indexed. Matching runs against the raw
 * source rather than a whitespace-flattened copy precisely so this works: an
 * approximate line ("the first from() in the file") sends you to the wrong one
 * of twenty call sites, which is worse than no line at all. */
function lineAt(src, index) {
  return (src.slice(0, index).match(/\n/g) ?? []).length + 1;
}

/** The full `.from("x").select(...).eq(...)` chain starting at `start`, found by
 * walking parentheses rather than matching a terminator.
 *
 * A regex cannot do this, and the first version of this script proved it by
 * reporting a clean pass on src/lib/scheduling/query-rows.ts — the one file that
 * feeds both the scheduling engine and the chat's per-turn snapshot. Its queries
 * sit inside an array literal, one per line, separated by commas:
 *
 *     supabase.from("targets").select("*").eq("user_id", userId),
 *     supabase.from("events").select("*").is("deleted_at", null),
 *
 * Any terminator cheap enough to write as a regex (`;`, a blank line) is not
 * present at the end of the first entry, so the match ran on into the second and
 * found ITS `deleted_at` — and the unfiltered query passed because the next one
 * happened to be filtered. A silent false negative in the checker built to stop
 * silent data loss.
 *
 * So: track depth from the opening paren, skip string literals so a `)` inside
 * one cannot close the call, and end the chain at the first closing paren that
 * is not followed by another `.`. */
function chainAt(src, start) {
  let i = src.indexOf("(", start);
  if (i < 0) return src.slice(start, start + 200);
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        let j = i + 1;
        while (j < src.length && /\s/.test(src[j])) j++;
        if (src[j] === ".") {
          i = j;
          continue;
        }
        return src.slice(start, i + 1);
      }
    }
    i++;
  }
  return src.slice(start);
}

for (const file of files) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, "utf8");
  for (const table of TRASHABLE) {
    const pattern = new RegExp(`from\\("${table}"\\)`, "g");
    let m;
    while ((m = pattern.exec(src)) !== null) {
      const stmt = chainAt(src, m.index);
      if (!/\.delete\(\)/.test(stmt)) continue;
      checks++;
      if (ALLOWED_HARD_DELETE[rel]) continue;
      fail(
        `${rel}:${lineAt(src, m.index)} hard-deletes from "${table}".\n` +
          `     Removing user content means softDelete() from @/lib/db/soft-delete.\n` +
          `     If this row genuinely is not user content, add ${rel} to ALLOWED_HARD_DELETE with a reason.`,
      );
    }
  }
}

// --- Half 2: no unfiltered reads of a trashable table ---------------------
//
// A read is `.from("x").select(...)`. It is filtered if the same statement
// mentions deleted_at at all — `.is("deleted_at", null)` for live rows, or
// `.not(...)`/`.eq(...)` in the Trash view.
for (const file of files) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, "utf8");
  for (const table of TRASHABLE) {
    const pattern = new RegExp(`from\\("${table}"\\)`, "g");
    let m;
    while ((m = pattern.exec(src)) !== null) {
      const stmt = chainAt(src, m.index);
      if (!/\.select\(/.test(stmt)) continue;
      checks++;
      if (ALLOWED_UNFILTERED_READ[rel]) continue;
      if (stmt.includes("deleted_at")) continue;
      // `.insert(...).select()` and `.update(...).select()` are writes that echo
      // the row back, not reads of the table. A row you just inserted is live by
      // definition, and an update already carries its own filters — requiring
      // deleted_at on either would be noise, and noise is how a check stops
      // being read.
      if (/\.(insert|upsert)\(/.test(stmt)) continue;
      if (/\.update\(/.test(stmt)) continue;
      fail(
        `${rel}:${lineAt(src, m.index)} reads "${table}" without filtering deleted_at.\n` +
          `     Add .is("deleted_at", null), or list the file in ALLOWED_UNFILTERED_READ.\n` +
          `     Statement: ${stmt.replace(/\s+/g, " ").slice(0, 110)}…`,
      );
    }
  }
}

// --- Half 3: the two lists agree -------------------------------------------
//
// This script's copy of TRASHABLE is a duplicate; a table added to the helper
// and not here would silently escape both halves above.
checks++;
const helper = readFileSync(join(SRC, "lib/db/soft-delete.ts"), "utf8");
const declared = [...helper.matchAll(/^\s{2}"([a-z_]+)",$/gm)].map((m) => m[1]);
const missing = declared.filter((t) => !TRASHABLE.includes(t));
const extra = TRASHABLE.filter((t) => !declared.includes(t));
if (missing.length || extra.length) {
  fail(
    `TRASHABLE is out of sync with src/lib/db/soft-delete.ts.\n` +
      `     only in helper: ${missing.join(", ") || "none"}\n` +
      `     only in script: ${extra.join(", ") || "none"}`,
  );
}

// --- Half 4: migrations may not destroy without saying so ------------------
//
// Migrations in this repo HAVE dropped tables and deleted rows, carefully and
// with a backfill first. Nothing enforced the care. A destructive statement is
// now allowed only in a file that acknowledges it in a comment, so the reviewer
// of a future migration cannot miss that it throws data away.
// The acknowledgement is an explicit marker rather than a vocabulary match. The
// first version of this check scanned for words like "backfill" and failed four
// migrations that were, on reading them, careful — 0026 adopts orphaned prep
// bookings before dropping the column, 0031 explains what 0030 converted. They
// simply did not happen to use the magic word, and the honest fix for that is
// not to reword history until a regex is satisfied. A marker cannot be passed by
// accident and cannot be passed by writing prose that sounds reassuring.
const MIGRATIONS = join(ROOT, "supabase/migrations");

// Written before the marker existed. Each was read and its actual data
// behaviour recorded here, including the one that really did lose something.
const REVIEWED_MIGRATIONS = {
  "0003_weekly_hours.sql":
    "LOST DATA. Replaced work_start_hour/work_end_hour with a weekly_hours default of 9-17 " +
    "and dropped the originals with no backfill, so a custom start hour was silently reset. " +
    "Pre-release, single user, unrecoverable now — recorded rather than hidden.",
  "0023_commitments_and_targets.sql": "Rows copied into projects and every link moved before the delete.",
  "0024_drop_folded_tables.sql": "Tables emptied by 0023; dropped once the reading code was deployed.",
  "0025_todo_merge_and_lists.sql": "Every reminder row moved onto a to-do immediately above the delete.",
  "0026_drop_reminders_and_prep.sql": "Orphan prep bookings adopted as the item's own booking first.",
  "0031_drop_tag_labels.sql": "Columns converted to labels by 0030; recurring_rules.tag deliberately kept.",
};

for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))) {
  const src = readFileSync(join(MIGRATIONS, file), "utf8");
  const destructive = /\b(drop\s+table|drop\s+column|delete\s+from|truncate)\b/i.test(src);
  if (!destructive) continue;
  checks++;
  if (REVIEWED_MIGRATIONS[file]) continue;
  if (/^--\s*data-loss:/im.test(src)) continue;
  fail(
    `supabase/migrations/${file} drops a column, drops a table, or deletes rows.\n` +
      `     Every destructive migration must carry a line saying what happens to the data:\n` +
      `       -- data-loss: <backfilled into X above / nothing reads this since Y / rows really are discarded because Z>\n` +
      `     Say it plainly. "data-loss: none, backfilled above" is fine; a claim that isn't true is not.`,
  );
}

console.log(`\n${checks - failures}/${checks} delete-safety checks passed`);
process.exit(failures ? 1 : 0);
