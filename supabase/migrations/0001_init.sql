-- Schedule Manager — initial schema.
--
-- Design note on dates: the scheduling engine (src/lib/scheduling/engine.ts)
-- operates on a week-relative grid (gday 0 = Monday of "this week", forward).
-- That grid is recomputed fresh every time the engine runs, so anything
-- persisted must be a real calendar date/time, converted into the current
-- grid's coordinates at read time (see src/lib/scheduling/time.ts
-- gdayForDate). Storing week-relative numbers directly (as the prototype's
-- in-memory state did) would go stale the moment the horizon rolls into a
-- new week — this is the production fix for the timezone/date-handling gap
-- called out in the handoff README.
--
-- Every table is scoped to auth.uid() via Row Level Security, which is what
-- makes each account's data fully isolated from every other account.

create extension if not exists "pgcrypto";

-- One row per account, extending auth.users with app-specific settings.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  preferred_model text not null default 'claude-sonnet-5'
    check (preferred_model in ('claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8')),
  timezone text not null default 'UTC',
  work_start_hour smallint not null default 9,
  work_end_hour smallint not null default 17,
  created_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  deadline_date date,
  weekly_min_min int,           -- weekly research minimum, in minutes; null = not a research project
  prefer_morning boolean not null default false,
  chunk_min int not null default 120,
  research_ord int,             -- priority among research projects claiming mornings; lower = first
  created_at timestamptz not null default now()
);

create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  deadline_date date,
  created_at timestamptz not null default now()
);

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  cadence text not null default 'Ongoing',
  created_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  priority text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  duration_min int not null,
  chunk_min int not null,
  tag text check (tag in ('deep-focus', 'research')),
  depends_on uuid references public.tasks(id) on delete set null,
  deadline_at timestamptz,       -- null = no deadline
  floor_at timestamptz not null default now(), -- earliest this task may start
  max_per_day_min int,           -- pacing cap
  project_id uuid references public.projects(id) on delete set null,
  proposal_id uuid references public.proposals(id) on delete set null,
  ord int not null default 99,   -- explicit order; work_on_next sets this to 0
  created_at timestamptz not null default now()
);

create table public.recurring_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  tag text,
  days smallint[] not null default '{0,1,2,3,4}', -- 0=Mon..4=Fri
  length_min int not null,
  win_start_min int,             -- null on both = wherever it fits
  win_end_min int,
  created_at timestamptz not null default now()
);

create table public.preference_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now()
);

create table public.day_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  override_date date not null,
  start_min int,
  end_min int,
  allow_weekend boolean not null default false, -- explicit weekend opt-in
  created_at timestamptz not null default now(),
  unique (user_id, override_date)
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  source text not null default 'manual' check (source in ('manual', 'google', 'icloud')),
  external_id text,               -- for de-duping synced events in Phase 2
  created_at timestamptz not null default now()
);

-- Per-scheduled-chunk progress. `subject_type`/`subject_id` identify what was
-- scheduled: a real task (subject_type='task', subject_id=tasks.id) or a
-- project's auto-generated weekly research chunk (subject_type='research',
-- subject_id=projects.id). `occurred_date` + `start_min` pin it to the real
-- calendar slot it was scheduled in, so the engine can re-derive the correct
-- week-relative key no matter when it's queried.
create table public.progress_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject_type text not null check (subject_type in ('task', 'research')),
  subject_id uuid not null,
  occurred_date date not null,
  start_min int not null,
  end_min int not null,
  minutes_done int,               -- null = fully done; set = partial credit
  created_at timestamptz not null default now(),
  unique (user_id, subject_type, subject_id, occurred_date, start_min)
);

-- A future chunk checked off early ("done early" pin) — stays in place,
-- time credited immediately rather than waiting for its scheduled time.
create table public.pinned_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject_type text not null check (subject_type in ('task', 'research')),
  subject_id uuid not null,
  tag_label text not null,
  title text not null,
  project_id uuid references public.projects(id) on delete set null,
  priority text check (priority in ('high', 'medium', 'low')),
  occurred_date date not null,
  start_min int not null,
  end_min int not null,
  created_at timestamptz not null default now(),
  unique (user_id, subject_type, subject_id, occurred_date, start_min)
);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

-- ── Row Level Security ──────────────────────────────────────────────────
-- Every table: an account can only see/modify its own rows. This is the
-- mechanism that makes multi-tenant isolation automatic (README requirement:
-- each future colleague gets a fully isolated account).

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.proposals enable row level security;
alter table public.goals enable row level security;
alter table public.tasks enable row level security;
alter table public.recurring_rules enable row level security;
alter table public.preference_notes enable row level security;
alter table public.day_overrides enable row level security;
alter table public.events enable row level security;
alter table public.progress_log enable row level security;
alter table public.pinned_chunks enable row level security;
alter table public.chat_messages enable row level security;

create policy "own profile" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

create policy "own projects" on public.projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own proposals" on public.proposals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own goals" on public.goals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own tasks" on public.tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own recurring_rules" on public.recurring_rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own preference_notes" on public.preference_notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own day_overrides" on public.day_overrides
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own events" on public.events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own progress_log" on public.progress_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own pinned_chunks" on public.pinned_chunks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own chat_messages" on public.chat_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Auto-create a profile row (with default settings) whenever a new account
-- signs up, so preferred_model/timezone/work hours always exist.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
