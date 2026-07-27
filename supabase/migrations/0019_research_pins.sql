-- Pinning research time to an exact slot.
--
-- Research blocks aren't task rows: the engine synthesizes one weekly chunk
-- per research project (`research-<projectId>-w<N>` in engine.ts taskDefs),
-- so update_task's pin couldn't touch them. Without this, "I'm working on
-- ACE2-S2S right now for an hour" had to be faked with add_event, which
-- produced a generic meeting instead of a Research block — wrong category
-- colour, no done-checkbox, and no credit toward the project's weekly hours.
--
-- One pin per project per day: re-pinning the same project on the same date
-- replaces it (the natural reading of "actually, I'm doing it at 3 instead").
-- The pinned minutes are subtracted from that week's auto-placed research
-- chunk (pinReduction in engine.ts), so weekly totals stay honest and
-- whatever occupied the slot reflows automatically.
create table public.research_pins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  pinned_date date not null,
  start_min int not null,
  length_min int not null,
  created_at timestamptz not null default now(),
  unique (user_id, project_id, pinned_date)
);

alter table public.research_pins enable row level security;
create policy "own research_pins" on public.research_pins
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
