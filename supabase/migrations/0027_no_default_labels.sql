-- New accounts start with no labels.
--
-- Signup used to seed three (Research / Teaching / Tasks) so the first calendar
-- had colour in it. Two problems: "Tasks" was left over from before work was
-- called Work, and more importantly the set only made sense for academic
-- research — anyone else had to delete three labels before adding their own.
--
-- Settings → Labels now offers a few one-click suggestions instead, which is the
-- same head start without deciding on anyone's behalf.
--
-- Existing accounts keep whatever labels they already have; this only changes
-- what happens at signup.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;
