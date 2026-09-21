-- Research proposals and research projects are different things wearing the
-- same label, and the app has been unable to tell them apart since 0023
-- folded the old projects/proposals/goals tables into one on the theory that
-- "the user-facing word is commitment" for both. That merge lost a real
-- distinction: a proposal is pre-award work with a hard submission date that
-- ENDS it; a project is active funded work with ongoing or milestone
-- deadlines. Scheduling, deadline pressure, and "what happens when this is
-- done" all differ between the two, and nothing in the schema said which one
-- a given row was.
--
-- commitment_kind names that distinction without splitting the table back
-- apart — a commitment is still one row with one history (notes, progress_log,
-- targets), it just now says which phase it's in. Left NULL rather than
-- guessed: this migration does not know which of the existing research
-- commitments are proposals and which are projects, and guessing wrong in a
-- migration is worse than leaving it unset for a person to classify. NULL is
-- also the right resting state for a non-research commitment (Teaching,
-- Service) where the distinction doesn't apply.
--
-- awarded_at records WHEN a proposal became a project, the same way
-- on_hold_at (0041) and archived_at (0037) record when their own state
-- changes happened rather than just whether. A proposal converts to a project
-- IN PLACE by flipping commitment_kind and stamping awarded_at — never by
-- deleting and recreating the row — so its notes and logged hours carry
-- forward instead of starting over. A rejected proposal needs no new state at
-- all: it gets archived exactly like a finished project, via archived_at.

alter table public.projects
  add column if not exists commitment_kind text
    check (commitment_kind is null or commitment_kind in ('project', 'proposal'));

alter table public.projects
  add column if not exists awarded_at timestamptz;

comment on column public.projects.commitment_kind is
  '''proposal'' = pre-award writing/submission work with a submission deadline that ends '
  'it; ''project'' = active funded work. NULL = not classified, or not applicable (a '
  'non-research commitment). Set by the user, never guessed by a migration.';

comment on column public.projects.awarded_at is
  'When a proposal converted to a project (commitment_kind flipped from ''proposal'' to '
  '''project''). NULL until that happens; irrelevant for a commitment that was never a '
  'proposal.';

-- data-loss: none. Both columns are additive and default to NULL.
