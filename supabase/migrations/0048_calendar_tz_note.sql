-- Make a guessed timezone visible on the connection that guessed.
--
-- Outlook publishes its feed with `TZID:Customized Time Zone`, a name no zone
-- database knows. The ICS parser answered that by using the SERVER's timezone,
-- so every meeting on that calendar was stored four hours early — and nothing
-- anywhere said so. The times looked ordinary, the sync reported success, and
-- the booking link offered strangers slots on top of real meetings for weeks.
--
-- src/lib/calendar-sync/tzid.ts now resolves zones from the feed's own
-- VTIMEZONE rules and refuses to fall back to the server's zone. But the last
-- resort is still a guess (the account's own timezone), and a guess that leaves
-- no trace is how this went unnoticed the first time. This column carries that
-- trace to Settings: which TZID could not be pinned down, and what it was read
-- as. Null is the normal, silent case.
--
-- data-loss: none — new nullable column, no existing column touched.
alter table public.calendar_connections
  add column last_sync_tz_note text;

comment on column public.calendar_connections.last_sync_tz_note is
  'Human-readable note when the last sync had to guess a timezone, or when the feed contradicted itself. Null when every zone resolved cleanly. Surfaced in Settings.';
