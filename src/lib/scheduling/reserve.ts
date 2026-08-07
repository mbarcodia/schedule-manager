// The gap between the hours a week HAS and the hours it can actually be asked
// to hold.
//
// Every capacity figure in the app was gross: the week opens 40 hours, so 40
// hours is what the plan was measured against. Nobody's week works that way.
// Meetings land in it that aren't on it yet, and some of it has to stay empty or
// the first unplanned thing costs you work you'd counted on. Both were written
// down as standing rules, which meant they held exactly as long as the chat was
// doing the arithmetic — the week view, the pace sentence and the feasibility
// answer all went on using the gross number.
//
// Two assumptions, doing two different jobs (see migration 0040):
//
//   EXPECTED MEETINGS is a forecast that decays as reality arrives. Only the
//   part not already booked is held back, so it stops mattering exactly when the
//   real meetings turn up and never charges you twice for the same hour.
//
//   MISC RESERVE is a floor that always stands. Nothing consumes it visibly,
//   which is why it has to be taken off the top rather than noticed missing.
//
// Advisory throughout: nothing here is fed to the engine, which will still fill
// a week to the brim. What it changes is what the app says about that week.

/** Both in minutes per week. Zero = no assumption, and everything here then
 * returns the gross figures unchanged. */
export interface WeeklyReserve {
  expectedMeetingMin: number;
  miscMin: number;
}

export const NO_RESERVE: WeeklyReserve = { expectedMeetingMin: 0, miscMin: 0 };

export const hasReserve = (r: WeeklyReserve): boolean => r.expectedMeetingMin > 0 || r.miscMin > 0;

/** What to hold back from a week that already has `meetingsMin` of meetings on
 * it. The forecast covers only the meetings still to come; the floor stands
 * whatever the week looks like. */
export function reservedMinForWeek(reserve: WeeklyReserve, meetingsMin: number): number {
  return Math.max(0, reserve.expectedMeetingMin - meetingsMin) + reserve.miscMin;
}

export interface BookableInputs {
  /** Working minutes the week's hours open up. */
  capacityMin: number;
  /** Meetings already on it, inside those hours. */
  meetingsMin: number;
  /** Standing weekly slots, which are not flexible work either. */
  routinesMin: number;
  reserve: WeeklyReserve;
}

/** Minutes of that week genuinely available for flexible work — the number a
 * plan should be measured against. Never negative: a week whose meetings already
 * exceed its hours has no room, which is a complete answer. */
export function bookableMinForWeek({ capacityMin, meetingsMin, routinesMin, reserve }: BookableInputs): number {
  return Math.max(0, capacityMin - meetingsMin - routinesMin - reservedMinForWeek(reserve, meetingsMin));
}

/** The same for a NORMAL week rather than a particular one — the denominator for
 * a forward-looking question ("can I take this on?"), where the week in question
 * has no meetings on it yet and its emptiness means nothing.
 *
 * Routines are counted from the rules rather than from placed blocks for the
 * same reason: this is about a week nobody has planned yet. Mon-Fri only,
 * matching the days the engine places routines on. */
export function typicalBookableWeekMin(
  weeklyHours: Record<number, { start: number; end: number } | null>,
  routines: { days: number[]; length: number }[],
  reserve: WeeklyReserve,
): number {
  let capacityMin = 0;
  for (let d = 0; d < 7; d++) {
    const win = weeklyHours[d] ?? null;
    if (win) capacityMin += win.end - win.start;
  }
  const routinesMin = routines.reduce(
    (sum, r) => sum + r.length * r.days.filter((d) => d >= 0 && d <= 4 && (weeklyHours[d] ?? null) != null).length,
    0,
  );
  // No meetings booked on a hypothetical week, so the forecast applies in full —
  // which is the entire point of holding one.
  return bookableMinForWeek({ capacityMin, meetingsMin: 0, routinesMin, reserve });
}

/** How the reserve is made up, for a UI that has to explain a number rather than
 * just show it. Null when nothing is reserved. */
export function reserveBreakdown(
  reserve: WeeklyReserve,
  meetingsMin: number,
): { totalMin: number; meetingForecastMin: number; miscMin: number } | null {
  if (!hasReserve(reserve)) return null;
  const meetingForecastMin = Math.max(0, reserve.expectedMeetingMin - meetingsMin);
  return { totalMin: meetingForecastMin + reserve.miscMin, meetingForecastMin, miscMin: reserve.miscMin };
}
