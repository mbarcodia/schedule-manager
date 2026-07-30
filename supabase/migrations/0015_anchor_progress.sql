-- Recurring blocks (anchors — Emails, Lunch, etc.) previously had no
-- way to be marked done/missed at all; only tasks and research chunks could
-- log progress. Add 'anchor' as a third subject_type so the same
-- progress_log mechanism covers them (subject_id = recurring_rules.id).
alter table public.progress_log drop constraint progress_log_subject_type_check;
alter table public.progress_log add constraint progress_log_subject_type_check
  check (subject_type in ('task', 'research', 'anchor'));
