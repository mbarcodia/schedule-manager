// Applies pending migrations, without the two silent hangs
// (run: npm run migrate — this is the second half of it).
//
// There are two ways this command produces no output forever, and they look
// exactly alike from the terminal. The first is the Keychain prompt, described
// below. The second is a network that filters Postgres ports, which
// scripts/preflight-db-port.mjs checks for before the CLI is ever started —
// its header explains that one.
//
// THE FIRST HANG: THE KEYCHAIN
//
// `supabase login` stores its access token in the macOS Keychain — there is no
// token file on disk, only ~/.supabase/telemetry.json. Reading a Keychain item
// from a process the item's ACL doesn't already trust makes macOS put up an
// authorization dialog, and the CLI blocks until somebody clicks it. From an
// automated or headless shell there is nobody to click, and no dialog to click
// on, so `supabase db push` sits there producing no output for as long as you
// let it. It looks like a slow network call. It is a GUI prompt nobody can see.
//
// That has now cost this project three separate stalls, and once caused a real
// outage: code that read a new column shipped while the hung push had never
// landed, so every request 500'd until the deployment was rolled back.
//
// The CLI checks SUPABASE_ACCESS_TOKEN before it ever touches the Keychain, so
// providing it there removes the prompt entirely. The catch is that putting the
// value in `.env.local` is not by itself enough: that file is loaded by Next.js
// for the app, and nothing loads it for a CLI subprocess. This script is the
// missing link — it reads the file and puts the token in the child's
// environment, which is what makes "just add it to .env.local" true.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkDatabasePort, explain, manualSteps, projectRef } from "./preflight-db-port.mjs";
import { applyPendingOverHttps } from "./migrate-over-https.mjs";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(WEB_DIR, ".env.local");

/** Reads one key out of .env.local. Deliberately not a full dotenv parser —
 * this needs exactly one value and should not pull in a dependency for it. */
function readEnvValue(key) {
  if (!existsSync(ENV_FILE)) return null;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== key) continue;
    // Strip surrounding quotes if the value was written with them.
    return trimmed.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2") || null;
  }
  return null;
}

// An explicit environment variable wins: someone who exported it in their shell
// means it, and should not be silently overridden by a stale file.
const token = process.env.SUPABASE_ACCESS_TOKEN || readEnvValue("SUPABASE_ACCESS_TOKEN");

if (token) {
  console.log("Using SUPABASE_ACCESS_TOKEN — the Keychain is not consulted.");
} else {
  console.warn(
    [
      "",
      "No SUPABASE_ACCESS_TOKEN found, so the CLI will fall back to the macOS",
      "Keychain. If this command produces no output for more than a few seconds,",
      "that is the hang: a GUI authorization prompt with nobody to answer it.",
      "",
      "To remove it for good, create a token at",
      "  https://supabase.com/dashboard/account/tokens",
      "and add it to web/.env.local as:",
      "  SUPABASE_ACCESS_TOKEN=sbp_...",
      "(.env.local is gitignored, so the token stays on this machine.)",
      "",
    ].join("\n"),
  );
}

// Find out whether a Postgres connection can leave this machine at all, before
// handing the CLI a wait it cannot report on. Only a dropped packet stops the
// push; see the preflight's header for why the other verdicts do not.
if (process.env.MIGRATE_SKIP_PREFLIGHT === "1") {
  console.log("Skipping the connection preflight (MIGRATE_SKIP_PREFLIGHT=1).");
} else {
  const check = await checkDatabasePort();

  if (check.verdict === "offline") {
    console.error(explain(check));
    console.error("Nothing was applied. Nothing was deployed.\n");
    process.exit(1);
  }

  // Blocked ports are not the end of the road: the Management API runs SQL over
  // 443, which this network does allow, and it is the same token the CLI uses.
  // So say what is wrong, then go around it — and only send someone to the
  // dashboard if that fails too.
  if (check.verdict === "filtered") {
    console.error(explain(check));

    if (!token) {
      console.error(
        "The HTTPS route needs SUPABASE_ACCESS_TOKEN, which is not set — see the\n" +
          "note above. Without it there is no way through from this network.",
      );
      console.error(manualSteps(check.ref));
      process.exit(1);
    }

    if (process.env.MIGRATE_NO_HTTPS === "1") {
      console.error("Not using the HTTPS route (MIGRATE_NO_HTTPS=1).");
      console.error(manualSteps(check.ref));
      process.exit(1);
    }

    console.error("Going over HTTPS instead, which this network allows.");
    const outcome = await applyPendingOverHttps({
      ref: check.ref ?? projectRef(),
      token,
      dir: join(WEB_DIR, "supabase/migrations"),
    });

    if (outcome.ok) {
      if (outcome.upToDate) {
        console.log("\nNothing pending — every migration is already applied and recorded.");
      } else {
        console.log(
          `\n${outcome.applied.length} migration${outcome.applied.length === 1 ? "" : "s"} applied and ` +
            "recorded in the migration history, so the CLI will not replay them.",
        );
        console.log("Now deploy: `git push` (Vercel), then `flyctl deploy --now` (the relay).");
      }
      process.exit(0);
    }

    console.error(`\nThe HTTPS route failed: ${outcome.error}`);
    if (outcome.applied.length > 0) {
      console.error(
        `\nApplied before stopping: ${outcome.applied.join(", ")}. Each of those is\n` +
          "recorded, so re-running picks up where this left off rather than repeating them.",
      );
    } else {
      console.error("Nothing was applied.");
    }
    console.error(manualSteps(check.ref));
    process.exit(1);
  }

  console.log(`Connection preflight: ${check.detail}`);
}

// --yes because a prompt is the other way this stalls unattended. The CLI grew
// the flag in 2.x; older notes in this repo say to pipe "Y" instead.
const result = spawnSync("npx", ["supabase", "db", "push", "--linked", "--yes"], {
  cwd: WEB_DIR,
  stdio: "inherit",
  env: token ? { ...process.env, SUPABASE_ACCESS_TOKEN: token } : process.env,
});

if (result.error) {
  console.error(`Could not run the Supabase CLI: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    "\nMigration push failed. Nothing was deployed — do NOT push code that reads a new column until this succeeds.",
  );
}

process.exit(result.status ?? 1);
