-- Let a commitment be finished with, without destroying what was done on it.
--
-- Tasks have had `archived_at` since the board existed, on a stated principle:
-- "nothing is ever hard-deleted when it has logged hours behind it". Commitments
-- never got the same treatment, so the only way to clear a finished project from
-- the board was remove_item — which deletes the row AND its progress_log entries
-- AND cascades its targets. A submitted proposal and a year of logged research
-- hours went together.
--
-- That also made the Archive tab a half-truth: it answers "what did I get done
-- this semester?" from tasks alone, while the weekly-hours work that makes up
-- most of a research week could only ever be deleted.
--
-- Same shape as tasks.archived_at — a nullable timestamp rather than a boolean,
-- so the date it was put away is part of the record.
alter table public.projects
  add column archived_at timestamptz;

create index projects_archived_idx on public.projects (user_id, archived_at);

comment on column public.projects.archived_at is
  'When this commitment was put away. Non-null = excluded from scheduling, pace and the '
  'boards, but its progress_log rows, targets and effort estimate are all kept, and '
  'restoring it brings them back.';
