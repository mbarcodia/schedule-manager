-- Two corrections to what a label's "% of week" actually means.
--
-- 1. WHAT THE PERCENTAGE IS A SHARE OF.
--
-- The engine took it as a share of the week's hours MINUS meetings, so a
-- meeting-heavy week quietly lowered the goal until it always fit. The stated
-- meaning was the other one: "40% of the total work hours that week, including
-- meetings and standing routines — if my week is 40 hours, research should be
-- 16; if I block off a day, the week is 32 and it should be 40% of that."
--
-- The difference is not academic. Next week: a 40h window with 3h of meetings
-- gave a 14.8h target instead of 16h. Under the old reading, a week with 30h of
-- meetings would ask for 4h of research and call it a success; under the new one
-- it asks for 16h, fails, and says so — which is the thing worth knowing about
-- such a week.
--
-- Per label rather than global, because both readings are legitimate: a share of
-- what's left is the right question for work that only happens between meetings.
-- 'week' is the default because it is the plain reading of "% of week", and
-- because the existing target was set with that meaning in mind.
--
-- 2. ROUTINES CAN CARRY A LABEL.
--
-- A weekly literature scan and a proposal search are research; a standing email
-- slot is not. They were all just "Routine", counting toward no share at all, so
-- "research (projects, proposals and literature reading combined) should get 40%"
-- could not be measured as stated. Optional, and null for most of them — the
-- point is that the user decides which routines are the work.
--
-- A labelled routine's minutes count toward its label's share and REDUCE what the
-- commitments wearing that label are asked for, so the combined total lands on
-- the percentage instead of overshooting it.

alter table public.categories
  add column target_basis text not null default 'week'
    check (target_basis in ('week', 'after_meetings'));

alter table public.recurring_rules
  -- on delete set null, not cascade: deleting a label must not delete the
  -- standing slots wearing it. They lose their label and keep their time.
  add column category_id uuid references public.categories(id) on delete set null;

comment on column public.categories.target_basis is
  '''week'' = weekly_target_pct is a share of the week''s whole working window (days off '
  'and away days excluded, meetings NOT). ''after_meetings'' = a share of what is left once '
  'meetings are taken out, which shrinks the goal in a heavy week so it still fits.';

comment on column public.recurring_rules.category_id is
  'Optional label. A labelled routine counts toward that label''s weekly share and reduces '
  'what its commitments are asked for; null means the routine belongs to no share.';
