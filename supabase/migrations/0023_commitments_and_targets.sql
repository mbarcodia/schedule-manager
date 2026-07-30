-- Commitments: one thing with optional facets, replacing three thin types.
--
-- Projects, proposals and goals were three tables describing one idea: something
-- ongoing you've signed up for. They differed only in which fields they had —
-- a project could carry weekly hours, a proposal only a deadline, a goal only a
-- cadence — which forced the user to pick a type before describing the thing,
-- and left no way to say "this has weekly hours AND a hard deadline".
--
-- Everything folds into public.projects (kept under its original name so that
-- every existing foreign key, index and policy keeps working; the user-facing
-- word is "commitment"). Behaviour is now driven by which facets are filled in,
-- not by which table a row lived in:
--
--   weekly_min_min set  -> the engine generates and defends weekly hours
--   deadline_date set   -> tracked toward a date, shown on the timeline
--   cadence set         -> ongoing, no date, shown in the timeline's own lane
--
-- Two genuine capability gaps close here as well:
--
--   active_from/active_until — weekly hours previously applied to every week in
--     the horizon, so "5 hours a week starting in December" was impossible to
--     say; the hours would be booked from today.
--   time_of_day — the engine hardcoded a morning preference for every
--     weekly-hours block (it keyed off the internal "research" tag), so a
--     commitment whose hours belong in the afternoon could not be expressed.

alter table public.projects
  -- Folded in from goals: an ongoing aim with a rhythm rather than a date.
  add column cadence text,
  -- Window in which weekly hours apply. Null = no bound on that side, i.e.
  -- today's behaviour of applying across the whole horizon.
  add column active_from date,
  add column active_until date,
  -- Where this commitment's weekly hours belong. Null = no constraint beyond
  -- prefer_morning's softer nudge.
  add column time_of_day text check (time_of_day in ('morning', 'afternoon')),
  add constraint projects_active_window_ordered
    check (active_from is null or active_until is null or active_from <= active_until);

-- Preserve exactly today's placement behaviour. Until now the engine forced a
-- morning preference on every weekly-hours block regardless of this column, so
-- rows that already have hours must be marked as preferring mornings or they
-- would quietly start being placed in the afternoon.
update public.projects set prefer_morning = true where weekly_min_min is not null;

-- Fold proposals in, KEEPING THEIR IDS so tasks.proposal_id and notes.*_id
-- still point at a row that exists — the backfills below then move those links
-- onto project_id before the old rows go away.
insert into public.projects (id, user_id, title, deadline_date, created_at)
select id, user_id, title, deadline_date, created_at from public.proposals;

update public.tasks set project_id = proposal_id
  where proposal_id is not null and project_id is null;
update public.notes set project_id = proposal_id
  where proposal_id is not null and project_id is null;

-- Goals carry a cadence and nothing else.
insert into public.projects (id, user_id, title, cadence, created_at)
select id, user_id, title, cadence, created_at from public.goals;

update public.notes set project_id = goal_id
  where goal_id is not null and project_id is null;

-- The rows are now duplicated into projects and every link has been moved, so
-- the originals go. The tables themselves stay until the code that still reads
-- them is deployed; dropping them here would break the running app. Their
-- on-delete-set-null foreign keys blank the now-redundant proposal_id/goal_id
-- columns as a side effect, which is what we want.
delete from public.proposals;
delete from public.goals;

-- Targets: a date you're steering toward that consumes no calendar time.
--
-- "First round of analysis done by the end of August" is not work with hours —
-- it's a checkpoint inside a commitment. Without this it has to be faked as a
-- task with an invented duration, which then competes for real hours it doesn't
-- need. Targets never reach the scheduling engine at all.
create table public.targets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  commitment_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  target_date date not null,
  -- Kept rather than deleted on completion, so a commitment's history reads as
  -- a sequence of dates hit or missed.
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.targets enable row level security;
create policy "own targets" on public.targets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index targets_commitment_idx on public.targets (commitment_id, target_date);
