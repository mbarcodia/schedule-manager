-- One day's worth of a label's time, given to a single project.
--
-- "I want my research blocks tomorrow to all be ACE2-S2S." There was no way to
-- say that. The nearest tool was pin_research, which pins ONE block per project
-- per day and cannot stop the other projects taking the rest of the day — so the
-- request was carried out halfway: one afternoon block pinned, another project
-- left holding the morning, and a reflow that pushed three dated items past their
-- deadlines. The engine and the persona have been fixed for the two of those that
-- were bugs; this table is the missing capability.
--
-- WHAT IT MEANS, precisely, in the words that produced it: "I had 3 research
-- segments for tomorrow for different projects and I just wanted them to all be
-- for the same project, and then those hours to get logged toward that project,
-- and the hours for the other ones would not get logged and need to be scheduled
-- elsewhere in the future to make sure I reach my goals."
--
-- So the same slots, a different owner, and — the part that constrains the whole
-- design — THE DISPLACED HOURS ARE STILL OWED. They are not written off. They
-- move to other days in the same week, and if the week has no room for them they
-- are reported short so the shortfall is a thing the user is told rather than a
-- number that quietly changed.
--
-- IT IS A PREFERENCE, NOT A LOCK. The user's governing rule for this app: "these
-- shouldn't be hard rules unless specified." So a focus is expressed as ORDERING,
-- not as forbidding: the focused project gets first claim on every one of that
-- day's slots for its label, and a slot it genuinely cannot use — its minimum
-- chunk won't fit, or it has no work left against its estimate — goes to the next
-- project rather than sitting empty. That is deliberate. It also means the
-- implementation needed no new placement machinery at all, only a better claim in
-- a queue that already existed (see lib/scheduling/day-focus.ts).
--
-- PER LABEL, NOT PER DAY, which is why category_id is part of the key. A Thursday
-- can send Research to one project and Teaching to another; those are unrelated
-- decisions about unrelated pools of time, and one row per day would have made
-- them fight over the same slot for no reason. The label is stored rather than
-- derived from the project because it IS the scope — it is what `unique` needs in
-- order to allow the two of them on one date. A project whose own label disagrees
-- with category_id is refused at the point of writing, since there is no sensible
-- reading of "all of Research goes to a Teaching project".
--
-- AN EXPLICIT PIN OUTRANKS A FOCUS. Same rule as above, in the other direction: a
-- research_pin is something the user specified for one exact slot, so it stands,
-- and the day is reported as "all X except the block you pinned" rather than
-- having a row silently deleted underneath them.
--
-- NOT TRASHABLE, deliberately. This is a setting about a day, like day_overrides
-- — not content the user authored — so removing one is a real delete and needs no
-- Trash entry. Rows for dates that have passed are simply ignored on read (they
-- fall outside the gday window, exactly as research_pins do), so nothing has to
-- sweep them and no cron touches this table.

create table public.day_focus (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  focus_date date not null,
  -- The pool of time being redirected. Part of the key; see the header.
  category_id uuid not null references public.categories(id) on delete cascade,
  -- Who gets it. Cascades: a deleted project cannot go on owning a day.
  project_id uuid not null references public.projects(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- One focus per label per day. Re-stating the same date and label replaces it,
  -- which is the natural reading of "actually, make Thursday the other project".
  unique (user_id, focus_date, category_id)
);

alter table public.day_focus enable row level security;
create policy "own day_focus" on public.day_focus
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The read the schedule does on every recompute: one user's focuses inside the
-- window being planned.
create index day_focus_user_date_idx on public.day_focus (user_id, focus_date);

comment on table public.day_focus is
  'Gives one day''s worth of one label''s weekly-hours time to a single project. A '
  'preference, not a lock: the project gets first claim on that day and anything it '
  'cannot use falls to the next project. Displaced hours are never written off — '
  'they re-place inside the same week or are reported short.';
comment on column public.day_focus.category_id is
  'The label whose time is redirected. Part of the unique key so Research and '
  'Teaching can be focused independently on the same date. Must match the '
  'project''s own label.';
