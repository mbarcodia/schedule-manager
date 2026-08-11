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

Destructive migrations need a `-- data-loss:` line saying what happens to the
data. Say the true thing — `0003_weekly_hours.sql` really did reset people's
custom hours, and the check records that rather than hiding it.
