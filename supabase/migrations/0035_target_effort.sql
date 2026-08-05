-- Let a target carry hours of its own, so pace stops measuring the whole
-- commitment against its next interim date.
--
-- computePace picks the soonest unmet date and divides ALL remaining effort by
-- the weekly rate. That is right when the date is the commitment's own deadline
-- and wrong for every interim checkpoint: an 80h proposal with a notice-of-
-- intent target two weeks out read as needing 27 weeks of work before a date
-- that wants maybe four hours of it. The chip said "go 38h/wk" about a one-page
-- form. Nothing was mis-entered — the arithmetic was comparing the wrong two
-- numbers.
--
-- plan_phases already ASKS for per-phase hours and already knows them: it walks
-- the placed hours to work out when each phase's cumulative total is reached,
-- and then throws the hours away, keeping only the date. So the number pace
-- needs has been computed and discarded on every call.
--
-- Per-phase, not cumulative, because that is how the hours are given ("run
-- simulations 60h, write up 40h") and how they are revised. Pace sums forward
-- to whatever date it is measuring against.
--
-- Optional on purpose. A target set by hand as a plain checkpoint has no hours,
-- and a commitment whose targets don't all carry them falls back to measuring
-- the full remaining effort — the behaviour before this migration, which is
-- correct in the absence of a split, not a degraded version of it.
alter table public.targets
  add column effort_estimate_min int
    check (effort_estimate_min is null or effort_estimate_min > 0);

comment on column public.targets.effort_estimate_min is
  'Effort expected for THIS phase alone, in minutes — not cumulative. Null = an '
  'undimensioned checkpoint; pace then measures the commitment''s whole remaining '
  'effort against this date instead.';
