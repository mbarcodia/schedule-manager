-- Cleanup after 0025 merged reminders into to-dos, and after preparation time
-- stopped being a booking of its own.
--
-- Both leftovers were kept deliberately so the running app survived the gap
-- between migrating and deploying. Those deploys have happened.
--
--   reminders            — emptied by 0025, which moved every row onto a to-do
--   todo_items.prep_task_id — written by nothing since preparation became an
--                             ordinary booking with an earlier finish-by

-- A prep booking that was never adopted would be orphaned by the drop: its
-- hours would stay on the calendar with nothing pointing at them. Adopt it as
-- the item's booking instead, which is what the panel did while the column was
-- still read.
update public.todo_items
  set task_id = prep_task_id
  where prep_task_id is not null and task_id is null;

-- Anything left is a prep booking on an item that ALSO has its own booking —
-- one of the two would have to be dropped, and choosing silently is worse than
-- stopping. Nothing should reach this.
do $$
declare
  conflicting int;
begin
  select count(*) into conflicting from public.todo_items where prep_task_id is not null;
  if conflicting > 0 then
    raise exception 'aborting: % to-do(s) have both a booking and a separate prep booking', conflicting;
  end if;

  -- 0025 moved every reminder onto a to-do and emptied this table. A row here
  -- would mean one was created afterwards, i.e. against code that no longer
  -- exists — worth stopping for rather than deleting.
  perform 1 from public.reminders limit 1;
  if found then
    raise exception 'aborting: reminders table is not empty';
  end if;
end $$;

alter table public.todo_items drop column prep_task_id;

drop table public.reminders;
