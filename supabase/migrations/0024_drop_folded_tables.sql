-- Cleanup after 0023 folded proposals and goals into commitments.
--
-- 0023 deliberately left these tables and columns in place: it ran against a
-- deployment whose code still read them, and dropping them in the same step
-- would have broken the running app in the window between migrating and
-- deploying. That deploy has happened, so the remains can go.
--
-- Three columns hold the only references (tasks.proposal_id from 0001,
-- notes.proposal_id from 0010, notes.goal_id from 0012), so the tables are
-- dropped without CASCADE — if anything unexpected still depends on them, this
-- should fail loudly rather than quietly destroy it.

-- Refuse to drop anything if a link survived unmigrated. 0023's backfill moved
-- every proposal/goal link onto project_id, and deleting the old rows blanked
-- these columns via on-delete-set-null — so a non-null value here with no
-- project_id would mean a link that was about to be lost, which is worth
-- failing the migration over.
do $$
declare
  stranded int;
begin
  select count(*) into stranded from public.tasks where proposal_id is not null and project_id is null;
  if stranded > 0 then
    raise exception 'aborting: % task(s) still link only to a proposal', stranded;
  end if;

  select count(*) into stranded
    from public.notes
    where (proposal_id is not null or goal_id is not null) and project_id is null;
  if stranded > 0 then
    raise exception 'aborting: % note(s) still link only to a proposal or goal', stranded;
  end if;
end $$;

alter table public.tasks drop column proposal_id;
alter table public.notes drop column proposal_id;
alter table public.notes drop column goal_id;

drop table public.proposals;
drop table public.goals;
