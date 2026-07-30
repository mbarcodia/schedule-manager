-- Grace window for un-ticked work.
--
-- Previously a block became "missed" the instant its end time passed without a
-- progress log, with no allowance for simply forgetting to tick the box. It now
-- stays visible and checkable in its original slot for this many hours first,
-- rendered greyed rather than as a definitive miss.
--
-- Note the hours ARE still re-placed immediately (the deliberate choice: the
-- schedule reacts straight away, and ticking the box within the window undoes
-- it) — the window governs how long the original block remains present and
-- completable, not whether the engine reacts.
alter table public.profiles
  add column grace_hours int not null default 4
    check (grace_hours >= 0 and grace_hours <= 48);
