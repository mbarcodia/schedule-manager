-- User-defined categories (e.g. Research/Teaching/Tasks), each with its own
-- color. Replaces priority as the calendar block's main color — priority
-- still drives scheduling order, it just isn't the fill color anymore.
-- Categories apply to both tasks and projects (a project's category colors
-- its auto-generated weekly research chunks too).

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text not null, -- hex, e.g. '#d9748f'
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

alter table public.categories enable row level security;
create policy "own categories" on public.categories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.tasks add column category_id uuid references public.categories(id) on delete set null;
alter table public.projects add column category_id uuid references public.categories(id) on delete set null;

-- Seed the three default categories for every new signup, and also apply
-- them to the existing test account so nothing is left uncategorized.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id);
  insert into public.categories (user_id, name, color, sort_order) values
    (new.id, 'Research', '#d9748f', 0),
    (new.id, 'Teaching', '#6fae7c', 1),
    (new.id, 'Tasks', '#9184d9', 2);
  return new;
end;
$$;

insert into public.categories (user_id, name, color, sort_order)
select id, 'Research', '#d9748f', 0 from auth.users
union all
select id, 'Teaching', '#6fae7c', 1 from auth.users
union all
select id, 'Tasks', '#9184d9', 2 from auth.users
on conflict (user_id, name) do nothing;
