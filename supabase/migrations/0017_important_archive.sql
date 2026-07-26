-- Eisenhower "important" flag for tasks. "Urgent" is derived from
-- deadline_at (no column needed — see src/lib/planner/board-constants.ts);
-- "important" has no existing signal to derive from, so it needs one
-- explicit boolean the user (or the planner, via update_task) sets.
--
-- archived_at: tasks are never hard-deleted when finished — the weekly
-- review auto-archives fully-done tasks and the board offers manual
-- archive/restore. Archived tasks (archived_at is not null) are excluded
-- from scheduling and the board, but keep their row and progress_log
-- history forever so long-range summaries ("what did I do this
-- semester?") stay possible.
alter table public.tasks
  add column important boolean not null default false,
  add column archived_at timestamptz;
