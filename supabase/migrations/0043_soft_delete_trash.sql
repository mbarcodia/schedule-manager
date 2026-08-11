-- Nothing you typed is ever destroyed by a single action.
--
-- Two tables already worked this way. `tasks.archived_at` and
-- `projects.archived_at` exist on a stated principle: finishing something must
-- not erase the record of having done it. Everything else in the app was on the
-- opposite footing — one click and the row was gone from Postgres, with no undo,
-- no trash, and no trace. That covered the notes, the to-dos, the lists, the
-- targets and the events: precisely the things this app asks you to trust it
-- with as a primary record.
--
-- Three specific ways that lost data, all of them quiet:
--
-- A CASCADE took children nobody was looking at. `todo_items.list_id` and
-- `list_items.list_id` are `on delete cascade`, so deleting one list destroyed
-- every item on it in the same statement. The confirmation said "and everything
-- on it" without ever saying how many things that was — a list built up over a
-- semester and a list made by mistake five seconds ago read identically.
--
-- A FUZZY MATCH resolved to the wrong row. The chat's remove_item accepts a
-- title, scores candidates, and acts on the best one over a 0.35 threshold. That
-- is the right behaviour for "log 45 minutes on grading" and the wrong behaviour
-- for a permanent delete: "remove the analysis" could destroy a task nobody
-- named.
--
-- AN UPDATE dropped a column. Migrations in this repo have deleted rows and
-- dropped tables (0023, 0024, 0025, 0026, 0031). Those were written carefully and
-- backfilled first, but nothing enforced that, and a schema change is exactly
-- when data goes missing without anyone watching.
--
-- So: `deleted_at`, matching the `archived_at` convention already here — a
-- nullable timestamp rather than a boolean, because when something was removed
-- turns out to matter for restoring it. Every read filters `deleted_at is null`;
-- a Trash view reads the complement.
--
-- ARCHIVED AND DELETED ARE DIFFERENT and both are kept. Archived means finished:
-- it comes off the boards on purpose and its logged hours still count toward
-- "what did I get done this semester?". Deleted means it should not have been
-- there. A finished project is not clutter and does not belong in Trash.
--
-- THE TIMESTAMP IS THE GROUPING KEY. Soft-deleting a list stamps the list and
-- every item on it with the SAME `deleted_at` value. Restoring reverses exactly
-- that set, so an item you deleted individually last week is not silently
-- resurrected by restoring the list today, and an item deleted WITH the list
-- comes back with it. This is why the column is a timestamp and not a boolean,
-- and why the application must stamp children explicitly rather than leaning on
-- the foreign key — the FK cascade only fires on a hard DELETE, which no longer
-- happens.
--
-- NOTHING IN TRASH EXPIRES. There is deliberately no retention window and no
-- scheduled purge. An automatic sweep is silent data loss on a timer, which is
-- the exact failure this migration exists to prevent; emptying Trash is a thing
-- you do on purpose or not at all. Text rows are small enough that keeping them
-- indefinitely costs nothing worth measuring.
--
-- SYNCED CALENDAR EVENTS ARE EXEMPT, and this is the one deliberate hole. Rows
-- with a `connection_id` are mirrors of an external ICS feed: the sync deletes
-- the window it is about to re-fetch and re-inserts it, every hour. Soft-deleting
-- those would fill Trash with thousands of copies of meetings you never deleted,
-- and they are not lost in any case — the feed is the source of truth and the
-- next sync restores them. Only events YOU made in this app (connection_id is
-- null) get a Trash entry. See the partial index below and sync.ts.

alter table public.notes add column deleted_at timestamptz;
alter table public.todo_items add column deleted_at timestamptz;
alter table public.todo_lists add column deleted_at timestamptz;
alter table public.lists add column deleted_at timestamptz;
alter table public.list_items add column deleted_at timestamptz;
alter table public.targets add column deleted_at timestamptz;
alter table public.events add column deleted_at timestamptz;

-- Partial indexes on the live set. Every read in the app is now
-- "... and deleted_at is null", so the index that matters is the one over rows
-- that satisfy it; the Trash view is opened rarely and can afford a scan.
create index notes_live_idx on public.notes (user_id) where deleted_at is null;
create index todo_items_live_idx on public.todo_items (list_id, sort_order) where deleted_at is null;
create index todo_lists_live_idx on public.todo_lists (user_id) where deleted_at is null;
create index lists_live_idx on public.lists (user_id) where deleted_at is null;
create index list_items_live_idx on public.list_items (list_id, sort_order) where deleted_at is null;
create index targets_live_idx on public.targets (commitment_id) where deleted_at is null;
create index events_live_idx on public.events (user_id, starts_at) where deleted_at is null;

-- The Trash view's own query: everything one user deleted, newest first,
-- grouped by the timestamp that ties a parent to the children it took with it.
create index notes_trash_idx on public.notes (user_id, deleted_at desc) where deleted_at is not null;
create index todo_items_trash_idx on public.todo_items (user_id, deleted_at desc) where deleted_at is not null;
create index todo_lists_trash_idx on public.todo_lists (user_id, deleted_at desc) where deleted_at is not null;
create index lists_trash_idx on public.lists (user_id, deleted_at desc) where deleted_at is not null;
create index list_items_trash_idx on public.list_items (user_id, deleted_at desc) where deleted_at is not null;
create index targets_trash_idx on public.targets (user_id, deleted_at desc) where deleted_at is not null;
create index events_trash_idx on public.events (user_id, deleted_at desc) where deleted_at is not null;

comment on column public.notes.deleted_at is
  'When set, the row is in Trash: hidden from every read, restorable, never purged '
  'automatically. Distinct from a finished/archived record, which stays visible.';
comment on column public.todo_items.deleted_at is
  'In Trash. Stamped with its list''s exact timestamp when deleted as part of that '
  'list, so restoring the list restores precisely the items it took with it.';
comment on column public.todo_lists.deleted_at is
  'In Trash. Its items carry the same timestamp — see todo_items.deleted_at.';
comment on column public.lists.deleted_at is
  'In Trash. Its items carry the same timestamp — see list_items.deleted_at.';
comment on column public.list_items.deleted_at is
  'In Trash. Stamped with its list''s exact timestamp when deleted as part of that list.';
comment on column public.targets.deleted_at is
  'In Trash. Stamped with its commitment''s timestamp when the commitment was deleted.';
comment on column public.events.deleted_at is
  'In Trash. Only ever set on events created in this app; rows with a connection_id '
  'are ICS mirrors that the sync hard-deletes and re-inserts each run.';
