-- A label can claim a share of each week.
--
-- "Research should be at least 40% of the time I have each week — 16 hours in a
-- normal 40-hour week, scaled down for weeks with travel or a workshop" was not
-- expressible. Weekly hours live per commitment as an absolute number of
-- minutes, so the intent had to be hand-split across projects (6h + 4h + 3h +
-- 1.5h ≈ 15h) and then re-split by hand every time the week changed shape. Two
-- failures followed from that:
--
--   the total drifted   — nothing checked the per-project numbers against the
--                         40% intent, so 15h passed silently for 16h
--   travel weeks broke  — the absolute minimums stayed at 15h in a week holding
--                         11.8 free hours, so the engine tried to force a full
--                         week of research into a conference week and reported
--                         the remainder as not fitting
--
-- Expressed as a percentage of the week's REAL capacity, both go away: the
-- target scales itself, and the per-commitment minutes become a RATIO between
-- projects rather than a total anyone has to maintain.
--
-- Capacity means the working hours that week which aren't already taken by
-- meetings, all-day "away" days, or routines — the same number the app reports
-- as free hours, so what the chat says and what the engine does agree.

alter table public.categories
  add column weekly_target_pct int
    check (weekly_target_pct is null or (weekly_target_pct > 0 and weekly_target_pct <= 100));

comment on column public.categories.weekly_target_pct is
  'Share of each week''s available working time this label should get, 1-100. '
  'Null = no target, and per-commitment weekly minimums apply as absolute hours. '
  'When set, this label''s commitments have their weekly minutes scaled '
  'proportionally so they sum to the target.';
