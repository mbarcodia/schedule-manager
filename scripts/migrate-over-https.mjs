// Applies pending migrations over HTTPS, for networks that block Postgres.
//
// WHY THIS EXISTS
//
// `supabase db push` speaks the Postgres wire protocol on port 5432, and plenty
// of networks — university, corporate, hotel — drop that. See
// preflight-db-port.mjs for the diagnosis; this is the way through. Supabase's
// Management API runs SQL over 443, authenticated with the same
// SUPABASE_ACCESS_TOKEN the CLI uses, so the schema change goes in over the port
// the app itself already depends on.
//
// It is a fallback, not the default. The CLI stays the normal path because it
// does more than send SQL: it diffs, it repairs, it knows about local
// development. This does exactly one job — apply what is pending and record it.
//
// WHAT MAKES IT SAFE ENOUGH TO RUN WITHOUT ASKING
//
//  - `npm run migrate` has already taken a full snapshot into backups/ before
//    this is reached, and refuses to continue if that failed.
//  - Each migration is sent as ONE request, so Postgres runs it in a single
//    implicit transaction: either the whole file lands or none of it does. A
//    file that cannot run inside a transaction is detected and refused rather
//    than half-applied — see TRANSACTION_HOSTILE.
//  - The history row is written in that same request. It cannot record a
//    migration that did not apply, and it cannot apply one without recording
//    it, which is the drift that made 0048 need fixing by hand.
//  - Migrations already recorded are skipped, so running it twice does nothing.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MANAGEMENT_API = "https://api.supabase.com";

/** A bounded wait, because an unbounded one is the bug this whole area is about. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Statements Postgres refuses to run inside a transaction block. Sending one in
 * a multi-statement request fails partway, which is the one outcome worse than
 * not starting: a schema half-changed with no record of it. Refuse instead, and
 * say to use the SQL editor for that file. */
const TRANSACTION_HOSTILE = [
  /\bcreate\s+(unique\s+)?index\s+concurrently\b/i,
  /\bdrop\s+index\s+concurrently\b/i,
  /\bvacuum\b/i,
  /\breindex\b/i,
  /\balter\s+system\b/i,
];

/** Runs SQL through the Management API. Returns { ok, rows, status, error }. */
export async function runSql(ref, token, sql) {
  let response;
  try {
    response = await fetch(`${MANAGEMENT_API}/v1/projects/${ref}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    return { ok: false, error: timedOut ? `no answer within ${REQUEST_TIMEOUT_MS / 1000}s` : String(err) };
  }

  const body = await response.text();
  if (!response.ok) {
    let message = body;
    try {
      const parsed = JSON.parse(body);
      message = parsed.message || parsed.error || body;
    } catch {
      // Not JSON; the raw body is the best thing to show.
    }
    return { ok: false, status: response.status, error: message };
  }

  try {
    return { ok: true, status: response.status, rows: JSON.parse(body) };
  } catch {
    return { ok: true, status: response.status, rows: [] };
  }
}

/** `0048_calendar_tz_note.sql` -> { version: "0048", name: "calendar_tz_note" } */
export function parseMigrationFilename(file) {
  const match = file.match(/^(\d+)_(.+)\.sql$/);
  if (!match) return null;
  return { version: match[1], name: match[2], file };
}

export function localMigrations(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map(parseMigrationFilename)
    .filter(Boolean)
    .sort((a, b) => a.version.localeCompare(b.version));
}

/** One version, in a form two sources can be compared in. `0046` and `46` are
 * the same migration; treating them as different is not a cosmetic bug here —
 * it would mark every migration pending and try to replay the lot, and the
 * older ones in this repo are not written to survive that. The history table
 * stores text today, so this costs nothing and removes the trap. */
export function normalizeVersion(version) {
  return String(version).trim().replace(/^0+(?=\d)/, "");
}

/** Which local migrations the database has no record of, oldest first. Pure. */
export function pendingMigrations(local, recordedVersions) {
  const recorded = new Set(recordedVersions.map(normalizeVersion));
  return local.filter((m) => !recorded.has(normalizeVersion(m.version)));
}

/** A dollar-quote tag that does not appear in the text it has to wrap. Migrations
 * contain `do $$ ... $$` blocks of their own, so a fixed tag would end the quote
 * early and change what gets stored. */
export function safeDollarTag(text, seed = "mig") {
  let tag = `$${seed}$`;
  let n = 0;
  while (text.includes(tag)) {
    n += 1;
    tag = `$${seed}${n}$`;
  }
  return tag;
}

/** Why a file cannot go through this path, or null when it can. Pure. Reports the
 * text that actually matched, so the refusal names the statement in the file
 * rather than a category the reader then has to go looking for. */
export function transactionBlocker(sql) {
  for (const pattern of TRANSACTION_HOSTILE) {
    const match = sql.match(pattern);
    if (match) return match[0].replace(/\s+/g, " ").toLowerCase();
  }
  return null;
}

/**
 * The request for one migration: the file itself, then its history row, so the
 * two cannot come apart. `on conflict do nothing` because a concurrent CLI push
 * from another network is not worth failing over.
 */
export function buildMigrationRequest({ version, name }, sql) {
  const tag = safeDollarTag(sql);
  return [
    sql.trim().replace(/;?\s*$/, ";"),
    `insert into supabase_migrations.schema_migrations (version, name, statements)`,
    `values ('${version}', '${name.replace(/'/g, "''")}', array[${tag}${sql}${tag}])`,
    `on conflict (version) do nothing;`,
  ].join("\n");
}

/** Reads the versions the database has already applied. */
export async function recordedVersions(ref, token) {
  const result = await runSql(
    ref,
    token,
    "select version from supabase_migrations.schema_migrations order by version",
  );
  if (!result.ok) return result;
  return { ok: true, versions: (result.rows || []).map((r) => r.version) };
}

/**
 * Applies every pending migration in order, stopping at the first failure.
 * Returns { ok, applied: [...], skipped: [...], error, failedAt }.
 */
export async function applyPendingOverHttps({ ref, token, dir, log = console.log }) {
  const history = await recordedVersions(ref, token);
  if (!history.ok) {
    return { ok: false, applied: [], error: `could not read the migration history: ${history.error}` };
  }

  const pending = pendingMigrations(localMigrations(dir), history.versions);
  if (pending.length === 0) {
    return { ok: true, applied: [], upToDate: true };
  }

  log(`\n${pending.length} migration${pending.length === 1 ? "" : "s"} to apply over HTTPS:`);
  for (const m of pending) log(`  ${m.file}`);
  log("");

  const applied = [];
  for (const migration of pending) {
    const sql = readFileSync(join(dir, migration.file), "utf8");

    const blocker = transactionBlocker(sql);
    if (blocker) {
      return {
        ok: false,
        applied,
        failedAt: migration.file,
        error:
          `${migration.file} contains \`${blocker}\`, which Postgres will not run inside a\n` +
          `transaction. Applying it this way could leave it half-done with no record.\n` +
          `Run this one in the dashboard's SQL editor, or from a network that allows 5432.`,
      };
    }

    const result = await runSql(ref, token, buildMigrationRequest(migration, sql));
    if (!result.ok) {
      return {
        ok: false,
        applied,
        failedAt: migration.file,
        error: `${migration.file} was rejected${result.status ? ` (HTTP ${result.status})` : ""}: ${result.error}`,
      };
    }
    applied.push(migration.file);
    log(`  applied and recorded  ${migration.file}`);
  }

  return { ok: true, applied };
}
