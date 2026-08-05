// How wrong are this account's estimates, and in which direction?
//
// The app records both halves of the planning fallacy without ever comparing
// them: a task carries the duration someone estimated, and progress_log carries
// what was actually worked. Finished work therefore contains the correction
// factor for future estimates, and it is specific to this person and this kind
// of work — which is the only reason to prefer it over a generic "add 50%".
//
// Deliberately NOT applied to anything automatically. An estimate someone chose
// is information too, and silently storing a different number than the one they
// typed makes every later comparison meaningless. The factor is reported, and
// the chat proposes corrected figures out loud.

/** Below this many finished samples the median is noise, and a confident-looking
 * factor drawn from two tasks is worse than saying nothing. */
const MIN_SAMPLES = 4;

/** Only recent work: an estimate corrected against how someone worked a year ago
 * describes a different person. */
const MAX_SAMPLES = 20;

export interface Calibration {
  /** actual ÷ estimated, median over recent finished work. >1 = estimates run
   * short. Null until there are enough samples to mean anything. */
  factor: number | null;
  sampleCount: number;
  /** Ready to quote at someone, or null when there isn't enough to say. */
  summary: string | null;
}

export interface FinishedWork {
  estimateMin: number;
  actualMin: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The median ratio, using the median rather than the mean so one abandoned task
 * that logged 15 minutes against an 8-hour estimate doesn't swing it. */
export function computeCalibration(finished: FinishedWork[]): Calibration {
  const ratios = finished
    .filter((f) => f.estimateMin > 0 && f.actualMin > 0)
    .slice(-MAX_SAMPLES)
    .map((f) => f.actualMin / f.estimateMin);

  if (ratios.length < MIN_SAMPLES) {
    return {
      factor: null,
      sampleCount: ratios.length,
      summary: null,
    };
  }
  const factor = +median(ratios).toFixed(2);
  const pct = Math.abs(Math.round((factor - 1) * 100));
  const direction =
    factor > 1.1
      ? `run about ${pct}% short — work takes ${factor}× as long as you expect`
      : factor < 0.9
        ? `run about ${pct}% long — work takes ${factor}× as long as you expect`
        : "are close to accurate";
  return {
    factor,
    sampleCount: ratios.length,
    summary: `Estimates ${direction} (median over ${ratios.length} finished piece${ratios.length > 1 ? "s" : ""} of work).`,
  };
}

/** Apply the correction to a proposed estimate. Rounded to a quarter hour, since
 * a corrected figure is an approximation and shouldn't pretend otherwise. */
export function correctEstimate(min: number, factor: number | null): number {
  if (!factor) return min;
  return Math.max(15, Math.round((min * factor) / 15) * 15);
}

/** Where a commitment is really heading, from how much of it is done.
 *
 * Uses PHASES rather than hours, because projecting hours from hours is
 * circular: logging 40 of an estimated 120 hours tells you nothing about whether
 * 120 was right. Two of four phases done for 40 hours does — it implies about 80
 * in total, and the gap against the estimate is the news. */
export function projectTotalMin(
  loggedMin: number,
  targetsTotal: number,
  targetsComplete: number,
): number | null {
  if (targetsTotal < 2 || targetsComplete < 1 || loggedMin <= 0) return null;
  if (targetsComplete >= targetsTotal) return loggedMin;
  return Math.round(loggedMin / (targetsComplete / targetsTotal));
}
