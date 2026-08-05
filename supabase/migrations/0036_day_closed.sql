-- Let a single date be closed, not just shortened.
--
-- "Nothing on the 14th" was not expressible by either path. day_overrides could
-- move a day's start and end, and adjust_day_hours is described as "Shorten a
-- day: set a later start or earlier end" — so the nearest available answer was a
-- one-minute window, which is not the same thing and reads as a mistake on the
-- calendar. Worse, an override with both ends null is treated by
-- resolveDayWindow as NO override (it falls through to the weekday's standard
-- hours), so the obvious guess at how to close a day silently did nothing.
--
-- The two existing ways to have no hours are a weekday switched off in the
-- standard hours, and an all-day calendar entry marked "away". Neither covers a
-- date you simply aren't working — a public holiday, a day of travel with no
-- calendar entry, a day taken back.
--
-- A column rather than a magic value because the shape has to survive contact
-- with the other fields: a closed day may still carry the start/end it had
-- before, so re-opening it restores the window instead of forgetting it.
alter table public.day_overrides
  add column closed boolean not null default false;

comment on column public.day_overrides.closed is
  'Nothing is scheduled on this date at all, whatever the weekday''s standard hours say. '
  'Takes precedence over start_min/end_min, which are kept so re-opening the day restores its window.';
