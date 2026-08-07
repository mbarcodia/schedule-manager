-- A commitment can be ON HOLD: recorded, visible, and scheduling nothing.
--
-- The app knew two states and needed three. ACTIVE means the engine finds and
-- defends time for it. ARCHIVED means it is over — it comes off the boards
-- entirely, which is right for finished work and wrong for work you are keeping
-- in front of you on purpose. There was nothing for "yes, this is real, and I am
-- not doing it this month".
--
-- The workaround people reach for is clearing the weekly hours, and that is
-- exactly what makes it a bad workaround: the hours are a decision — how much of
-- a normal week this deserves — and deleting them to pause a project means
-- re-deriving that decision to restart it. So on_hold_at suppresses the hours
-- WITHOUT touching them. Coming off hold is one click and the project resumes at
-- the rate it was already going.
--
-- Two consequences, both deliberate:
--
-- NOTHING is scheduled for it — not its weekly hours and not its tasks. "On hold"
-- that still booked the tasks underneath would be a distinction without a
-- difference. Its logged hours, estimate, dates and targets all survive
-- untouched, as they do for an archived commitment.
--
-- IT DOES NOT CLAIM A SHARE. A label's weekly percentage is divided between the
-- commitments wearing it; one that is on hold takes no part of that, so the rest
-- get their full ratio rather than quietly funding a paused project.
--
-- Its DATES still exist and still approach, which is the whole risk of a hold:
-- forgetting to come off it in time. Pace reports an on-hold commitment silently
-- until the work left would no longer fit before its date at the rate it was set
-- to run at — and then says so. See pace.ts.

alter table public.projects
  add column on_hold_at timestamptz;

comment on column public.projects.on_hold_at is
  'When set, the engine schedules nothing for this commitment (neither its weekly hours '
  'nor its tasks) and it claims no part of its label''s weekly share — but weekly_min_min '
  'and every other field are preserved, so resuming restores the rate it was already at. '
  'Distinct from archived_at, which means finished and removes it from the boards.';
