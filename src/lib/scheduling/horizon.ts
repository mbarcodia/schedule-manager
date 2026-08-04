// How far ahead the scheduler plans.
//
// One constant. THREE places held a copy of it, which is a silent-drift hazard
// with a different symptom in each:
//
//   query-rows.ts        bounds the date range read from the database
//   from-db.ts           fences the relative grid the engine works on
//   calendar-sync/sync.ts  bounds the date range pulled from each ICS feed
//
// The last one is the nastiest, because it decides what is ever STORED. Raising
// the other two while it stayed at 12 weeks would make a December trip that is
// sitting on the source calendar simply never arrive — a sync would report
// success, the event would be absent, and nothing anywhere would say why.
// Anything that needs a horizon bound must import this rather than restate it.
//
// Was 12 weeks, which quietly refused anything further out. Two things a
// semester needs fell straight off the end: travel in December could not be
// blocked ("beyond the scheduling horizon"), and a task whose earliest start was
// past the edge came back reported as work that "didn't fit" — indistinguishable
// from a genuine capacity problem.
//
// Six months, which reaches early February from the start of the autumn term:
// far enough to hold a whole semester, the travel at the end of it, and the
// conference talk in the January after. Compute is not what bounds this (the
// engine is roughly linear and small — ~3ms at 12 weeks, ~11ms at 52 on a real
// account); the reason not to reach further is that a longer horizon means more
// rows fetched on every page load for weeks nobody is looking at yet.
//
// It is NOT bounded by what the chat can afford, which was the other candidate
// answer: the per-turn snapshot re-sends the schedule on every message, so
// widening the horizon would have multiplied the cost of every planner turn.
// That is capped independently in buildPromptContext — full detail for the near
// weeks, travel and deadlines only beyond them — so this number is free to be
// about planning range rather than about tokens.
export const HORIZON_WEEKS = 26;
