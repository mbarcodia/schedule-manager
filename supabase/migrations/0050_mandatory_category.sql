-- A label is now required on anything that logs hours.
--
-- category_id has been optional on tasks since 0004, and a task with none was
-- accepted everywhere without complaint: the form saved it, add_task inserted
-- it, and the calendar happily rendered it. The one place that silence cost
-- something was the hours log — an unlabelled task's time was real, placed,
-- and completed, but it belonged to no label's total. The DOE Review task is
-- the case that exposed it: it should have counted as Service hours and
-- counted toward nothing.
--
-- The fix is at the boundary that matters: nothing that PLACES time on the
-- calendar should be able to do so without a label, because a label is now
-- how hours get attributed, not just a color. Tasks always place time, so
-- category_id is NOT NULL outright. A commitment only places time when it
-- declares weekly_min_min — one with no weekly hours books nothing itself
-- (its child tasks are what book time, and those are covered by the tasks
-- rule), so the commitment-level rule is conditional rather than blanket.
--
-- 0049 backfilled every row this would otherwise reject. recurring_rules.
-- category_id (0038) is deliberately left optional — a routine counting
-- toward a label's hours is still the user's choice, not a requirement,
-- matching the comment on that column.
--
-- This migration must ship in the same deploy as the settings-page fix to
-- deleteCategory: categories.category_id is `on delete set null` (0004), and
-- once these columns are NOT NULL, deleting an in-use label would otherwise
-- surface as a raw constraint violation instead of a readable message.

alter table public.tasks
  alter column category_id set not null;

alter table public.projects
  drop constraint if exists projects_weekly_hours_need_category;
alter table public.projects
  add constraint projects_weekly_hours_need_category
    check (weekly_min_min is null or category_id is not null);

comment on column public.tasks.category_id is
  'Required. Every task places logged time, so every task needs a label to attribute that '
  'time to.';

comment on constraint projects_weekly_hours_need_category on public.projects is
  'A commitment that declares weekly_min_min generates its own calendar blocks and logs '
  'hours directly, so it needs a category the same way a task does. A commitment with no '
  'weekly hours books nothing itself and is exempt.';

-- data-loss: none. Rejects future writes that would have gone uncategorized;
-- every existing row was backfilled by 0049 first.
