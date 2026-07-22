-- Per-user Claude credentials for the planner: either an Anthropic API key
-- (billed to the user directly) or a Claude subscription OAuth token (Stage
-- 3, run through the Agent SDK). Deliberately NOT RLS'd like every other
-- table (single "own X" policy) — this table has RLS enabled with NO
-- policies, plus an explicit revoke, so neither anon nor authenticated
-- Supabase clients can read or write it at all, even their own row. Only
-- the service-role client (createAdminClient(), src/lib/supabase/server.ts)
-- bypasses RLS and can touch it. The secret is the user's own credential —
-- the threat model here is other users and the client bundle, not the
-- account owner, so plaintext-at-rest is an accepted tradeoff for now.
create table public.planner_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null check (provider in ('api_key', 'oauth_token')),
  secret text not null,
  created_at timestamptz not null default now()
);

alter table public.planner_credentials enable row level security;
revoke all on public.planner_credentials from anon, authenticated;
