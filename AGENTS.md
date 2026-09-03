<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Nothing the user typed is ever destroyed

This app is somebody's primary record of what they have to do. Losing a row is
not a bug you can apologise for afterwards — it is the failure the whole thing
is judged on. Two rules, both enforced by `npm run check`
(`scripts/sanity-check-deletes.mjs`), which is the fastest way to find out you
have broken one:

**1. Never `.delete()` a trashable table.** `notes`, `todo_items`, `todo_lists`,
`lists`, `list_items`, `targets`, `events` are soft-deleted. Removing one means
`softDelete()` from `@/lib/db/soft-delete`; the Trash view is how it comes back.
Deleting a parent must stamp its children with the *same* timestamp — that
grouping is what makes restore reverse one action exactly. The foreign keys still
say `on delete cascade` and that clause is now dead: nothing hard-deletes, so
nothing cascades, so children have to be handled in code.

**2. Never read one without `.is("deleted_at", null)`.** A forgotten filter shows
trashed rows as live. In the chat's per-turn context that is worse than a display
bug: deleted notes get fed back to the model as current fact, and they bill you
for it on every turn.

Tasks and projects are the exception — they use `archived_at` and always have.
Archived means *finished*, and its logged hours still count; deleted means *should
not exist*. Don't collapse the two.

Adding a state column to any table means sweeping **every** query of it in the
same change. This has bitten repeatedly (eight bugs in one August 2025 audit, one
of them live data loss). Grep the table name; don't trust a mental model of where
it's read.

Apply migrations with **`npm run migrate`**, never a bare `supabase db push` — it
chains a full backup first and refuses to push if the snapshot fails, and it
routes through `scripts/db-push.mjs`, which supplies `SUPABASE_ACCESS_TOKEN`
from `.env.local` so the CLI never reaches for the macOS Keychain. That reach is
a GUI prompt: from a non-interactive shell there is nobody to answer it, so the
push hangs silently and forever. It has stalled this project three times and
caused one outage, because code that read a new column shipped while the hung
push had never landed.

A push hangs for a second reason with the identical symptom: a network that
filters Postgres ports. Campus and corporate networks do — 5432 and 6543 have
their packets *dropped* rather than refused, so there is no error to report and
the CLI waits in connect() forever, while 443 to the same host opens instantly.
`scripts/preflight-db-port.mjs` probes for this before the CLI starts, in about
six seconds (`MIGRATE_SKIP_PREFLIGHT=1` overrides it).

It does not stop there: `scripts/migrate-over-https.mjs` then applies the pending
migrations through Supabase's Management API, which runs SQL over 443 using the
same `SUPABASE_ACCESS_TOKEN`. Each file goes in one request, so Postgres runs it
in a single implicit transaction, and the history row is written in that same
request — a migration cannot apply without being recorded, which is the drift
that made 0048 need repairing by hand. Files containing statements Postgres will
not run in a transaction (`create index concurrently`, `vacuum`) are refused
rather than half-applied, and go through the dashboard instead.
`MIGRATE_NO_HTTPS=1` turns the fallback off; the CLI is still the normal path
whenever the ports are open.

Write every migration so re-running it is harmless (`add column if not exists`),
and `scripts/sanity-check-migration-rerunnable.mjs` will hold you to it from 0048
on — 0001–0047 are grandfathered because their history rows are recorded and
verified, so they can never replay. A file that truly cannot be written that way
declares it with a `-- rerunnable:` line, in the same spirit as `-- data-loss:`.
This matters because a migration applied by hand leaves no history row and gets
replayed later.

Both hangs cost the same thing, which is why they get the same treatment: not
knowing whether the schema change landed. So the preflight only ever blocks on a
verdict that *predicts* a hang — a dropped packet. A refused connection or a bad
hostname goes straight through, because the CLI reports those in a second and a
migration refused for no reason is its own kind of damage. Verdicts do not
average out either: one dropped endpoint is enough, and the first version of that
rule counted a DNS miss on the IPv6-only direct host as reassurance about the
pooler, allowed the push, and hung for eleven minutes.
`scripts/sanity-check-migrate-preflight.mjs` holds that case.

Once the migration is applied, deploy in this order, or the live app breaks
rather than degrades: **migrate → `git push`
(Vercel) → `flyctl deploy --now` (the relay)**. Code that reads a new column 400s
on every request until the column exists.

Destructive migrations need a `-- data-loss:` line saying what happens to the
data. Say the true thing — `0003_weekly_hours.sql` really did reset people's
custom hours, and the check records that rather than hiding it.

# No time is ever read in the server's timezone

This app's whole job is being right about when things happen, and it runs in
three places at once — a browser in Miami, Vercel in UTC, a Fly relay in
whatever region it landed in. Any code that resolves a time using the *process's*
own timezone gives a different answer in each, and the one place it looks
correct is the laptop it was written on. That is what makes this class of bug
survive review: it is invisible from the only vantage point anyone uses.

It has now happened five times. Two are recorded in the comments that survived
them (all-day boundaries anchored to the process's midnight; `localDateKey`
called on the server). The other three were live simultaneously in September
2026, all in ICS parsing — TZID resolution, recurrence expansion, and reading
back a date-only value — and every Outlook meeting sat four hours early for
weeks while the public booking link offered those hours to strangers.
`scripts/sanity-check-ics-timezones.mjs` tells that story in full.

**The rule: a wall-clock time is meaningless until you say whose clock.** Every
conversion needs an explicit IANA zone, and the only two legitimate sources are
the data itself (a feed's TZID or VTIMEZONE) and `profiles.timezone`. Never
`moment.tz.guess()`, never a bare `new Date(y, m, d)` or `new Date(y, m, d, h)`,
never `getHours()`/`getFullYear()` on a value that came off the wire, never
`toISOString().slice(0, 10)` for a civil-date column. `src/lib/scheduling/time.ts`
has the helpers and spells out which to reach for where; `localDateKey` is right
in the browser and wrong on the server, and it looks right in both.

Two things do not count as being careful:

- **A library handling it.** node-ical answers a TZID it cannot map with the
  process's zone, under a comment admitting it cannot tell. rrule.js hands back
  occurrences offset by the process's zone. Both were "using a well-tested
  library" right up until they weren't. Read what it does with a zone it does
  not recognise.
- **A passing test.** These pass anywhere the accidental fallback happens to be
  correct. A timezone test that does not run the same input under several
  process timezones is not testing the thing that breaks — see the `PROBE_TZS`
  pattern, which re-executes itself under five.

`assertZonesArePinned` in `src/lib/calendar-sync/tzid.ts` is the shape to copy
when a new feed or import path appears: prove the input can only be read one
way, and throw if it cannot. A sync that fails is visible on the connection and
fixable in a minute. Wrong times are silent, and they reach the booking link,
where being wrong costs somebody else their afternoon.
