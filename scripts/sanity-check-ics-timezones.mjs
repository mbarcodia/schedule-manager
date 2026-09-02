// Proves an ICS feed parses to the same instants no matter what timezone the
// machine doing the parsing is in
// (run: npx tsx scripts/sanity-check-ics-timezones.mjs).
//
// THE BUG THIS PINS
//
// Outlook publishes its calendar with `TZID:Customized Time Zone`, a name no
// zone database knows. node-ical answers an unresolvable TZID with
// `moment.tz.guess()` — the SERVER's timezone — so on Vercel (UTC) every
// meeting on that feed was stored four hours early. All of them. For weeks. The
// booking link then offered those hours to strangers, who booked on top of real
// meetings.
//
// It survived every test and every day of local use because a laptop in Miami
// makes that same fallback accidentally correct. That is the property this file
// exists to destroy: **a timezone bug must never again be invisible from the
// place the code is written.** So every fixture is parsed under five very
// different process timezones, and the instants must come out identical.
//
// Identical is necessary but not sufficient — consistently wrong is still
// wrong — so each fixture also asserts its exact expected UTC instant, computed
// by hand from the offset the feed declares.
//
// Two independent process-timezone leaks are covered, because there were two:
//   1. TZID resolution (tzid.ts) — the four-hour shift itself.
//   2. Recurrence expansion (ics.ts) — rrule.js returns occurrences shifted by
//      the process's offset, which put a weekly meeting on the wrong DAY in
//      Tokyo and was right on Vercel only because Vercel happens to be UTC.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseIcsFeed } from "../src/lib/calendar-sync/ics.ts";
import { assertZonesArePinned, prepareIcs, resolveTzid, parseVtimezones, unfoldIcs } from "../src/lib/calendar-sync/tzid.ts";

/** The account's timezone in every fixture below — the owner is in Miami. */
const ACCOUNT_TZ = "America/New_York";

/** Process timezones to parse under. UTC is Vercel and the Fly relay; New_York
 * is the laptop this was written on (where the bug hid); Los_Angeles is west of
 * the account; Tokyo is far east, which is what turned a weekly meeting's DAY;
 * Kiritimati is UTC+14, the largest offset there is. */
const PROBE_TZS = ["UTC", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Pacific/Kiritimati"];

const vtimezone = (tzid, arms) =>
  ["BEGIN:VTIMEZONE", `TZID:${tzid}`, ...arms, "END:VTIMEZONE"].join("\n");

/** US Eastern rules, exactly as Outlook writes them under its opaque name. */
const EASTERN_ARMS = [
  "BEGIN:STANDARD",
  "DTSTART:16010101T020000",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:16010101T020000",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3",
  "END:DAYLIGHT",
];

/** Southern hemisphere, where DST runs October to April — the direction a
 * northern-hemisphere assumption in the rule reader would get backwards. */
const SYDNEY_ARMS = [
  "BEGIN:STANDARD",
  "DTSTART:16010101T030000",
  "TZOFFSETFROM:+1100",
  "TZOFFSETTO:+1000",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=4",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:16010101T020000",
  "TZOFFSETFROM:+1000",
  "TZOFFSETTO:+1100",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=10",
  "END:DAYLIGHT",
];

const PACIFIC_ARMS = [
  "BEGIN:STANDARD",
  "DTSTART:16010101T020000",
  "TZOFFSETFROM:-0700",
  "TZOFFSETTO:-0800",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:16010101T020000",
  "TZOFFSETFROM:-0800",
  "TZOFFSETTO:-0700",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3",
  "END:DAYLIGHT",
];

/** No DST at all, and a half-hour offset — the shape that breaks code assuming
 * whole hours or assuming two arms. */
const INDIA_ARMS = ["BEGIN:STANDARD", "DTSTART:16010101T000000", "TZOFFSETFROM:+0530", "TZOFFSETTO:+0530", "END:STANDARD"];

const feed = (...parts) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...parts, "END:VCALENDAR"].join("\n");
const event = (lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\n");

/** Each fixture: the feed text, and the exact instants it must produce. */
const FIXTURES = {
  // The real-world case. An opaque TZID whose meaning is only in its VTIMEZONE.
  outlookCustomZone: {
    text: feed(
      vtimezone("Customized Time Zone", EASTERN_ARMS),
      event([
        "UID:one-off@t",
        "SUMMARY:One off",
        "DTSTART;TZID=Customized Time Zone:20260909T100000",
        "DTEND;TZID=Customized Time Zone:20260909T110000",
      ]),
    ),
    // 10:00 Eastern in September is EDT, UTC-4.
    expect: [["One off", "2026-09-09T14:00:00.000Z", "2026-09-09T15:00:00.000Z"]],
  },

  // Recurrence: the wall clock is fixed, so the INSTANT must move when DST does.
  // Also covers EXDATE (a cancelled occurrence) and a RECURRENCE-ID override
  // (one moved occurrence), both of which have to line up with the expansion.
  recurrenceAcrossDst: {
    text: feed(
      vtimezone("Customized Time Zone", EASTERN_ARMS),
      event([
        "UID:weekly@t",
        "SUMMARY:Weekly",
        "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;UNTIL=20261116T200000Z",
        "EXDATE;TZID=Customized Time Zone:20260824T150000",
        "DTSTART;TZID=Customized Time Zone:20260817T150000",
        "DTEND;TZID=Customized Time Zone:20260817T160000",
      ]),
      event([
        "UID:weekly@t",
        "SUMMARY:Weekly (moved)",
        "RECURRENCE-ID;TZID=Customized Time Zone:20260831T150000",
        "DTSTART;TZID=Customized Time Zone:20260901T150000",
        "DTEND;TZID=Customized Time Zone:20260901T160000",
      ]),
    ),
    expect: [
      ["Weekly", "2026-08-17T19:00:00.000Z", "2026-08-17T20:00:00.000Z"], // EDT
      // 24 Aug is EXDATE'd — its absence is the assertion.
      ["Weekly (moved)", "2026-09-01T19:00:00.000Z", "2026-09-01T20:00:00.000Z"], // 31 Aug, moved
      ["Weekly", "2026-09-07T19:00:00.000Z", "2026-09-07T20:00:00.000Z"],
      ["Weekly", "2026-09-14T19:00:00.000Z", "2026-09-14T20:00:00.000Z"],
      ["Weekly", "2026-09-21T19:00:00.000Z", "2026-09-21T20:00:00.000Z"],
      ["Weekly", "2026-09-28T19:00:00.000Z", "2026-09-28T20:00:00.000Z"],
      ["Weekly", "2026-10-05T19:00:00.000Z", "2026-10-05T20:00:00.000Z"],
      ["Weekly", "2026-10-12T19:00:00.000Z", "2026-10-12T20:00:00.000Z"],
      ["Weekly", "2026-10-19T19:00:00.000Z", "2026-10-19T20:00:00.000Z"],
      ["Weekly", "2026-10-26T19:00:00.000Z", "2026-10-26T20:00:00.000Z"],
      // DST ends 1 Nov 2026: same 3pm, an hour later in UTC.
      ["Weekly", "2026-11-02T20:00:00.000Z", "2026-11-02T21:00:00.000Z"],
      ["Weekly", "2026-11-09T20:00:00.000Z", "2026-11-09T21:00:00.000Z"],
      ["Weekly", "2026-11-16T20:00:00.000Z", "2026-11-16T21:00:00.000Z"],
    ],
  },

  // A Windows zone name that DOES define itself. The feed's own rules win, so
  // this does not depend on any name table being present.
  windowsNameWithVtimezone: {
    text: feed(
      vtimezone("Pacific Standard Time", PACIFIC_ARMS),
      event([
        "UID:pst@t",
        "SUMMARY:Pacific",
        "DTSTART;TZID=Pacific Standard Time:20260601T080000",
        "DTEND;TZID=Pacific Standard Time:20260601T090000",
      ]),
    ),
    // 08:00 Pacific in June is PDT, UTC-7.
    expect: [["Pacific", "2026-06-01T15:00:00.000Z", "2026-06-01T16:00:00.000Z"]],
  },

  // A Windows name with NO VTIMEZONE — nothing in the feed defines it, so this
  // is the CLDR name table's job.
  windowsNameNoVtimezone: {
    text: feed(
      event([
        "UID:cst@t",
        "SUMMARY:Central",
        "DTSTART;TZID=Central Standard Time:20260601T090000",
        "DTEND;TZID=Central Standard Time:20260601T100000",
      ]),
    ),
    // 09:00 Central in June is CDT, UTC-5.
    expect: [["Central", "2026-06-01T14:00:00.000Z", "2026-06-01T15:00:00.000Z"]],
  },

  // Nothing anywhere says what this zone is. The account's zone is the floor —
  // and the point is that it is a fact about the USER, not about the server.
  unknownZone: {
    text: feed(
      event([
        "UID:junk@t",
        "SUMMARY:Mystery",
        "DTSTART;TZID=Totally Made Up Zone:20260601T090000",
        "DTEND;TZID=Totally Made Up Zone:20260601T100000",
      ]),
    ),
    expect: [["Mystery", "2026-06-01T13:00:00.000Z", "2026-06-01T14:00:00.000Z"]],
  },

  // A floating time: no TZID, no "Z". RFC 5545 says "local time wherever it is
  // read", which on a server is a coin toss. Read as the account's zone.
  floatingTime: {
    text: feed(
      event(["UID:float@t", "SUMMARY:Floating", "DTSTART:20260601T090000", "DTEND:20260601T100000"]),
    ),
    expect: [["Floating", "2026-06-01T13:00:00.000Z", "2026-06-01T14:00:00.000Z"]],
  },

  // Already unambiguous. Must pass through untouched.
  explicitUtc: {
    text: feed(
      event(["UID:utc@t", "SUMMARY:Utc", "DTSTART:20260601T090000Z", "DTEND:20260601T100000Z"]),
    ),
    expect: [["Utc", "2026-06-01T09:00:00.000Z", "2026-06-01T10:00:00.000Z"]],
  },

  // Half-hour offset, no DST, a single VTIMEZONE arm.
  halfHourNoDst: {
    text: feed(
      vtimezone("Bespoke Subcontinent", INDIA_ARMS),
      event([
        "UID:ist@t",
        "SUMMARY:Half hour",
        "DTSTART;TZID=Bespoke Subcontinent:20260601T090000",
        "DTEND;TZID=Bespoke Subcontinent:20260601T100000",
      ]),
    ),
    expect: [["Half hour", "2026-06-01T03:30:00.000Z", "2026-06-01T04:30:00.000Z"]],
  },

  // Southern hemisphere: June is WINTER (standard time), January is summer.
  southernHemisphere: {
    text: feed(
      vtimezone("Down Under Custom", SYDNEY_ARMS),
      event([
        "UID:syd-jun@t",
        "SUMMARY:Sydney winter",
        "DTSTART;TZID=Down Under Custom:20260601T090000",
        "DTEND;TZID=Down Under Custom:20260601T100000",
      ]),
      event([
        "UID:syd-jan@t",
        "SUMMARY:Sydney summer",
        "DTSTART;TZID=Down Under Custom:20260115T090000",
        "DTEND;TZID=Down Under Custom:20260115T100000",
      ]),
    ),
    expect: [
      ["Sydney summer", "2026-01-14T22:00:00.000Z", "2026-01-14T23:00:00.000Z"], // +11 AEDT
      ["Sydney winter", "2026-05-31T23:00:00.000Z", "2026-06-01T00:00:00.000Z"], // +10 AEST
    ],
  },

  // An all-day banner, which has no time at all and must land on the account's
  // midnight rather than the server's.
  allDay: {
    text: feed(
      event(["UID:allday@t", "SUMMARY:Away", "DTSTART;VALUE=DATE:20260601", "DTEND;VALUE=DATE:20260602"]),
    ),
    includeAllDay: true,
    expect: [["Away", "2026-06-01T04:00:00.000Z", "2026-06-02T04:00:00.000Z"]],
  },
};

const HORIZON_START = new Date("2025-12-01T00:00:00Z");
const HORIZON_END = new Date("2027-01-31T00:00:00Z");

/** What one fixture parses to, as comparable plain data. */
async function runFixture(name) {
  const f = FIXTURES[name];
  const { events } = await parseIcsFeed(f.text, HORIZON_START, HORIZON_END, f.includeAllDay ?? false, ACCOUNT_TZ);
  return events
    .map((e) => [e.title, e.startsAt.toISOString(), e.endsAt.toISOString()])
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Child mode: parse every fixture under this process's timezone, print JSON.
// ---------------------------------------------------------------------------
if (process.env.ICS_TZ_PROBE) {
  const out = {};
  for (const name of Object.keys(FIXTURES)) out[name] = await runFixture(name);
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parent mode.
// ---------------------------------------------------------------------------
let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `\n       ${detail}`}`);
}

const self = fileURLToPath(import.meta.url);

console.log(`parsing ${Object.keys(FIXTURES).length} fixtures under ${PROBE_TZS.length} process timezones\n`);

const byTz = {};
for (const tz of PROBE_TZS) {
  const run = spawnSync("npx", ["tsx", self], {
    encoding: "utf8",
    env: { ...process.env, TZ: tz, ICS_TZ_PROBE: "1" },
  });
  if (run.status !== 0) {
    failures++;
    console.log(`  FAIL parse crashed under TZ=${tz}\n${(run.stderr || "").split("\n").slice(0, 6).join("\n")}`);
    continue;
  }
  try {
    byTz[tz] = JSON.parse(run.stdout);
  } catch {
    failures++;
    console.log(`  FAIL unparseable output under TZ=${tz}: ${run.stdout.slice(0, 200)}`);
  }
}

// 1. The instants must be RIGHT — checked against hand-computed offsets, so a
//    uniformly wrong answer cannot pass by being uniform.
console.log("expected instants (TZ=UTC run):");
for (const [name, f] of Object.entries(FIXTURES)) {
  const got = byTz.UTC?.[name];
  const want = [...f.expect].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1));
  check(
    name,
    JSON.stringify(got) === JSON.stringify(want),
    `got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`,
  );
}

// 2. The instants must be IDENTICAL everywhere. This is the guardrail: it is
//    what would have caught the original bug from a laptop in Miami.
console.log("\nsame answer regardless of the server's timezone:");
for (const name of Object.keys(FIXTURES)) {
  const reference = JSON.stringify(byTz[PROBE_TZS[0]]?.[name]);
  for (const tz of PROBE_TZS.slice(1)) {
    const actual = JSON.stringify(byTz[tz]?.[name]);
    check(
      `${name} @ TZ=${tz}`,
      actual === reference,
      `TZ=${tz} disagrees with TZ=${PROBE_TZS[0]}\n       got  ${actual}\n       want ${reference}`,
    );
  }
}

// 3. The invariant must actually reject what it claims to reject. A guardrail
//    that cannot fail is not a guardrail.
console.log("\nassertZonesArePinned rejects anything a parser could misread:");
const mustThrow = [
  ["a floating DTSTART", feed(event(["UID:a@t", "DTSTART:20260601T090000", "DTEND:20260601T100000"]))],
  [
    "a TZID that is not a real zone",
    feed(event(["UID:b@t", "DTSTART;TZID=Customized Time Zone:20260601T090000", "DTEND;TZID=Customized Time Zone:20260601T100000"])),
  ],
  [
    "an unpinned EXDATE",
    feed(event(["UID:c@t", "DTSTART:20260601T090000Z", "DTEND:20260601T100000Z", "EXDATE;TZID=Nope Zone:20260608T090000"])),
  ],
  [
    "an unpinned RECURRENCE-ID",
    feed(event(["UID:d@t", "DTSTART:20260601T090000Z", "DTEND:20260601T100000Z", "RECURRENCE-ID:20260608T090000"])),
  ],
];
for (const [label, text] of mustThrow) {
  let threw = false;
  try {
    assertZonesArePinned(unfoldIcs(text));
  } catch {
    threw = true;
  }
  check(`rejects ${label}`, threw, "it was accepted — the guardrail is not guarding");
}

// And it must ACCEPT what prepareIcs produces, for every fixture, or the sync
// throws on a feed that is actually fine.
for (const [name, f] of Object.entries(FIXTURES)) {
  let error = null;
  try {
    assertZonesArePinned(prepareIcs(f.text, ACCOUNT_TZ).text);
  } catch (err) {
    error = err;
  }
  check(`accepts prepared ${name}`, error === null, error?.message);
}

// 4. Resolution is reported honestly: a guess must say it guessed, because the
//    original bug's real damage was being silent.
console.log("\nhow each zone was resolved, and whether it admits to guessing:");
const RESOLUTION_EXPECTATIONS = [
  ["outlookCustomZone", "Customized Time Zone", "derived", false, "America/New_York"],
  ["windowsNameWithVtimezone", "Pacific Standard Time", "derived", false, null],
  ["windowsNameNoVtimezone", "Central Standard Time", "windows", false, "America/Chicago"],
  ["unknownZone", "Totally Made Up Zone", "account-fallback", true, ACCOUNT_TZ],
  ["halfHourNoDst", "Bespoke Subcontinent", "derived", false, null],
  ["southernHemisphere", "Down Under Custom", "derived", false, null],
];
for (const [fixture, tzid, kind, wantsWarning, zone] of RESOLUTION_EXPECTATIONS) {
  const { resolutions } = prepareIcs(FIXTURES[fixture].text, ACCOUNT_TZ);
  const hit = resolutions.find((r) => r.tzid === tzid);
  check(`${tzid} -> ${kind}`, hit?.kind === kind, `got ${hit ? `${hit.kind} (${hit.zone})` : "no resolution"}`);
  check(
    `${tzid} ${wantsWarning ? "warns" : "is silent"}`,
    Boolean(hit?.warning) === wantsWarning,
    `warning was ${JSON.stringify(hit?.warning ?? null)}`,
  );
  if (zone) check(`${tzid} resolves to ${zone}`, hit?.zone === zone, `got ${hit?.zone}`);
}

// A feed that names a real zone but describes a different one is broken in a way
// the owner should see. The name still wins; the disagreement is reported.
{
  const contradictory = feed(
    vtimezone("America/New_York", PACIFIC_ARMS),
    event([
      "UID:lies@t",
      "SUMMARY:Contradiction",
      "DTSTART;TZID=America/New_York:20260601T090000",
      "DTEND;TZID=America/New_York:20260601T100000",
    ]),
  );
  const defs = parseVtimezones(unfoldIcs(contradictory));
  const hit = resolveTzid("America/New_York", defs, ACCOUNT_TZ, new Date("2026-06-01T00:00:00Z"));
  check("a feed contradicting its own zone name still uses the name", hit.zone === "America/New_York", `got ${hit.zone}`);
  check("...and says so", Boolean(hit.warning), "no warning was raised");
}

// 5. A quoted TZID (`TZID="Customized Time Zone"`) is legal RFC 5545 and must
//    resolve the same way — quoting is how some exporters write names with
//    spaces, and treating the quotes as part of the name loses the match.
{
  const quoted = feed(
    vtimezone("Customized Time Zone", EASTERN_ARMS),
    event([
      "UID:quoted@t",
      "SUMMARY:Quoted",
      'DTSTART;TZID="Customized Time Zone":20260909T100000',
      'DTEND;TZID="Customized Time Zone":20260909T110000',
    ]),
  );
  const { events } = await parseIcsFeed(quoted, HORIZON_START, HORIZON_END, false, ACCOUNT_TZ);
  check(
    "a quoted TZID resolves like an unquoted one",
    events[0]?.startsAt.toISOString() === "2026-09-09T14:00:00.000Z",
    `got ${events[0]?.startsAt.toISOString()}`,
  );
}

// 6. Folded lines. RFC 5545 wraps long content lines and continues them with a
//    leading space; a folded DTSTART that is not unfolded first matches no
//    pattern here and would sail past every check above.
{
  const folded = feed(
    vtimezone("Customized Time Zone", EASTERN_ARMS),
    ["BEGIN:VEVENT", "UID:folded@t", "SUMMARY:Folded", "DTSTART;TZID=Customized Time\n  Zone:20260909T100000", "DTEND;TZID=Customized Time Zone:20260909T110000", "END:VEVENT"].join("\n"),
  ).replace(/\n/g, "\r\n");
  const { events } = await parseIcsFeed(folded, HORIZON_START, HORIZON_END, false, ACCOUNT_TZ);
  check(
    "a folded TZID parameter is unfolded before resolving",
    events[0]?.startsAt.toISOString() === "2026-09-09T14:00:00.000Z",
    `got ${events[0]?.startsAt.toISOString()}`,
  );
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall ICS timezone checks passed");
process.exit(failures ? 1 : 0);
