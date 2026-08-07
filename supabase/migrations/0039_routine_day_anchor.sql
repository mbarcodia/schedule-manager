-- A routine can be anchored to the START or the END of the day, rather than to
-- a clock time.
--
-- The rule this comes from was written as "never start scheduled work before
-- 9:15am, always after the 9-9:15 Emails block" — which sounds like a fact about
-- 9:15 and isn't. It is "the first fifteen minutes of my day are email". Stored
-- as a fixed 9:00-9:15 window, moving the day's standard hours to 8:30 leaves the
-- ritual stranded at 9:00 with half an hour of work in front of it, and the rule
-- silently stops being true.
--
-- An anchored routine has no clock time at all: it takes the day's opening (or
-- its close) whatever that day's hours turn out to be, including a day shortened
-- by an override. Work is placed after routines, so "nothing before the emails
-- block" holds by construction rather than by a number somebody has to remember
-- to change in two places.
--
-- DRIFT. A meeting can already be sitting on the day's opening. The instance
-- then slides to the first free slot, but only within the first half of that
-- day's window (the mirror for day_end: the last half) — after which it is
-- skipped for the day, exactly as a routine whose fixed window is full already
-- is. Half the window rather than literally noon, because "morning" is only the
-- first half of a day that happens to run 9-5; a day that starts at 1pm has a
-- first half too, and hardcoding 12:00 would make every instance on such a day
-- either impossible or unbounded.
--
-- The two placements stay mutually exclusive with a window: an anchored routine
-- that also carried win_start_min would be two answers to one question, and the
-- constraint makes it impossible to write rather than a rule the app has to
-- remember to apply.

alter table public.recurring_rules
  add column anchor text check (anchor in ('day_start', 'day_end'));

alter table public.recurring_rules
  add constraint recurring_rules_anchor_excludes_window
    check (anchor is null or (win_start_min is null and win_end_min is null));

comment on column public.recurring_rules.anchor is
  '''day_start'' = the first thing in the working day, ''day_end'' = the last, whatever '
  'that day''s hours are. Null = placed by win_start_min/win_end_min as before. An '
  'anchored instance may slide within its half of the day when the opening is taken, '
  'and is skipped for that day if it cannot.';
