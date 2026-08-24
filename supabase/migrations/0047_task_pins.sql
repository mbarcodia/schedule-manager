-- A task may be fixed to SEVERAL exact slots, not just one.
--
-- `tasks.pinned_date/pinned_start_min/pinned_length_min` (migration 0005) held
-- exactly one slot per task, which quietly capped what could be asked for. A
-- real case: an 8-hour review that had to happen as four 2-hour blocks inside a
-- four-day window, above the research hours defending that week. The only way
-- to hold those hours was to pin them — and only the first one could be pinned,
-- so the planner offered four pins, wrote one, and the remaining six hours drifted
-- past the deadline with nothing saying so.
--
-- Several slots per day are allowed on purpose (one task can take a morning and
-- an afternoon of the same day); the key is the slot itself, so re-pinning the
-- same start replaces it, exactly as re-pinning a research slot does.
--
-- Deliberately NOT trashable: a pin is a scheduling instruction, not something
-- the user typed and might want back. Removing one means the work floats again,
-- which is visible on the calendar the moment it happens. Same treatment as
-- research_pins.
create table public.task_pins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  pinned_date date not null,
  start_min int not null,
  length_min int not null,
  created_at timestamptz not null default now(),
  unique (user_id, task_id, pinned_date, start_min)
);

alter table public.task_pins enable row level security;
create policy "own task_pins" on public.task_pins
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Every existing pin becomes a row here before the columns go.
insert into public.task_pins (user_id, task_id, pinned_date, start_min, length_min)
select t.user_id, t.id, t.pinned_date, t.pinned_start_min, t.pinned_length_min
from public.tasks t
where t.pinned_date is not null
  and t.pinned_start_min is not null
  and t.pinned_length_min is not null
on conflict do nothing;

-- data-loss: none. Every pinned slot is copied into task_pins by the insert
-- directly above, and task_pins is now the only thing the engine reads. The
-- three columns are dropped rather than left in place because a second, unread
-- source of the same fact is how a pin comes back from the dead later.
alter table public.tasks
  drop column pinned_date,
  drop column pinned_start_min,
  drop column pinned_length_min;
