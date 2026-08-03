-- Labels absorb "time block names".
--
-- There were two user-naming systems doing overlapping jobs. Labels were
-- unlimited, user-named, colour-coded and carried a real scheduling setting
-- (min_chunk_min). "Time block names" were four fixed rename slots on
-- profiles (label_task/label_research/label_deep_focus/label_block) that
-- changed a word in the corner of a calendar block and nothing else.
--
-- Worse, the four "kinds" they named weren't four kinds. Two of them were
-- consequences the user could not choose:
--
--   Research    — appeared because a commitment carried weekly hours, not
--                 because anyone picked it
--   Deep focus  — meant "before noon", which 0014's tasks.time_of_day already
--                 expresses properly (and in both directions)
--
-- So a block's corner tag now shows its LABEL, and the placement rule that
-- "Deep focus" used to smuggle in becomes an explicit per-label setting. One
-- concept: name it, colour it, set its chunk floor and where in the day it
-- belongs. Routines keep a built-in "Routine" tag — "this repeats on its own"
-- is genuinely different from everything else on the calendar, and a routine
-- has no label to wear.

-- Four values rather than a direction plus a strictness flag, because these
-- are the four the engine can actually distinguish: it already had a hard
-- constraint (tasks.time_of_day, refuses to place outside the half-day) and a
-- soft nudge (projects.prefer_morning, tries first and falls back). Null =
-- any time, which is what every existing label means today.
alter table public.categories
  add column time_pref text
    check (time_pref in ('prefer_morning', 'morning_only', 'prefer_afternoon', 'afternoon_only'));

-- A pinned done chunk snapshots the word that was in its corner. With no
-- built-in kind names left there is nothing to snapshot for unlabelled work,
-- and an empty string would render as a stray blank tag.
alter table public.pinned_chunks alter column tag_label drop not null;

-- Existing deep-focus work becomes labelled work, so what it used to be is
-- still visible on the calendar — and now editable, which it never was (the
-- tag could only ever be set through the chat).
insert into public.categories (user_id, name, color, sort_order, min_chunk_min, time_pref)
select
  distinct t.user_id,
  'Deep focus',
  '#d99a5e',
  coalesce((select max(c.sort_order) + 1 from public.categories c where c.user_id = t.user_id), 0),
  90,
  'morning_only'
from public.tasks t
where t.tag = 'deep-focus'
on conflict (user_id, name) do nothing;

-- Only where there's no label already — an existing label is a deliberate
-- choice about what area of work this belongs to, and overwriting it would
-- lose that to preserve something the user never explicitly set.
update public.tasks t
  set category_id = c.id
  from public.categories c
  where t.tag = 'deep-focus'
    and t.category_id is null
    and c.user_id = t.user_id
    and c.name = 'Deep focus';

-- Placement has to survive the tag going away on its own, independently of
-- labels: deep-focus work that already had some other label keeps that label,
-- and that label needn't prefer mornings. Without this those blocks would
-- quietly start being placed in the afternoon.
update public.tasks
  set time_of_day = 'morning'
  where tag = 'deep-focus' and time_of_day is null;
