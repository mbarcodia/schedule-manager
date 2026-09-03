// The HTTPS migration fallback, checked without touching a network.
//
// This path writes the schema, so the parts that decide WHAT it writes are kept
// pure and pinned here: which migrations count as pending, how the file is
// wrapped so its own dollar-quoting survives, and which files must be refused
// because they cannot run inside a transaction.
//
// The one that would be silent if wrong is the dollar tag. A fixed `$mig$` looks
// fine until a migration contains `$mig$` itself, at which point the quote ends
// early, the stored history text is truncated, and nothing complains.

import {
  pendingMigrations,
  parseMigrationFilename,
  safeDollarTag,
  transactionBlocker,
  buildMigrationRequest,
} from "./migrate-over-https.mjs";

let failed = 0;
const eq = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) console.log(`  ok    ${label}`);
  else {
    failed += 1;
    console.error(`  FAIL  ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

// --- which files are pending -------------------------------------------------

const local = [
  { version: "0046", name: "day_focus", file: "0046_day_focus.sql" },
  { version: "0047", name: "task_pins", file: "0047_task_pins.sql" },
  { version: "0048", name: "calendar_tz_note", file: "0048_calendar_tz_note.sql" },
];

eq(
  "only unrecorded migrations are pending",
  pendingMigrations(local, ["0046", "0047"]).map((m) => m.version),
  ["0048"],
);
eq("a fully recorded database has nothing pending", pendingMigrations(local, ["0046", "0047", "0048"]), []);
eq(
  "an empty history means everything is pending, oldest first",
  pendingMigrations(local, []).map((m) => m.version),
  ["0046", "0047", "0048"],
);
// The history table stores version as text; a caller handing back numbers must
// not cause every migration to be reapplied.
eq("numeric versions from the database still match", pendingMigrations(local, [46, 47, 48]).map((m) => m.version), []);

eq("filenames parse into version and name", parseMigrationFilename("0048_calendar_tz_note.sql"), {
  version: "0048",
  name: "calendar_tz_note",
  file: "0048_calendar_tz_note.sql",
});
eq("a file that is not a migration is ignored", parseMigrationFilename("README.md"), null);

// --- dollar quoting ----------------------------------------------------------

eq("the default tag is used when it is free", safeDollarTag("select 1;"), "$mig$");
eq("a tag already in the text is not reused", safeDollarTag("select $mig$x$mig$;"), "$mig1$");
eq("plain do-blocks do not collide", safeDollarTag("do $$ begin end $$;"), "$mig$");

// A migration containing the tag must still round-trip whole. This is the
// regression the tag exists for: the wrapped text has to reappear intact.
const awkward = "do $mig$ begin perform 1; end $mig$;";
const request = buildMigrationRequest({ version: "0099", name: "awkward" }, awkward);
const tag = safeDollarTag(awkward);
eq("an awkward migration is wrapped in a non-colliding tag", request.includes(`array[${tag}${awkward}${tag}]`), true);
eq("the chosen tag does not appear inside the migration body", awkward.includes(tag), false);

// A name with an apostrophe must not end the SQL string literal early.
eq(
  "a quote in the migration name is escaped",
  buildMigrationRequest({ version: "0100", name: "o'brien" }, "select 1;").includes("'o''brien'"),
  true,
);

// The history row and the migration go in one request, so neither can happen
// without the other.
eq("the request records the version it applies", request.includes("'0099'"), true);
eq("the request writes to the CLI's history table", request.includes("supabase_migrations.schema_migrations"), true);

// --- files this path must refuse --------------------------------------------

eq("create index concurrently is refused", transactionBlocker("create index concurrently i on t (c);"), "create index concurrently");
eq("create unique index concurrently is refused", transactionBlocker("create unique index concurrently i on t (c);"), "create unique index concurrently");
eq("vacuum is refused", transactionBlocker("vacuum analyze public.events;"), "vacuum");
eq("ordinary DDL is allowed through", transactionBlocker("alter table t add column if not exists c text;"), null);
eq(
  "a real migration from this repo is allowed through",
  transactionBlocker("alter table public.calendar_connections add column if not exists last_sync_tz_note text;"),
  null,
);

if (failed > 0) {
  console.error(`\n${failed} HTTPS-fallback check(s) failed`);
  process.exit(1);
}
console.log("\nHTTPS migration fallback: pending-set, dollar quoting and transaction guards all hold");
