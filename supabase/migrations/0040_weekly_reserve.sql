-- What a week is REALLY free to hold: two capacity assumptions, so feasibility
-- stops being judged against hours that were never going to be available.
--
-- The rules this comes from were saved as free text and reached only the chat's
-- prompt: "keep 8-10 hours per week unbooked for last-minute meetings and
-- tasks", and "when judging feasibility, reserve ~10-15h/week for meetings and
-- ~5-10h/week for miscellaneous tasks". Nothing measured either one, so a week
-- with 38 of its 40 hours booked read as a week with room in it, and a
-- commitment needing "38h/wk to hit the date" was reported without noticing that
-- no week has ever held 38 hours of that work.
--
-- TWO numbers rather than one, because the two rules are not the same rule.
--
--   expected_meeting_min_per_week is a FORECAST that decays. A week six weeks out
--   has no meetings on it yet and will not stay that way. So the figure counts
--   only what has not yet materialised: max(0, expected - actually booked). Once
--   a week fills up with real meetings it reserves nothing further, which is what
--   keeps this from double-counting the meetings you already have.
--
--   reserve_misc_min_per_week is a FLOOR that always stands: the slack that
--   absorbs the unplanned. It is not spent by anything you can point at, which is
--   exactly why it has to be subtracted rather than discovered missing.
--
-- ADVISORY, DELIBERATELY. The engine does not read these and will still fill a
-- week to the brim; what changes is what the app SAYS about that week. A hard
-- version — refusing to place work once the line is reached — was considered and
-- turned down: it would push work into later weeks silently, and the failure mode
-- of an honest number you can overrule is much better than that of a limit that
-- quietly rearranges your calendar.
--
-- 0 = no assumption, which is the right default for a fresh account: a reserve
-- somebody else picked would make every feasibility answer wrong in a way that is
-- hard to trace back to a number they never set.

alter table public.profiles
  add column expected_meeting_min_per_week int not null default 0
    check (expected_meeting_min_per_week >= 0),
  add column reserve_misc_min_per_week int not null default 0
    check (reserve_misc_min_per_week >= 0);

comment on column public.profiles.expected_meeting_min_per_week is
  'Typical weekly meeting load. Only the part NOT already on the calendar is held back, '
  'so a week that fills with real meetings reserves nothing further. 0 = no assumption.';

comment on column public.profiles.reserve_misc_min_per_week is
  'Working time per week kept unbooked for the unplanned, on top of routines and meetings. '
  'Always subtracted. Advisory: reporting honours it, the scheduler does not. 0 = none.';
