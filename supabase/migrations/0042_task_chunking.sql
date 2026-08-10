-- How a task is allowed to be broken up.
--
-- Until now the only lever on this was `chunk_min`, the PREFERRED block size,
-- and a floor that lived on the label rather than the work. Both are the wrong
-- shape for the thing people actually want to say about a particular job:
--
--   "two hours on the abstract, and I need it in one sitting"
--   "two hours on the abstract, split however you like, but all on one day"
--   "nothing shorter than 45 minutes or I never get going"
--
-- The first two were inexpressible. `chunk_min` is only a preference — the
-- engine shrinks a chunk below it to fit a gap — so setting it to 120 did not
-- mean "one block", it meant "try 120 first, then 90, then 60". And the third
-- could only be said about a whole LABEL, so asking for it on one task raised
-- the floor for every piece of research at once.
--
-- Two columns, because they are two independent facts. split_mode says whether
-- the work may be spread out; min_chunk_min says how small a piece may be. A
-- task can carry either, both, or neither.

alter table public.tasks
  -- 'free'      — today's behaviour: chunks anywhere in the window, any day.
  -- 'one_day'   — may still be split, but every piece falls on ONE day. Which
  --               day is the scheduler's choice; it takes the first day that
  --               can hold the whole thing.
  -- 'one_block' — one unbroken sitting of the full duration.
  --
  -- The last two are HARD constraints, like time_of_day: work that cannot be
  -- placed under them is reported unplaced rather than quietly split anyway.
  -- A constraint the scheduler breaks when inconvenient is not a constraint,
  -- and silently breaking this one would be indistinguishable from ignoring it.
  add column split_mode text not null default 'free'
    check (split_mode in ('free', 'one_day', 'one_block')),
  -- The shortest piece this task may be cut into, in minutes. Null = fall back
  -- to its label's minimum, and failing that the engine's own 30-minute floor.
  add column min_chunk_min integer check (min_chunk_min > 0);

comment on column public.tasks.split_mode is
  'free | one_day | one_block. The last two are hard constraints: work that cannot be '
  'placed under them is reported unplaced (see why-not.ts) rather than split anyway.';

-- ⚠️ This OVERRIDES the label's minimum rather than being capped by it, in both
-- directions. A task under a 60-minute label may ask for 45 and get 45.
--
-- That is a deliberate reversal of how the label's floor had worked, and the
-- reason it needs saying: a label's minimum is a sensible DEFAULT for a kind of
-- work, not a fact about every individual job of that kind, and the case for
-- overriding it ("this one is different") is exactly the case for having the
-- field at all. The panels warn at the point of setting it, so an override is
-- always something the user saw themselves do rather than a silent divergence.
comment on column public.tasks.min_chunk_min is
  'Shortest piece this task may be cut into, in minutes. Overrides the label''s '
  'min_chunk_min in BOTH directions when set — shorter as well as longer. Null falls back '
  'to the label, then to the engine''s 30-minute floor.';
