-- weekly_target_pct stops being an instruction to the engine and becomes a
-- number the user checks their actual hours against.
--
-- 0033 introduced this column so "research should be 40% of my week" could
-- scale itself instead of being hand-split across commitments. That worked
-- as scaling, but scaling is the wrong mechanism for what the user actually
-- wanted: the freedom to decide week to week what to work on, with hours
-- LOGGED per label so the split could be reviewed and corrected afterward —
-- not a fixed ratio the engine kept re-deriving and forcing commitments into,
-- which broke in exactly the ways forcing tends to: an on-hold commitment
-- silently changed the ratio the rest were scaled to, and ad-hoc task work
-- with no weekly_min_min behind it counted toward nothing no matter how much
-- of it got done.
--
-- The column, the percentage the user sets, and the TARGET figure in the
-- weekly review are all unchanged — only what CONSUMES the percentage
-- changes: nothing in the scheduling engine reads it anymore (see the engine
-- changes alongside this migration). It is compared against logged hours
-- (progress_log, via week-review.ts's DONE figure), never used to compute a
-- commitment's placed minutes.

comment on column public.categories.weekly_target_pct is
  'Share of each week''s available working time this label is BENCHMARKED against, 1-100. '
  'Purely descriptive: does not scale or force commitment minutes. Compared against actual '
  'logged hours in the weekly review (TARGET vs DONE). Null = no benchmark set. See 0033 '
  'for the capacity/target_basis semantics, which are unchanged.';

-- data-loss: none. Comment-only; no schema or data change.
