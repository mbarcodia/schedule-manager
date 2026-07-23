-- Before this, a task could only be forced to mornings via deep_focus
-- (before noon) — there was no way to express "afternoon" at all. A vague
-- "schedule this in the afternoon" request had nothing to bind to, so the
-- engine just placed it at the next open slot, which could easily be a
-- morning one. This column gives the scheduler a real constraint to enforce
-- instead of silently ignoring the time-of-day request.
alter table public.tasks
  add column time_of_day text check (time_of_day in ('morning', 'afternoon'));
