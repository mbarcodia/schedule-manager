-- Public booking links (Calendly-style): visitors hit /book/<slug> with no
-- session and book a meeting. The anon role has no grants (0002) on purpose —
-- ALL public reads/writes go through server routes using the service-role
-- client, scoped by slug. These tables never get anon policies.

-- Google OAuth refresh token for writing bookings onto the owner's Google
-- Calendar. Locked-table style (see 0011_planner_credentials.sql): RLS
-- enabled with NO policies + explicit revoke — service-role only. Narrowest
-- scope (calendar.events); the owner can revoke at myaccount.google.com.
create table public.google_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  google_email text not null,
  refresh_token text not null,
  -- Set when Google returns invalid_grant (owner revoked / token expired):
  -- bookings keep working locally; Settings shows "Reconnect".
  needs_reconnect boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.google_credentials enable row level security;
revoke all on public.google_credentials from anon, authenticated;

-- One row per shareable booking page. Owner manages these from Settings via
-- the normal client (own-rows policy); the public routes look them up by
-- slug with the service-role client, so no anon access is ever needed.
create table public.booking_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Globally unique (not per-user): it's the sole lookup key on the public
  -- page. Crypto-random ~10 base62 chars = unguessable.
  slug text not null unique,
  title text not null,
  -- Minutes the visitor can pick from, e.g. {20,30,60}.
  durations int[] not null default '{30}',
  -- Keys "0".."6" (0=Mon..6=Sun, same convention as profiles.weekly_hours);
  -- value {start,end} in minutes-of-day, or null = that day not bookable.
  -- Intersected with the owner's working hours (resolveDayWindow) at
  -- availability time — this only ever narrows, never widens.
  day_windows jsonb not null default '{}',
  -- Task categories that count as busy on the booking page (e.g. Deep
  -- Focus). Task blocks in other categories are bookable-over: the engine
  -- reflows them around the new meeting automatically.
  blocking_category_ids uuid[] not null default '{}',
  buffer_min int not null default 0,
  min_notice_hours int not null default 24,
  max_per_day int not null default 3,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.booking_links enable row level security;
create policy "own booking_links" on public.booking_links
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Booking records (visitor PII lives here, not on events). The owner may
-- read her own; all writes happen in the public POST route via the
-- service-role client, so authenticated gets no write policies at all.
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  link_id uuid not null references public.booking_links(id) on delete cascade,
  event_id uuid references public.events(id) on delete set null,
  -- Null = Google insert skipped or failed (booking still stands locally).
  google_event_id text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  duration_min int not null,
  visitor_name text not null,
  visitor_email text not null,
  visitor_note text,
  created_at timestamptz not null default now()
);
alter table public.bookings enable row level security;
create policy "own bookings read" on public.bookings
  for select using (auth.uid() = user_id);
revoke insert, update, delete on public.bookings from anon, authenticated;
-- Race backstop: two visitors confirming the exact same instant — the
-- second insert violates this and the route maps it to a 409.
create unique index bookings_user_start_uniq on public.bookings (user_id, starts_at);

-- The owner's static meeting-room URL (e.g. a Zoom personal room), attached
-- to every booking (events.meeting_url + the Google event + the .ics).
alter table public.profiles add column booking_meeting_url text;
