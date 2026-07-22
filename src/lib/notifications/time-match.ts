// Vercel Cron can only run a given job once/day, so per-user local-time
// delivery is done via 24 hourly cron entries per notification type (see
// vercel.json), each passing its own UTC hour as ?hour=N. This derives which
// UTC hour a user's chosen local time (minutes-of-day, profiles.eod_checkin_time
// etc.) falls into *today*, so a cron invocation can check "is it my hour."
//
// The offset is computed live via Intl rather than a static IANA table, so it
// tracks DST transitions and non-hour offsets (e.g. India's +5:30) correctly.
export function targetUtcHour(timeZone: string, minutesOfDay: number, now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(now);
  const offsetStr = parts.find((p) => p.type === "timeZoneName")!.value; // "GMT-5", "GMT+5:30"
  const m = /GMT([+-])(\d+)(?::(\d+))?/.exec(offsetStr)!;
  const sign = m[1] === "-" ? -1 : 1;
  const offsetMinutes = sign * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0));

  const utcMinutesOfDay = (((minutesOfDay - offsetMinutes) % 1440) + 1440) % 1440;
  return Math.floor(utcMinutesOfDay / 60);
}
