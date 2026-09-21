-- A weekly check-in, but not pinned to a fixed count.
--
-- eod_checkin and weekly_summary (0009) are each one slot as flat columns on
-- profiles, because each is genuinely singular — one end of day, one weekly
-- summary. A week's priorities check-in isn't: "beginning, middle, and end of
-- the week" is a description of the shape most weeks take, not a hard count.
-- Some weeks want a fourth check after a conference; a lighter week might
-- want two. Flat columns would mean a migration every time that count needs
-- to change; a table lets it change from settings, same as adding a label.
--
-- One row per slot, not one row per user. dow/time_min follow eod_checkin's
-- own constraint shape (0-6, on-the-hour) because the trigger that reads this
-- table fires on the same hourly external cadence eod_checkin and
-- weekly_summary already use — see AGENTS.md on why Vercel's own cron can't
-- do finer than once a day, and why an external hourly trigger fanning out to
-- these routes is how every per-user, per-time push already works here.
--
-- label is free text shown back to the user in settings ("Monday morning
-- kickoff") — purely for their own orientation, the app does not parse it.
-- No default rows are seeded for a new slot the same way no default labels
-- are seeded (0027): the settings UI offers a one-click "add the usual
-- three" suggestion instead of the app inventing state nobody asked for.

create table if not exists public.checkin_slots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  dow smallint not null check (dow between 0 and 6),
  time_min smallint not null
    check (time_min >= 0 and time_min < 1440 and time_min % 60 = 0),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.checkin_slots enable row level security;
drop policy if exists "own checkin_slots" on public.checkin_slots;
create policy "own checkin_slots" on public.checkin_slots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

comment on table public.checkin_slots is
  'User-configurable weekly check-in prompts. Each row is one push-notification slot '
  '(day of week + time); the weekly-checkin cron route fires a push for every enabled '
  'slot whose dow/time_min matches the current hour in the user''s own timezone.';

-- data-loss: none. New table, no existing data affected.
