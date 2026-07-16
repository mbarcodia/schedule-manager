-- One-shot "pin this task to an exact time" support. When set, the engine
-- forces that many minutes of the task to sit at this exact date/time (like
-- a mini fixed event scoped to one task), and reduces the task's remaining
-- duration by that amount before auto-placing whatever's left. Other
-- flexible tasks/research chunks that would have landed there are pushed
-- elsewhere automatically, same as they would be for a real event.
--
-- The pin self-expires: once pinned_date is in the past, from-db.ts stops
-- forwarding it to the engine, so there's nothing to clear up manually.
alter table public.tasks
  add column pinned_date date,
  add column pinned_start_min int,
  add column pinned_length_min int;
