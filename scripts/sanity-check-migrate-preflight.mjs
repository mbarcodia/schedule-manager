// The migration preflight says whether `db push` would hang before it is run.
// This checks the rule it uses, which is worth pinning because the first version
// of it was wrong in the one case that mattered.
//
// A network that filters Postgres ports drops the packet instead of refusing it,
// so the CLI waits with nothing to report — the same blank symptom as the
// Keychain prompt, and the same real cost: not knowing whether the schema change
// landed. The first rule asked "did any endpoint answer?", and a DNS miss on the
// IPv6-only direct host counted as an answer. It said the network was fine while
// the pooler's packets were being dropped, and the push it allowed hung for
// eleven minutes.
//
// So the case below named "a dns miss does not excuse a dropped pooler" is the
// regression. The rest hold the edges either side of it: don't block a network
// that merely refuses (the CLI reports that fast, and blocking would be a
// migration refused for no reason), and don't blame the firewall when the whole
// network is down.

import { decide, wouldHang } from "./preflight-db-port.mjs";

const pooler = (verdict) => ({ host: "pooler.example", port: 5432, label: "pooler", verdict });
const direct = (verdict) => ({ host: "db.example", port: 5432, label: "direct", verdict });

const cases = [
  {
    name: "a dns miss does not excuse a dropped pooler",
    results: [pooler("timeout"), direct("dns")],
    control: "open",
    expect: "filtered",
  },
  {
    name: "an open port wins over a dropped one",
    results: [pooler("open"), direct("timeout")],
    control: null,
    expect: "ok",
  },
  {
    name: "everything dropped, with 443 up, is the firewall",
    results: [pooler("timeout"), direct("timeout")],
    control: "open",
    expect: "filtered",
  },
  {
    name: "everything dropped, with 443 down too, is the network",
    results: [pooler("timeout"), direct("timeout")],
    control: "timeout",
    expect: "offline",
  },
  {
    name: "a refusal is not a hang, so it does not block",
    results: [pooler("refused"), direct("refused")],
    control: null,
    expect: "ok",
  },
  {
    name: "unresolvable everywhere is not a hang either",
    results: [pooler("dns"), direct("dns")],
    control: null,
    expect: "ok",
  },
  {
    name: "nothing to test means no opinion, never a block",
    results: [],
    control: null,
    expect: "unknown",
  },
];

let failed = 0;
for (const c of cases) {
  const { verdict } = decide(c.results, c.control);
  if (verdict === c.expect) {
    console.log(`  ok    ${c.name} -> ${verdict}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${c.name}: expected ${c.expect}, got ${verdict}`);
  }
}

// The predicate is the load-bearing half, and "one dropped endpoint is enough"
// is the part that was wrong. State it once more directly.
if (!wouldHang([pooler("timeout"), direct("dns")])) {
  failed += 1;
  console.error("  FAIL  wouldHang: one dropped endpoint must be enough to hang");
}
if (wouldHang([pooler("open"), direct("timeout")])) {
  failed += 1;
  console.error("  FAIL  wouldHang: an open endpoint means the push can proceed");
}

// A push must never be blocked over a verdict that cannot hang. This is the
// property that keeps the check from becoming a nuisance that gets skipped.
for (const harmless of ["refused", "dns"]) {
  const { verdict } = decide([pooler(harmless), direct(harmless)], "timeout");
  if (verdict !== "ok") {
    failed += 1;
    console.error(`  FAIL  a network of only "${harmless}" must not block a push (got ${verdict})`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} preflight rule check(s) failed`);
  process.exit(1);
}
console.log("\nmigrate preflight: the rule holds, including the dns-plus-timeout regression");
