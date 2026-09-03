// Answers one question before a migration push: can a Postgres connection to
// this project even leave the machine?
//
// THE SECOND SILENT HANG
//
// `scripts/db-push.mjs` exists because of the first one — the Keychain prompt
// nobody can answer. Supplying SUPABASE_ACCESS_TOKEN removed that, and the very
// next push hung anyway, for eleven minutes, on a different cause with an
// identical symptom: no output at all.
//
// The cause was the network. Postgres ports are filtered here — a connection to
// port 5432 or 6543 gets its SYN dropped rather than refused, while port 443 to
// the exact same hosts opens instantly. A dropped packet has no error to report,
// so the CLI sits in connect() until something gives up, printing nothing. From
// the outside it is indistinguishable from a slow migration.
//
// Both hangs cost the same thing: not knowing whether the schema change landed.
// That is the state that shipped an outage once already, when code reading a new
// column went live while a hung push had never applied it. So the fix is the
// same shape as the first — find out cheaply, up front, and say so in plain
// words instead of letting a silent wait stand in for an answer.
//
// WHY ONLY A TIMEOUT BLOCKS
//
// A refused connection is fine to proceed on: the packet reached a stack that
// answered, so whatever the CLI hits next, it hits fast and says so. Same for a
// DNS failure or an unreachable network. A *timeout* is the only verdict that
// predicts the silent wait, so it is the only one that stops the push. This is
// deliberately not a general health check — it declines to guess about anything
// except the failure it was built to name.

import { readFileSync, existsSync } from "node:fs";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** How long to wait before calling a connection dropped. Long enough that a
 * merely slow network is not accused, short enough to stay a preflight. */
const PROBE_TIMEOUT_MS = 6000;

function readEnvValue(key) {
  const envFile = join(WEB_DIR, ".env.local");
  if (!existsSync(envFile)) return null;
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== key) continue;
    return trimmed.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2") || null;
  }
  return null;
}

/** Resolves to "open", "timeout", "refused", or "dns". */
function probe(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(verdict);
    };
    socket.setTimeout(timeoutMs, () => finish("timeout"));
    socket.once("connect", () => finish("open"));
    socket.once("error", (err) => {
      const code = err && err.code;
      finish(code === "ENOTFOUND" || code === "EAI_AGAIN" ? "dns" : "refused");
    });
  });
}

/** The project ref, from the app's own Supabase URL or the CLI's link file. */
export function projectRef() {
  const url = readEnvValue("NEXT_PUBLIC_SUPABASE_URL");
  const fromUrl = url && url.match(/([a-z0-9]{20})\.supabase\./i);
  if (fromUrl) return fromUrl[1];
  const refFile = join(WEB_DIR, "supabase/.temp/project-ref");
  if (existsSync(refFile)) return readFileSync(refFile, "utf8").trim() || null;
  return null;
}

/** Every endpoint the CLI might dial, so a clear verdict on one is enough. The
 * pooler is listed first: it is what the CLI prefers, and the direct host is
 * IPv6-only on newer projects, where an unreachable-network error would muddy
 * the reading. */
function candidates(ref) {
  const found = [];
  const poolerFile = join(WEB_DIR, "supabase/.temp/pooler-url");
  if (existsSync(poolerFile)) {
    const match = readFileSync(poolerFile, "utf8").match(/@([^:/@\s]+):(\d+)/);
    if (match) found.push({ host: match[1], port: Number(match[2]), label: "pooler" });
  }
  if (ref) found.push({ host: `db.${ref}.supabase.co`, port: 5432, label: "direct" });
  return found;
}

/**
 * The rule, kept pure so it can be tested without a network.
 *
 * True when the push would sit there silently: nothing is open, and at least one
 * endpoint is having its packets dropped.
 *
 * The subtlety that broke the first version is the "at least one". Verdicts do
 * not average out — a DNS miss on the IPv6-only direct host is not evidence
 * about the pooler, and treating it as evidence let a push through to an
 * eleven-minute hang. Every endpoint is a separate way to fail, and one that
 * hangs is enough to hang.
 */
export function wouldHang(results) {
  if (results.some((r) => r.verdict === "open")) return false;
  return results.some((r) => r.verdict === "timeout");
}

/**
 * Turns probe results into a verdict. Pure — `controlVerdict` is the answer from
 * port 443, or null when nothing was dropped and the control was not needed.
 *
 *   "ok"       — something answered, or failed in a way the CLI will announce
 *   "filtered" — a Postgres port timed out while 443 answered: the push would
 *                hang, and there is a firewall in the way
 *   "offline"  — dropped, and 443 did not answer either: the network is down
 *   "unknown"  — no endpoint to test, so this check has no opinion
 */
export function decide(results, controlVerdict) {
  if (results.length === 0) {
    return { verdict: "unknown", detail: "No project ref or pooler URL to test against." };
  }

  if (!wouldHang(results)) {
    const reachable = results.find((r) => r.verdict === "open");
    if (reachable) {
      return { verdict: "ok", detail: `${reachable.label} ${reachable.host}:${reachable.port} is open.` };
    }
    // Nothing was dropped, so nothing will wait silently. Whatever is wrong here
    // — a stale ref, an unresolvable host — the CLI hits it fast and names it.
    const how = results.map((r) => r.verdict).join(", ");
    return { verdict: "ok", detail: `No port open, but nothing is being dropped either (${how}).` };
  }

  if (controlVerdict === "open") {
    return { verdict: "filtered", detail: "A database port is being dropped while 443 answers." };
  }
  return { verdict: "offline", detail: `A database port is being dropped, and 443 did not answer either (${controlVerdict}).` };
}

/** Probes the ways in and applies the rule. */
export async function checkDatabasePort() {
  const ref = projectRef();
  const endpoints = candidates(ref);
  const results = await Promise.all(
    endpoints.map(async (e) => ({ ...e, verdict: await probe(e.host, e.port) })),
  );

  // The control only means something once something has been dropped, so it is
  // only paid for then.
  const controlHost = ref ? `${ref}.supabase.co` : "supabase.com";
  const controlVerdict = wouldHang(results) ? await probe(controlHost, 443) : null;

  return { ...decide(results, controlVerdict), results, ref, controlHost };
}

/** The message that turns a verdict into something to do next. */
export function explain({ verdict, results = [], ref }) {
  const tried = results.map((r) => `  ${r.host}:${r.port} (${r.label}) — ${r.verdict}`).join("\n");
  const sqlEditor = ref
    ? `https://supabase.com/dashboard/project/${ref}/sql/new`
    : "your project's dashboard → SQL Editor";

  if (verdict === "filtered") {
    return [
      "",
      "This network drops outbound Postgres connections, so `supabase db push`",
      "cannot connect. It would not fail — it would hang, with no output, for as",
      "long as you left it. Stopping here instead.",
      "",
      tried,
      "",
      "Port 443 to the same host is open, so this is a firewall on the database",
      "ports specifically. Campus, corporate and some hotel networks do this.",
      "",
      "Two ways on:",
      "",
      "  1. A network that allows port 5432 — a phone hotspot is the quick test —",
      "     then run `npm run migrate` again. Nothing else changes.",
      "",
      `  2. Apply the SQL by hand at ${sqlEditor}`,
      "     Paste the body of each pending file from supabase/migrations/ and run",
      "     it. Write migrations so re-running is harmless (`add column if not",
      "     exists`), because the CLI will not know these were applied and will",
      "     try again from the next unfiltered network.",
      "",
      "The backup already ran, so `backups/` holds a snapshot from just now",
      "either way.",
      "",
    ].join("\n");
  }

  if (verdict === "offline") {
    return [
      "",
      "Nothing on this project answered, port 443 included, so this looks like the",
      "network rather than the database. Not pushing — a migration is the wrong",
      "thing to start on a connection that may drop halfway.",
      "",
      tried,
      "",
    ].join("\n");
  }

  return "";
}
