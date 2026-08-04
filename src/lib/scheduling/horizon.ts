// How far ahead the scheduler plans.
//
// One constant, imported by both the row fetcher (which bounds the date range it
// queries) and the input builder (which converts real dates onto the relative
// grid). They used to hold a copy each, which is a silent-drift hazard: raising
// one alone would either fetch rows the engine then discards, or fence the
// engine to a window narrower than the data it was handed.
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
