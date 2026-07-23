-- Standing preferences like "research blocks no shorter than 1 hour" were
-- only ever advisory prose read by the assistant/planner's system prompt —
-- the actual scheduling engine has its own hardcoded 30-minute shrink floor
-- (engine.ts) that silently overrides any such intent. Give categories a
-- real, structural minimum chunk size the engine can enforce per task, so
-- "Research work is never shorter than 1 hour" is guaranteed, not advisory.
alter table public.categories
  add column min_chunk_min integer;
