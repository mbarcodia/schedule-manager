// Deep links from a calendar block to the thing's editor on the Progress board.
//
// The calendar is where you notice something ("why is that on Thursday?") and
// the board is where you change it, and until now the trip between them was
// manual: switch page, find the card, open the panel. The to-do link
// (todoItemHref) already established the shape — a plain URL the planner page
// reads on mount — so this is the same contract pointed at the other two panels.
//
// TWO PARAMS, NOT ONE SHARED "item". The ids come from different tables and open
// different panels, and the board already keeps them apart in two pieces of
// state. A single opaque param would make the receiver guess which table a UUID
// belongs to by lookup order, and would make a stale link indistinguishable from
// a typo. `?view=todos&item=` is untouched.

/** A standalone task's panel. `taskId` is a tasks.id. */
export const plannerTaskHref = (taskId: string) => `/planner?view=kanban&task=${taskId}`;

/** A commitment's panel. `projectId` is a projects.id — which is what a weekly
 * hours block resolves to, since its block id is the synthetic
 * `research-<projectId>-w<n>` rather than a task row. */
export const plannerCommitmentHref = (projectId: string) => `/planner?view=kanban&commitment=${projectId}`;
