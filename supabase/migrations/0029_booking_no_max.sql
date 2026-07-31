-- "No maximum" as a real option for a booking link's daily cap.
--
-- max_per_day was NOT NULL, so every link had to name a number and there was no
-- way to say "as many as fit". Null now means unlimited, which is different from
-- a large number: a large number is a limit someone has to guess at, and it
-- silently becomes wrong when a day genuinely has more room.
--
-- Existing links keep their number, so nothing changes for anyone until they
-- choose it.

alter table public.booking_links
  alter column max_per_day drop not null;

comment on column public.booking_links.max_per_day is
  'Maximum bookings accepted per day. NULL = no maximum.';
