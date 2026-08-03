-- Deadlines and due dates that are a DAY, not an instant.
--
-- Both columns are timestamptz, so every deadline had to be a moment. The chat
-- coped by inventing one: titleToDeadlineAt planted 5pm on any deadline given
-- without a clock time, so "AMS Abstract, due August 11" was silently stored as
-- "due 5:00 PM August 11". The to-do panel was worse — a datetime-local input
-- meant you could not enter a date without also naming an hour.
--
-- The invented time then leaked into things that genuinely depend on it:
--
--   reminders — lead_minutes counts back from due_at, so "one day before" on a
--               date-only item fired at 5pm the previous day
--   display   — a fabricated hour shown as though the user had chosen it
--   the engine — the ceiling landed mid-afternoon on the due date instead of
--                letting the work use the rest of that working day
--
-- Following events.all_day (migration 0028): keep the instant, add a flag
-- saying its clock time is not meaningful. The stored instant is the END of the
-- due day in the account's timezone, so it still sorts and compares as "that
-- day" everywhere, and every existing query keeps working untouched. What reads
-- the flag derives what it actually needs — the engine clamps to the end of
-- that day's standard hours, reminders count back from the START of that day's
-- standard hours.
--
-- Commitments already had this right: projects.deadline_date is a plain date.

alter table public.tasks
  add column deadline_all_day boolean not null default false;

alter table public.todo_items
  add column due_all_day boolean not null default false;

-- Existing rows keep default false: their times may have been invented, but
-- there's no way to tell an invented 5pm from a deliberate one, and flipping a
-- deliberate deadline to date-only would silently move it.
