-- One To-Do tab, and a separate Lists tab.
--
-- To-dos and reminders were two board views over two tables, but they describe
-- one thing from two angles: something you have to do, which may have a date
-- you want warning about. Splitting them meant "present at the seminar" lived
-- in one tab and "remind me a week before the seminar" in another, with no way
-- to say they were the same seminar — and no way at all to book preparation
-- time for it.
--
-- Reminders now hang off a to-do item, and a to-do item can additionally carry
-- real scheduled hours. The reminders table stays behind (empty) until the code
-- that reads it is deployed; a follow-up migration drops it.

-- How often unfinished items in a list should be chased. Null = never, which
-- stays the default. Deliberately a per-list setting rather than magic list
-- names: a list called "This Week" that silently changes behaviour when renamed
-- is a trap.
alter table public.todo_lists
  add column chase text check (chase in ('week', 'month', 'year')),
  -- When the chase last fired, so one period can only nag once however often
  -- the hourly job runs.
  add column last_chased_at timestamptz,
  -- Completed items strike through and grey out rather than vanishing; this
  -- hides them entirely, per list rather than for the whole tab.
  add column show_completed boolean not null default true;

alter table public.todo_items
  -- When the thing itself happens or is due. Optional: plenty of to-dos have
  -- no date at all, and that must stay the easy case.
  add column due_at timestamptz,
  -- Minutes before due_at to push a notification. Empty = no reminders. Same
  -- convention as the reminders table it replaces: tracked by VALUE in
  -- sent_leads so editing the leads can't re-fire an old one.
  add column lead_minutes int[] not null default '{}',
  add column sent_leads int[] not null default '{}',
  add column notes text,
  -- Hidden by the per-item eye, independent of done/not-done.
  add column hidden boolean not null default false,
  -- Scheduled hours for the item itself, and separately for preparing for it.
  -- Prep is its own row because it has its own duration and its own window:
  -- "two hours of prep, done by 1pm on the day" is not the same request as
  -- "the thing is at 3pm".
  add column task_id uuid references public.tasks(id) on delete set null,
  add column prep_task_id uuid references public.tasks(id) on delete set null,
  -- A fixed-time slot on the calendar, for an item that happens at a moment
  -- rather than taking a number of hours.
  add column event_id uuid references public.events(id) on delete set null;

create index todo_items_due_idx on public.todo_items (user_id, due_at)
  where due_at is not null;

-- Move the existing reminders across: one list per heading, one item each.
insert into public.todo_lists (user_id, name, sort_order)
select distinct r.user_id, coalesce(nullif(r.heading, ''), 'Reminders'), 100
from public.reminders r
on conflict (user_id, name) do nothing;

insert into public.todo_items (user_id, list_id, text, due_at, lead_minutes, sent_leads, notes, sort_order)
select
  r.user_id,
  l.id,
  r.title,
  r.due_at,
  r.lead_minutes,
  r.sent_leads,
  r.notes,
  0
from public.reminders r
join public.todo_lists l
  on l.user_id = r.user_id
 and l.name = coalesce(nullif(r.heading, ''), 'Reminders');

delete from public.reminders;

-- Lists: things you're keeping track of rather than things you'll do. A list
-- holds a paragraph, a checklist, or both — a reading list, a packing list, the
-- standing agenda for a recurring meeting. Nothing here is ever scheduled or
-- notified, which is exactly what separates it from the To-Do tab.
create table public.lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  body text not null default '',
  show_completed boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.lists enable row level security;
create policy "own lists" on public.lists
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table public.list_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  list_id uuid not null references public.lists(id) on delete cascade,
  text text not null,
  done boolean not null default false,
  completed_at timestamptz,
  hidden boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.list_items enable row level security;
create policy "own list_items" on public.list_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index list_items_list_idx on public.list_items (list_id, sort_order);
