-- Lets each connected calendar carry its own accent color, shown as a left
-- edge bar on its synced meeting blocks so multiple connected calendars are
-- distinguishable at a glance without recoloring the whole block (that
-- treatment is reserved for task categories).
alter table public.calendar_connections
  add column color text not null default '#5b8def';
