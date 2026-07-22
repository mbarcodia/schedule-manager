-- Planner: per-project/task notes and the planner's own conversation log.
-- The planner (a longer-horizon planning chat, separate from the quick
-- assistant) treats the database as its memory: durable facts go into
-- notes or the trackable tables via tools, so old chat turns can age out
-- of the prompt without losing anything.
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  proposal_id uuid references public.proposals(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null,
  title text not null,
  content text not null default '',
  kind text not null default 'other'
    check (kind in ('idea','todo','paper','update','other')),
  created_at timestamptz not null default now(),
  -- Deliberate deviation from the no-updated_at house convention: notes are
  -- mutable documents the planner edits repeatedly, and recency drives both
  -- the system-prompt notes index and the sidebar ordering. Maintained from
  -- application code on every update (no trigger).
  updated_at timestamptz not null default now()
);

alter table public.notes enable row level security;
create policy "own notes" on public.notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table public.planner_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

alter table public.planner_messages enable row level security;
create policy "own planner_messages" on public.planner_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The planner gets its own model choice, separate from the assistant's
-- preferred_model — planning turns favor a stronger model.
alter table public.profiles
  add column planner_model text not null default 'claude-opus-4-8'
    check (planner_model in ('claude-sonnet-5','claude-opus-4-8','claude-fable-5'));
