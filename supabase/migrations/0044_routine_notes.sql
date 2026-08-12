-- A note attached to a routine, for a stretch of time.
--
-- Routines are the only standing thing in this app you could not say anything
-- about. A routine held a title, its days, its length and its placement — four
-- facts about WHEN it happens and nothing at all about what to do in it. So
-- "next week, in my proposal search, look for foundation MHW grants" had nowhere
-- to go. The workarounds available were both wrong in the same way: a standing
-- rule (preference_notes) is permanent and applies to the scheduler, and a note
-- (notes) links to a project or a task and is undated, so both would keep saying
-- the thing forever, long after the week it was about.
--
-- WHAT THIS IS FOR is the recurring session that is the same slot every week and
-- a different job each time. A weekly proposal search, a standing supervision
-- meeting, a lab meeting with an agenda. The slot is stable; what you intend to
-- do inside it is not, and until now only the stable half could be written down.
--
-- A WINDOW, NOT A DATE. `starts_on`/`ends_on` rather than one `for_date`,
-- because the thing people actually say is "next week" — a routine that runs
-- Monday and Wednesday has two occurrences in that week and the note is about
-- both, so pinning it to one date would be a guess about which. A window also
-- makes the narrow cases fall out for free instead of needing their own columns:
-- a single day is starts_on = ends_on, and "for the rest of the semester" is a
-- long window. The alternative considered was a `for_week` date plus a scope
-- enum, which is the same information with more ways to be inconsistent.
--
-- IT GOES QUIET ON ITS OWN. Past `ends_on` the note stops being surfaced — it is
-- not fed to the chat, and the panel folds it away under a count. This is the
-- one place in the app where something the user typed stops being shown without
-- them acting, and it is deliberate: a reminder for last week is noise, and the
-- whole value of the feature is that you can write "next week" and then forget
-- you did. Expiring is NOT deleting. The row stays exactly where it was,
-- `deleted_at` untouched, readable in the panel's history — nothing is destroyed
-- and nothing is purged on a timer, so the promise migration 0043 makes still
-- holds. What changes is only whether it speaks up.
--
-- WHY IT IS TRASHABLE ANYWAY. Expiry is not the only way a note goes away: the
-- chat can remove one by name, and it finds it by fuzzy title match. 0043 has
-- the argument in full — a scored match over a 0.35 threshold is right for "log
-- 45 minutes on grading" and wrong for a permanent delete, because "drop the
-- note about grants" can resolve to a row nobody named. So deleting one stamps
-- `deleted_at` and it lands in Trash like everything else.
--
-- data-loss: none on apply — this migration only adds. But note the cascade it
-- creates: `routine_id` is `on delete cascade`, and removing a routine is still
-- a hard DELETE (recurring_rules has no deleted_at), so removing a routine
-- destroys its notes outright rather than trashing them. That is a real hole and
-- it is left open knowingly: closing it means giving recurring_rules its own
-- deleted_at and sweeping every query of it, which is a bigger change than this
-- one. Both delete paths (update_recurring's remove, and the Settings row's
-- trash button) now COUNT the notes first and say how many go with it, so the
-- loss is stated before it happens instead of discovered afterwards.

create table public.routine_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  routine_id uuid not null references public.recurring_rules(id) on delete cascade,
  body text not null,
  -- Civil dates, not timestamps. A note is about a day's session, and the app
  -- has been bitten before by storing a moment for something the user said as a
  -- date (see 0032) — the invented hour then drives behaviour nobody asked for.
  starts_on date not null,
  ends_on date not null,
  -- Ticked off on purpose, as distinct from simply having expired. Lets "I did
  -- that" and "that week is over" be told apart in the panel.
  done_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- A backwards window would silently never match any day, which reads exactly
  -- like the note having been lost.
  constraint routine_notes_window_ordered check (ends_on >= starts_on)
);

alter table public.routine_notes enable row level security;
create policy "own routine_notes" on public.routine_notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The read the chat does every turn: this user's live notes whose window has not
-- closed, cheapest when the index already excludes the trashed ones.
create index routine_notes_live_idx on public.routine_notes (user_id, ends_on)
  where deleted_at is null;
-- The panel's read, one routine at a time.
create index routine_notes_routine_idx on public.routine_notes (routine_id, starts_on)
  where deleted_at is null;
create index routine_notes_trash_idx on public.routine_notes (user_id, deleted_at desc)
  where deleted_at is not null;

comment on table public.routine_notes is
  'What to do in a specific run of a routine, for a stretch of dates. Surfaced to '
  'the chat only while today falls inside [starts_on, ends_on]; afterwards the row '
  'is kept but goes quiet.';
comment on column public.routine_notes.ends_on is
  'Last day the note is surfaced. Expiring is not deleting: the row survives with '
  'deleted_at null and stays visible in the routine''s history.';
comment on column public.routine_notes.deleted_at is
  'In Trash. Set only by an explicit delete — never by expiry, and never on a timer.';
