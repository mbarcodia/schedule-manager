-- Give a commitment something to measure progress against.
--
-- A commitment had a RATE (weekly hours) and optionally a DATE, and nothing
-- else. No notion of how much total work it is, how far through it you are, or
-- whether it matters. Three consequences, all of which read as the app being
-- broken rather than under-specified:
--
--   The "on track" chip was hollow. trackables.ts computed what a commitment
--   still needs as the sum of the TASKS linked to it, so a commitment with no
--   linked tasks needed 0 minutes and could never be at risk. Every such
--   commitment reported "On track · N days left" unconditionally, and the
--   timeline bar took its colour from the same sum.
--
--   Commitments could not appear on the Progress or Priorities boards at all.
--   Both sort by status, and a commitment had no status to sort by — which is
--   why those tabs showed only the handful of loose tasks.
--
--   "Am I keeping up?" was unanswerable. Weekly hours say how fast you are
--   going, never how far there is to go.
--
-- Goal-setting research is consistent on the missing half here: a specific,
-- demanding goal only outperforms a vague one when progress against it is
-- visible. So: an effort estimate makes remaining work known, logged hours make
-- the estimate self-correcting, and dated targets make progress legible.

alter table public.projects
  -- Total expected effort. Null = not estimated, and pace is reported as
  -- unmeasurable rather than guessed at; the estimate is meant to be revised as
  -- logged hours reveal how wrong it was.
  add column effort_estimate_min int check (effort_estimate_min is null or effort_estimate_min > 0),
  -- The importance half of importance-vs-urgency, matching tasks.important.
  -- Without it the Priorities board can only ever place a commitment in the
  -- not-important row.
  add column important boolean not null default false,
  -- Whether this date is externally imposed or self-set. Both are scheduled
  -- toward identically; what differs is the consequence of missing one — a hard
  -- date that won't be met is a failure to resolve now, a goal date that won't
  -- be met is a choice between moving it and going faster.
  --
  -- Existing dates default to 'hard': treating a date already on the board as
  -- immovable until told otherwise is the safe direction, since the reverse
  -- would silently soften a real submission deadline.
  add column deadline_kind text not null default 'hard'
    check (deadline_kind in ('hard', 'goal'));

alter table public.targets
  -- Same distinction for the interim dates inside a commitment. These default
  -- the other way: a target is an interim checkpoint by definition (see
  -- migration 0023), so 'goal' is what one already means.
  add column date_kind text not null default 'goal'
    check (date_kind in ('hard', 'goal'));

comment on column public.projects.effort_estimate_min is
  'Total expected effort in minutes. Null = unestimated, so pace cannot be computed. '
  'Compare against hours logged to correct the estimate rather than to judge the person.';
