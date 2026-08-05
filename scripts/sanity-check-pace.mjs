// Sanity check for pace, and specifically for WHAT it measures against an
// interim date (run: npx tsx scripts/sanity-check-pace.mjs).
//
// computePace is pure over projects/targets/logged minutes, so synthetic rows
// are enough — no engine, no DB. The cases that matter are the ones where the
// commitment's remaining effort and the effort due by the next date are not the
// same number, because comparing the wrong pair is how an 80h proposal came to
// report "go 38h/wk" about a one-page notice of intent.

import { computePace, paceSentence, loggedMinutesByCommitment } from "../src/lib/scheduling/pace.ts";

const NOW = new Date("2026-08-05T16:00:00Z");
const day = (iso) => new Date(`${iso}T00:00:00`);
const H = 60;

let failures = 0;
let checks = 0;
function check(label, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const project = (over = {}) => ({
  id: "p1",
  title: "Proposal",
  effortEstimateMin: 80 * H,
  weeklyMinMin: 3 * H,
  deadlineDate: day("2026-10-30"),
  deadlineKind: "hard",
  important: false,
  ...over,
});

const target = (over = {}) => ({
  id: `t${Math.abs(over.title?.length ?? 0)}-${over.title ?? ""}`,
  projectId: "p1",
  title: "phase",
  date: day("2026-08-20"),
  completedAt: null,
  dateKind: "goal",
  effortEstimateMin: null,
  ...over,
});

const run = (projects, targets, loggedMin = 0) =>
  computePace({
    projects,
    targets,
    loggedByProject: loggedMin ? { p1: loggedMin } : {},
    weeklyHours: {},
    now: NOW,
  })[0];

// ---------------------------------------------------------------- unmeasurable

check(
  "no estimate, no date, no rate — every gap named",
  run([project({ effortEstimateMin: null, weeklyMinMin: null, deadlineDate: null })], []).missing,
  ["estimate", "date", "weekly hours"],
);

check(
  "estimate and rate but no date at all",
  run([project({ deadlineDate: null })], []).missing,
  ["date"],
);

check(
  "a deadline already in the past is not a date to measure against",
  run([project({ deadlineDate: day("2026-07-01") })], []).missing,
  ["date"],
);

// --------------------------------------------------- the deadline is the scope

{
  const p = run([project()], [], 10 * H);
  check("no targets: scope is the whole estimate", [p.scopeMin, p.remainingMin], [80 * H, 70 * H]);
  check("no targets: measured against the deadline", p.nextDateLabel, "deadline");
  // 70h at 3h/wk is ~23 weeks against ~12 to Oct 30.
  check("no targets: slipping against the deadline", p.status, "slipping");
}

// ------------------------------------------- an interim target WITHOUT hours
// The pre-migration behaviour, kept deliberately: an undimensioned checkpoint
// says nothing about how much is due by it, so the whole remaining effort is
// still what gets measured. Documented here so the fallback is a decision on
// the record rather than something to be surprised by.

{
  const p = run([project()], [target({ title: "notice of intent" })], 10 * H);
  check("undimensioned target: scope stays the whole estimate", p.scopeMin, 80 * H);
  check("undimensioned target: measured against the target", p.nextDateLabel, "notice of intent");
  check("undimensioned target: reads as slipping", p.status, "slipping");
}

// ---------------------------------------------- an interim target WITH hours

{
  const p = run([project()], [target({ title: "notice of intent", effortEstimateMin: 4 * H })], 1 * H);
  check("costed target: scope is that phase only", [p.scopeMin, p.remainingMin], [4 * H, 3 * H]);
  check("costed target: total estimate is still reported", p.estimateMin, 80 * H);
  check("costed target: progress bar still runs on the total", p.fractionDone, (1 * H) / (80 * H));
  // 3h left at 3h/wk = 1 week, against ~2.1 weeks to Aug 20.
  check("costed target: no longer a crisis", p.status, "ahead");
  check(
    "costed target: the sentence names the phase's hours, not the project's",
    paceSentence(p),
    "1h of the 4h due by “notice of intent” on Aug 20 — comfortably ahead.",
  );
}

// ------------------------------------------------------------- cumulative sums

{
  const targets = [
    target({ title: "outline", date: day("2026-08-10"), effortEstimateMin: 6 * H }),
    target({ title: "draft", date: day("2026-08-20"), effortEstimateMin: 10 * H }),
    target({ title: "submit", date: day("2026-10-30"), effortEstimateMin: 64 * H }),
  ];
  const first = run([project()], targets, 2 * H);
  check("cumulative: the soonest target only counts itself", [first.nextDateLabel, first.scopeMin], ["outline", 6 * H]);

  // With the outline hit, the draft is next and owes the outline's hours too.
  const second = run(
    [project()],
    targets.map((t) => (t.title === "outline" ? { ...t, completedAt: new Date("2026-08-09T12:00:00Z") } : t)),
    6 * H,
  );
  check("cumulative: a completed phase's hours stay in the running total", [second.nextDateLabel, second.scopeMin], [
    "draft",
    16 * H,
  ]);

  // A phase whose date passed unfinished is still work owed before the next one.
  const missed = run(
    [project()],
    targets.map((t) => (t.title === "outline" ? { ...t, date: day("2026-08-01") } : t)),
    0,
  );
  check("cumulative: a missed phase is still owed", [missed.nextDateLabel, missed.scopeMin], ["draft", 16 * H]);
}

check(
  "one undimensioned phase in the run makes the cumulative figure an undercount — fall back to the total",
  run(
    [project()],
    [
      target({ title: "outline", date: day("2026-08-10"), effortEstimateMin: null }),
      target({ title: "draft", date: day("2026-08-20"), effortEstimateMin: 10 * H }),
    ],
    0,
  ).scopeMin,
  80 * H,
);

check(
  "a later phase without hours doesn't affect a costed earlier one",
  run(
    [project()],
    [
      target({ title: "outline", date: day("2026-08-10"), effortEstimateMin: 6 * H }),
      target({ title: "draft", date: day("2026-08-20"), effortEstimateMin: null }),
    ],
    0,
  ).scopeMin,
  6 * H,
);

// ------------------------------------------------- phase hours ARE an estimate

{
  const p = run(
    [project({ effortEstimateMin: null })],
    [target({ title: "notice of intent", effortEstimateMin: 4 * H })],
    1 * H,
  );
  check("a costed next phase is enough to measure, with no project total", p.missing, []);
  check("without a total there is no progress fraction to show", p.fractionDone, null);
  check(
    "and the sentence doesn't claim a scope it can't compare to a total",
    paceSentence(p),
    "1h of 4h — comfortably ahead of “notice of intent” on Aug 20.",
  );
}

// ----------------------------------------------------------- status boundaries

check(
  "the phase's hours are all logged — nothing left to be late for",
  run([project()], [target({ title: "outline", effortEstimateMin: 4 * H })], 4 * H).status,
  "ahead",
);

check(
  "nothing logged at all is 'not started', not 'ahead'",
  run([project()], [target({ title: "outline", effortEstimateMin: 4 * H })], 0).status,
  "not_started",
);

{
  // 6h left at 3h/wk = 2 weeks against 2.14 available: fits, no slack (>0.85).
  const p = run([project()], [target({ title: "outline", effortEstimateMin: 7 * H })], 1 * H);
  check("tight but achievable is 'on pace'", p.status, "on_pace");
  check(
    "on-pace sentence, scoped",
    paceSentence(p),
    "1h of the 7h due by “outline” on Aug 20 — on pace, without much slack.",
  );
}

{
  // 14h left at 3h/wk = 4.7 weeks against 2.14 to Aug 20.
  const p = run([project()], [target({ title: "outline", effortEstimateMin: 15 * H })], 1 * H);
  check("a costed phase can still slip, and says how late", p.status, "slipping");
  check(
    "slipping sentence, scoped: no date repeated, and the rate that would hit it",
    paceSentence(p),
    "1h of the 15h due by “outline” on Aug 20. At 3h/wk this lands about 3 weeks late — move the date, or go 6.8h/wk.",
  );
  check(
    "the rate that hits it is against the phase, not the project",
    p.rateToHitMin,
    Math.ceil(14 * H / p.weeksAvailable),
  );
}

check(
  "a hard date is something to solve, not to move",
  paceSentence(run([project({ deadlineDate: day("2026-08-20") })], [], 1 * H)).includes("needs"),
  true,
);

// ---------------------------------------------------------- unmeasurable text

check(
  "unmeasurable says which inputs are missing",
  paceSentence(run([project({ effortEstimateMin: null, deadlineDate: null })], [])),
  "Pace unknown — needs estimate and date to be measurable.",
);

// ------------------------------------------------- logged-minutes attribution

check(
  "task hours are attributed through the task's project, anchors to nothing",
  loggedMinutesByCommitment(
    [
      { subject_type: "research", subject_id: "p1", start_min: 540, end_min: 660, minutes_done: null },
      { subject_type: "task", subject_id: "task-a", start_min: 540, end_min: 600, minutes_done: 30 },
      { subject_type: "anchor", subject_id: "r1", start_min: 540, end_min: 600, minutes_done: null },
      { subject_type: "task", subject_id: "orphan", start_min: 540, end_min: 600, minutes_done: null },
    ],
    [{ id: "task-a", project_id: "p1" }, { id: "orphan", project_id: null }],
  ),
  { p1: 150 },
);

// ------------------------------------------------------------- the real shape
// NASA ROSES as it actually stands: 80h at 3h/wk, a notice of intent on Aug 20
// and the submission on Oct 30. The whole point of the change.

{
  const roses = [
    target({ title: "NASA ROSES NOFO / notice of intent", date: day("2026-08-20"), effortEstimateMin: 4 * H }),
    target({ title: "NASA ROSES full proposal submission", date: day("2026-10-30"), effortEstimateMin: 76 * H }),
  ];
  const before = run([project({ title: "NASA ROSES Atmosphere" })], roses.map((t) => ({ ...t, effortEstimateMin: null })), 1 * H);
  check("before hours: the notice of intent reports the whole proposal as due", before.scopeMin, 80 * H);
  check("before hours: and therefore slipping", before.status, "slipping");

  const after = run([project({ title: "NASA ROSES Atmosphere" })], roses, 1 * H);
  check("after hours: only the notice of intent is due by Aug 20", after.scopeMin, 4 * H);
  check("after hours: not a crisis", after.status, "ahead");
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
