// One way to say "that didn't save".
//
// The failure this exists to stop is the quietest one in the app. Every write in
// the board views is followed by a reload, so when a write failed — a lost
// connection, a row-level-security refusal, a constraint — the list simply came
// back the way it was. The tick untucked itself, the list you added wasn't
// there, and nothing said why. It reads as the app ignoring you.
//
// Supabase returns errors rather than throwing, which is what makes them so easy
// to drop: `await supabase.from(...).update(...)` is a complete, correct-looking
// statement that silently discards the only evidence that it failed.

/** Awaits a Supabase write and returns a sentence to show, or null on success.
 *
 * `what` is the human half, phrased as the thing that didn't happen —
 * "Couldn't add that list" — since the Postgres half that follows it is rarely
 * meaningful on its own. */
export async function writeError(
  what: string,
  write: PromiseLike<{ error: { message: string } | null }>,
): Promise<string | null> {
  const { error } = await write;
  return error ? `${what}: ${error.message}` : null;
}

/** The same await, for writes with NOBODY on the other end — cron jobs, webhook
 * handlers, bookkeeping that happens after the response has already streamed.
 *
 * These want a log line, not a banner: there is no screen to put a sentence on,
 * and failing the whole job because one status column didn't update would be a
 * worse outcome than the missed update. What they must not do is stay silent,
 * which is what an unchecked `await supabase.from(...).update(...)` does — the
 * hourly job goes on reporting success while, say, `last_chased_at` never moves
 * and the same list is chased every hour forever.
 *
 * Prefixed `[write]` so every one of them is greppable in the Vercel logs as a
 * single class. Returns whether it landed, for the callers that can act on it. */
export async function logWrite(
  what: string,
  write: PromiseLike<{ error: { message: string } | null }>,
): Promise<boolean> {
  const { error } = await write;
  if (error) console.error(`[write] ${what}: ${error.message}`);
  return !error;
}
