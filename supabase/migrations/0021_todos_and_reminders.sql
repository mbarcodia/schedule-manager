-- Two deliberately UNSCHEDULED kinds of thing, kept separate from Work (tasks)
-- because they don't consume hours and must never be placed on the calendar:
--
--   To-do items — named checklists ("This week", "Before the group meeting").
--                 No duration, no deadline maths, just text you tick off.
--   Reminders    — a dated thing you want to be nudged about, with one or more
--                 lead times ("1 week before" AND "1 day before").
--
-- Either can be promoted into real scheduled Work later; that's a normal
-- add_task call, so nothing here needs to know about it.

create table public.todo_lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

alter table public.todo_lists enable row level security;
create policy "own todo_lists" on public.todo_lists
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table public.todo_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  list_id uuid not null references public.todo_lists(id) on delete cascade,
  text text not null,
  done boolean not null default false,
  -- Kept after completion so a list can show what was finished this week.
  completed_at timestamptz,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.todo_items enable row level security;
create policy "own todo_items" on public.todo_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index todo_items_list_idx on public.todo_items (list_id, done, sort_order);

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Free-text grouping shown as a heading, e.g. "Presentations", "Reviews".
  -- Deliberately not the categories table: those colour the calendar, and a
  -- reminder never appears on it.
  heading text,
  title text not null,
  due_at timestamptz not null,
  notes text,
  -- Minutes before due_at to notify. Multiple leads per reminder is the point:
  -- {10080, 1440} is "a week before, and again the day before".
  lead_minutes int[] not null default '{1440}',
  -- Which of those leads have already fired, so the hourly job can't push the
  -- same nudge twice. Compared as values, not indexes, so editing
  -- lead_minutes can't accidentally re-fire an old one.
  sent_leads int[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.reminders enable row level security;
create policy "own reminders" on public.reminders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- The notification sweep scans by due date across all users.
create index reminders_due_idx on public.reminders (due_at);
