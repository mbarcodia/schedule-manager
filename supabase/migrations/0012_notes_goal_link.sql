-- Notes could already link to a project, proposal, or task, but not a goal
-- (goals have no deadline/schedule status, so they were left out of the
-- original note-linking design) — create_note/update_note would silently
-- no-op a link_to a goal instead of erroring, which was confusing. Add the
-- missing column so goals are a real link target like everything else.
alter table public.notes
  add column goal_id uuid references public.goals(id) on delete set null;
