-- Fix: tables created via the SQL Editor didn't inherit the default grants
-- Supabase normally provisions for the `authenticated` and `service_role`
-- Postgres roles, so PostgREST was denying every request before Row Level
-- Security even got evaluated ("permission denied for table X"). This grants
-- the base table access; the RLS policies from 0001_init.sql still restrict
-- `authenticated` to each account's own rows.

grant usage on schema public to authenticated, service_role;

grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- So future tables/sequences created in this schema get the same grants
-- automatically, without needing another one-off fix like this.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema public
  grant usage, select on sequences to authenticated, service_role;
