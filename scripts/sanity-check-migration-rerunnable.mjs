// New migrations must survive being run twice.
//
// WHY THIS IS A RULE HERE AND NOT JUST GOOD MANNERS
//
// This app's schema can be changed two ways: `supabase db push`, which records
// what it applied, and — on a network that blocks Postgres ports — by hand in
// the dashboard's SQL editor, which records nothing. A hand-applied migration
// stays "pending" forever as far as the CLI is concerned, so the next push from
// an unfiltered network runs it AGAIN. If that second run errors, the push dies
// on it, and every migration queued behind it stops too.
//
// That is not hypothetical: 0048 was applied by hand for exactly that reason,
// and had to be rewritten with `if not exists` afterwards. The rule is cheap
// when followed from the start and annoying to retrofit, which is what a check
// is for.
//
// GRANDFATHERING
//
// 0001–0047 are recorded in the database's migration history, verified directly.
// They will never be replayed, so rewriting them now would be churn with no
// safety gained — and editing an applied migration is its own bad habit. The
// rule applies from 0048 on, which is the first one this actually bit.
//
// THE ESCAPE HATCH
//
// A migration that cannot be written re-runnably says so, in the same shape as
// the `-- data-loss:` line this repo already requires:
//
//   -- rerunnable: no — this backfills from a table dropped later in the file,
//   --   so a second run has nothing to read. Apply it once, from a network
//   --   that allows 5432.
//
// A claim there is a decision on the record, not a way to silence the check
// without thinking. Say the true thing.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = new URL("../supabase/migrations/", import.meta.url).pathname;

/** Everything at or below this version predates the rule and is already applied. */
const GRANDFATHERED_THROUGH = 47;

/** Statements that fail on a second run, and what to write instead. `needsPrior`
 * is for objects Postgres gives no `if not exists` at all: those are re-runnable
 * only if the file clears the object out first. */
const RULES = [
  {
    what: "create table",
    find: /\bcreate\s+table\s+(?!if\s+not\s+exists)/gi,
    fix: "create table if not exists",
  },
  {
    what: "add column",
    find: /\badd\s+column\s+(?!if\s+not\s+exists)/gi,
    fix: "add column if not exists",
  },
  {
    what: "create index",
    find: /\bcreate\s+(?:unique\s+)?index\s+(?!if\s+not\s+exists)(?!concurrently\s+if\s+not\s+exists)/gi,
    fix: "create index if not exists",
  },
  {
    what: "drop column",
    find: /\bdrop\s+column\s+(?!if\s+exists)/gi,
    fix: "drop column if exists",
  },
  {
    what: "drop table",
    find: /\bdrop\s+table\s+(?!if\s+exists)/gi,
    fix: "drop table if exists",
  },
  {
    what: "create type",
    find: /\bcreate\s+type\b/gi,
    needsPrior: /\bdrop\s+type\s+if\s+exists\b/i,
    fix: "a preceding `drop type if exists`, or a do-block that checks pg_type",
  },
  {
    what: "create policy",
    find: /\bcreate\s+policy\b/gi,
    needsPrior: /\bdrop\s+policy\s+if\s+exists\b/i,
    fix: "a preceding `drop policy if exists ... on ...` (Postgres has no `create policy if not exists`)",
  },
  {
    what: "create trigger",
    find: /\bcreate\s+trigger\b/gi,
    needsPrior: /\bdrop\s+trigger\s+if\s+exists\b/i,
    fix: "a preceding `drop trigger if exists ... on ...`",
  },
  {
    what: "add constraint",
    find: /\badd\s+constraint\b/gi,
    needsPrior: /\bdrop\s+constraint\s+if\s+exists\b/i,
    fix: "a preceding `drop constraint if exists`",
  },
];

/**
 * Removes `--` comments so prose is never mistaken for SQL. 0048's own header
 * describes the statement it applies, in words, including `add column
 * last_sync_tz_note text` — a scan that reads comments flags the file that
 * motivated the rule, which is the fastest way to get a check switched off.
 *
 * Dollar-quoted bodies are left alone: a `do $$ ... $$` block is real SQL, and
 * a `--` inside one is a real comment too, so line-wise stripping is right for
 * both.
 */
export function stripSqlComments(sql) {
  return sql
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

export function versionOf(file) {
  const match = file.match(/^(\d+)_/);
  return match ? Number(match[1]) : null;
}

/** Every rule a file breaks. Pure, so the check itself is testable. */
export function violations(sql) {
  const declared = /^--\s*rerunnable:/im.test(sql);
  if (declared) return [];

  const code = stripSqlComments(sql);
  const found = [];
  for (const rule of RULES) {
    const matches = code.match(rule.find);
    if (!matches) continue;
    if (rule.needsPrior && rule.needsPrior.test(code)) continue;
    found.push({ what: rule.what, count: matches.length, fix: rule.fix });
  }
  return found;
}

// --- the rules, checked against SQL written for the purpose ---------------
//
// Only migrations after 0047 are scanned, and there is one of those, so the real
// scan alone would prove almost nothing. These cases prove the detection works
// at all — without writing a file into supabase/migrations/, which the HTTPS
// fallback would see as pending and apply to the live database.

const SELF_TESTS = [
  {
    name: "a bare create table is caught",
    sql: "create table public.thing (id uuid primary key);",
    expect: ["create table"],
  },
  {
    name: "a guarded create table passes",
    sql: "create table if not exists public.thing (id uuid primary key);",
    expect: [],
  },
  {
    name: "a bare add column is caught",
    sql: "alter table public.thing add column note text;",
    expect: ["add column"],
  },
  {
    name: "0048's actual statement passes",
    sql: "alter table public.calendar_connections\n  add column if not exists last_sync_tz_note text;",
    expect: [],
  },
  {
    name: "prose in a comment is not SQL",
    sql: "-- this migration will add column note text to the table\nselect 1;",
    expect: [],
  },
  {
    name: "a policy with no preceding drop is caught",
    sql: 'create policy "own thing" on public.thing using (auth.uid() = user_id);',
    expect: ["create policy"],
  },
  {
    name: "a policy dropped first passes",
    sql:
      'drop policy if exists "own thing" on public.thing;\n' +
      'create policy "own thing" on public.thing using (auth.uid() = user_id);',
    expect: [],
  },
  {
    name: "a bare index is caught",
    sql: "create index thing_idx on public.thing (user_id);",
    expect: ["create index"],
  },
  {
    name: "a guarded unique index passes",
    sql: "create unique index if not exists thing_uniq on public.thing (user_id);",
    expect: [],
  },
  {
    name: "an unguarded drop column is caught",
    sql: "alter table public.thing drop column note;",
    expect: ["drop column"],
  },
  {
    name: "several problems in one file are all reported",
    sql: "create table public.a (id uuid);\nalter table public.b add column c text;",
    expect: ["create table", "add column"],
  },
  {
    name: "a declared exception is respected",
    sql: "-- rerunnable: no — backfills from a table this file drops.\ncreate table public.a (id uuid);",
    expect: [],
  },
  {
    name: "the declaration must be that line, not the word in passing",
    sql: "-- this is rerunnable, honestly\ncreate table public.a (id uuid);",
    expect: ["create table"],
  },
];

let selfTestFailures = 0;
for (const t of SELF_TESTS) {
  const got = violations(t.sql).map((v) => v.what);
  if (JSON.stringify(got) !== JSON.stringify(t.expect)) {
    selfTestFailures += 1;
    console.error(`FAIL  rule check "${t.name}": expected ${JSON.stringify(t.expect)}, got ${JSON.stringify(got)}`);
  }
}
if (selfTestFailures > 0) {
  console.error(`\n${selfTestFailures} of the rules do not behave as documented — fix these before trusting the scan.`);
  process.exit(1);
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
let checked = 0;
let failures = 0;

for (const file of files) {
  const version = versionOf(file);
  if (version === null || version <= GRANDFATHERED_THROUGH) continue;
  checked += 1;

  const found = violations(readFileSync(join(DIR, file), "utf8"));
  if (found.length === 0) continue;

  failures += 1;
  console.error(`\nFAIL  supabase/migrations/${file} would fail if it ran twice:`);
  for (const v of found) {
    console.error(`        ${v.what}${v.count > 1 ? ` (${v.count}×)` : ""} — use ${v.fix}`);
  }
}

if (checked === 0) {
  // A check that silently examines nothing is worse than no check: it reads as
  // a pass forever. Say so instead.
  console.error(
    `\nNo migrations after ${String(GRANDFATHERED_THROUGH).padStart(4, "0")} were found to check.\n` +
      "If migrations were renumbered, GRANDFATHERED_THROUGH needs revisiting.",
  );
  process.exit(1);
}

if (failures > 0) {
  console.error(
    `\n${failures} migration(s) are not safe to re-run.\n` +
      "This matters because a migration applied by hand (see the HTTPS fallback in\n" +
      "scripts/migrate-over-https.mjs) leaves no history row and WILL be replayed.\n" +
      "If a file genuinely cannot be written this way, say why with a\n" +
      "`-- rerunnable:` line.",
  );
  process.exit(1);
}

console.log(
  `${SELF_TESTS.length} rules behave as documented; ${checked}/${checked} migrations after ` +
    `${String(GRANDFATHERED_THROUGH).padStart(4, "0")} are safe to re-run`,
);
