-- Replace the single global work_start_hour/work_end_hour with a per-weekday
-- schedule (including weekends), so "starts early"/"starts late" and the
-- engine's own slot-finding both compare against the right baseline for
-- each day rather than one hour pair applied to every day.
--
-- Keys are "0".."6" (0=Mon..6=Sun), matching the engine's gday%7 convention.
-- A null value means "day off by default" — day_overrides can still turn a
-- specific date on (this is the generalized form of the old weekend opt-in).

alter table public.profiles
  add column weekly_hours jsonb not null default '{
    "0": {"start": 540, "end": 1020},
    "1": {"start": 540, "end": 1020},
    "2": {"start": 540, "end": 1020},
    "3": {"start": 540, "end": 1020},
    "4": {"start": 540, "end": 1020},
    "5": null,
    "6": null
  }'::jsonb;

alter table public.profiles drop column work_start_hour;
alter table public.profiles drop column work_end_hour;
