-- Phase 2: read-only external calendar sync. A connection is either an ICS
-- feed URL (Outlook's "Publish a calendar" link, or an iCloud/Google ICS
-- fallback) today, or an OAuth-based provider later — provider distinguishes
-- which. The feed URL/tokens are bearer secrets: readable only through RLS,
-- same trust boundary as everything else in this schema.
create table public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('outlook_ics', 'icloud_ics', 'google_ics')),
  label text not null,
  ics_url text not null,
  last_synced_at timestamptz,
  last_sync_error text,
  last_sync_event_count int,
  created_at timestamptz not null default now()
);

alter table public.calendar_connections enable row level security;
create policy "own calendar_connections" on public.calendar_connections
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Ties a synced event back to the connection that produced it, so a re-sync
-- can safely replace exactly that connection's events (delete-then-insert)
-- without touching manually-added events or other connections' events.
alter table public.events
  add column connection_id uuid references public.calendar_connections(id) on delete cascade;

alter table public.events drop constraint events_source_check;
alter table public.events add constraint events_source_check
  check (source in ('manual', 'google', 'icloud', 'outlook'));
