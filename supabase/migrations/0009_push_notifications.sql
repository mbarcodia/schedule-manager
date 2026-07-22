-- Web push notifications: browser subscriptions (one row per registered
-- device/browser) plus two user-configurable digests on profiles. Delivery
-- runs on Vercel Cron, which can only fire a given job once/day — the cron
-- routes work around that by running hourly and matching each user's chosen
-- local time themselves, so times here are hour-aligned only (see the
-- eod-checkin/weekly-summary route comments for why).
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
create policy "own push_subscriptions" on public.push_subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Minutes-of-day, same convention as weekly_hours. Both digests default to
-- off so nothing sends until the user opts in via settings.
alter table public.profiles
  add column eod_checkin_enabled boolean not null default false,
  add column eod_checkin_time smallint not null default 1080
    check (eod_checkin_time >= 0 and eod_checkin_time < 1440 and eod_checkin_time % 60 = 0),
  add column weekly_summary_enabled boolean not null default false,
  add column weekly_summary_dow smallint not null default 4
    check (weekly_summary_dow between 0 and 6),
  add column weekly_summary_time smallint not null default 1080
    check (weekly_summary_time >= 0 and weekly_summary_time < 1440 and weekly_summary_time % 60 = 0);
