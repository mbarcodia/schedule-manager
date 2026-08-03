-- Cleanup after 0030. APPLY ONLY ONCE THE CODE THAT READS THESE IS DEPLOYED —
-- both deploys, Vercel AND `flyctl deploy` for the chat relay. Until then the
-- running app still selects profiles.label_* and would start erroring.
--
--   profiles.label_task / label_research / label_deep_focus / label_block
--     — the four rename slots. Settings no longer offers them and the engine
--       no longer reads them; a block's corner tag comes from its label.
--   tasks.tag
--     — only ever held 'deep-focus', which 0030 converted into a label plus
--       time_of_day='morning'. ('research' was never stored here: the engine
--       synthesized it in memory for weekly-hours blocks.)
--
-- recurring_rules.tag is deliberately left alone. It's equally unused for
-- display (routines have always shown the built-in "Routine" tag whatever it
-- held) but it's free text a user may have written something into, and it
-- costs nothing to keep.

alter table public.profiles
  drop column label_task,
  drop column label_research,
  drop column label_deep_focus,
  drop column label_block;

alter table public.tasks drop column tag;
