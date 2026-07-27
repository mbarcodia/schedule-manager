-- Booking round two: where the meeting happens, who it's with by name, and
-- letting either side cancel or reschedule.

-- Which locations a link offers. The visitor picks one at booking time; a
-- link offering only 'zoom' never asks. 'zoom' uses the owner's static
-- meeting-room URL (profiles.booking_meeting_url); 'office' uses
-- profiles.office_location.
alter table public.booking_links
  add column location_modes text[] not null default '{zoom}';

alter table public.profiles
  -- Shown in booking invites as "<visitor> <> <display_name>". Falls back to
  -- the link title when unset, so a fresh account still works.
  add column display_name text,
  -- Free text, e.g. "Cox Science Center, room 412". Shown to the visitor
  -- when they pick the office option and written to the calendar event.
  add column office_location text;

alter table public.bookings
  -- What the visitor chose, so the confirmation/invite/calendar all agree.
  add column location_mode text not null default 'zoom'
    check (location_mode in ('zoom', 'office')),
  -- Cancelled rows are KEPT (history, and the owner may want to see what was
  -- dropped) but stop blocking the slot — see the partial index below.
  add column status text not null default 'confirmed'
    check (status in ('confirmed', 'cancelled')),
  add column cancelled_at timestamptz,
  -- Who cancelled/rescheduled last, for the owner's benefit.
  add column last_changed_by text check (last_changed_by in ('owner', 'visitor'));

-- The original race backstop blocked ANY second booking at the same instant,
-- including one replacing a cancelled meeting. Re-scope it to live bookings
-- so a cancelled slot becomes bookable again.
drop index if exists bookings_user_start_uniq;
create unique index bookings_user_start_confirmed_uniq
  on public.bookings (user_id, starts_at)
  where status = 'confirmed';
