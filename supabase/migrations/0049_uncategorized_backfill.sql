-- A label is about to become mandatory on anything that logs hours (0050).
-- Before that constraint can land, every row it would reject needs somewhere
-- to go — otherwise the migration that adds it simply fails to apply.
--
-- The DOE Review task is the case this whole change exists for: it was typed
-- into the calendar with no label, so it never counted as Service hours
-- anywhere the app reports on Service. A NOT NULL constraint stops the next
-- one of those from happening silently, but existing rows still need a value
-- the moment before the constraint is added.
--
-- "Uncategorized" is that value, and it is deliberately not a real answer —
-- it is a per-user label created here ONLY if a row needs it, meant to be
-- emptied out by hand afterward (re-label each row to what it actually is:
-- Service, Research, whatever). It is not seeded for users who have nothing
-- to backfill, and it is not meant to become a permanent catch-all bucket.
--
-- Scope matches 0050 exactly: tasks with no category, and commitments that
-- claim weekly hours (and so generate real logged-hours blocks) with no
-- category. A commitment with no weekly_min_min books nothing itself, so it
-- is not touched here or by 0050.

insert into public.categories (user_id, name, color, sort_order)
select distinct t.user_id, 'Uncategorized', '#9a9a9a', 999
from public.tasks t
where t.category_id is null
  and not exists (
    select 1 from public.categories c
    where c.user_id = t.user_id and c.name = 'Uncategorized'
  )
on conflict (user_id, name) do nothing;

insert into public.categories (user_id, name, color, sort_order)
select distinct p.user_id, 'Uncategorized', '#9a9a9a', 999
from public.projects p
where p.category_id is null
  and p.weekly_min_min is not null
  and not exists (
    select 1 from public.categories c
    where c.user_id = p.user_id and c.name = 'Uncategorized'
  )
on conflict (user_id, name) do nothing;

update public.tasks t
set category_id = c.id
from public.categories c
where t.category_id is null
  and c.user_id = t.user_id
  and c.name = 'Uncategorized';

update public.projects p
set category_id = c.id
from public.categories c
where p.category_id is null
  and p.weekly_min_min is not null
  and c.user_id = p.user_id
  and c.name = 'Uncategorized';

-- data-loss: none. Every row that had no category keeps its data and gains a
-- placeholder label instead of losing anything; nothing is deleted or reset.
