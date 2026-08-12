-- How a to-do list decides its own order.
--
-- `sort_order` became a real, written column in the previous change, which gave
-- every list drag-to-arrange. That is the right default and the wrong rule for
-- some lists. A Reviews list is the clear case: its items are deadlines, the only
-- order that matters is which is due next, and hand-arranging them is busywork
-- that goes stale the moment a new review comes in. The account this was found on
-- had "npj climate" (due Aug 14) sitting below "AIES Lessons Learned" (due Aug 26)
-- purely because it was typed second.
--
-- WHY PER LIST rather than one rule for the app. The two orders are both right,
-- for different lists. "THIS WEEK" is a priority order the user holds in their
-- head and expresses by dragging; "Reviews" is a queue with real dates. Forcing
-- either rule everywhere makes one of those lists wrong, and the previous change
-- had already established dragging as the thing that decides position — so a
-- global switch to dates would have silently disabled a control that was just
-- added.
--
-- WHAT 'due' MEANS, exactly: dated items first, earliest first; undated items
-- after them, in the hand-arranged `sort_order`. The undated tail keeps drag
-- because that is the part of the list where dates cannot decide anything — so
-- the handle disappears from dated rows and stays on undated ones, rather than
-- the whole list losing it.
--
-- Not enforced in SQL. The ordering is a mixed rule (a nulls-last date sort
-- followed by a manual sort) applied in one shared helper that the board and the
-- chat both call, so both surfaces read a list back in the same order. Doing half
-- of it in an ORDER BY would put the rule in two places, which is how they drift.

alter table public.todo_lists
  add column sort_mode text not null default 'manual'
    check (sort_mode in ('manual', 'due'));

comment on column public.todo_lists.sort_mode is
  '''manual'' = the order the user dragged things into (sort_order). ''due'' = '
  'dated items by due date first, then undated ones in sort_order. Applied in '
  'lib/planner/todo-order.ts, not in SQL, because it is a mixed rule.';

-- Defaulting to 'manual' keeps every existing list exactly as it looks today.
-- Only lists the user explicitly switches change, which matters because this
-- lands on an account already using the drag order.
