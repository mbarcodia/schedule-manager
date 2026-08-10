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
