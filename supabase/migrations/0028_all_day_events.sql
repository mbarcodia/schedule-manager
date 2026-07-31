-- All-day calendar events, and what they're allowed to block.
--
-- The ICS parser silently discarded every all-day event (`datetype === "date"`),
-- for a real reason: across six connected calendars there are ~124 of them, most
-- being birthday and holiday banners, and treating those as busy time would
-- erase most of the month. But dropping them entirely is worse in the other
-- direction — a week-long "at a conference" event was invisible, so the public
-- booking page happily offered those days to strangers and the scheduler planned
-- work as if the week were free.
--
-- Neither behaviour is right for every calendar, so the choice is per calendar:
--
--   ignore      (default) — as before: not stored, blocks nothing
--   no_meetings — nobody can book that day, but own work is still scheduled.
--                 For a conference or travel day: unavailable to others, still
--                 a working day for you.
--   away        — nothing is scheduled at all. For actual leave.
--
-- Default is 'ignore' so existing deployments behave exactly as they did until
-- someone opts a calendar in.

alter table public.calendar_connections
  add column all_day_mode text not null default 'ignore'
    check (all_day_mode in ('ignore', 'no_meetings', 'away'));

-- Marks a row as coming from an all-day event so the calendar can render it as a
-- banner rather than a block covering every hour, and so the engine can apply
-- the connection's mode instead of treating it as ordinary busy time.
--
-- A multi-day all-day event (Mon-Fri at a conference) is stored as one row per
-- day, because everything downstream — the grid, the busy set, the day window —
-- works a day at a time.
alter table public.events
  add column all_day boolean not null default false;

create index events_all_day_idx on public.events (user_id, all_day) where all_day;
