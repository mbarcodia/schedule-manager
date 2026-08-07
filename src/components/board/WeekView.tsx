"use client";

// The week as a whole: where the time went, and whether it matched what you said
// you wanted from it.
//
// Every other view answers a per-item question — is this task late, is this
// commitment keeping up. None of them answered the weekly one, which is the
// question a research week actually turns on: did the work that matters get its
// share, or did meetings eat it.
//
// It shows three numbers per label rather than one, because they fail
// differently. TARGET vs BOOKED is a capacity problem: the week could not hold
// what you asked of it, and the fix is fewer hours asked or a clearer week.
// BOOKED vs DONE is a follow-through problem: the time was there and the work
// didn't happen. A single "hours this week" figure hides which one you have.

import { useMemo, useState } from "react";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { buildWeekReview, cumulativeTarget, type WeekReview } from "@/lib/scheduling/week-review";
import { startOfWeekMonday } from "@/lib/scheduling/time";
import type { UseScheduleDataResult } from "@/hooks/useScheduleData";

const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

const hrs = (min: number) => `${+(min / 60).toFixed(min % 60 === 0 ? 0 : 1)}h`;

function Tile({
  label,
  value,
  hint,
  color,
}: {
  label: string;
  value: string;
  hint?: string;
  color?: string;
}) {
  return (
    <div className="flex-1 min-w-[110px] rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="text-[10px] tracking-wide uppercase text-muted-2">{label}</div>
      <div className="mt-0.5 text-[19px] leading-tight" style={{ color: color ?? "var(--color-text)" }}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[10px] text-muted-2 leading-snug">{hint}</div>}
    </div>
  );
}

export function WeekView({ scheduleData }: { scheduleData: UseScheduleDataResult }) {
  const { data, schedule } = scheduleData;
  const [offset, setOffset] = useState(0);
  const now = useMemo(() => new Date(), []);

  const review: WeekReview | null = useMemo(() => {
    if (!data || !schedule) return null;
    return buildWeekReview({
      schedule,
      projects: data.projects,
      categories: data.categories,
      weeklyHours: data.inputs.weeklyHours,
      dayOverrides: data.inputs.dayOverrides,
      allDayBlocks: data.inputs.allDayBlocks,
      logged: data.progressFacts.logged,
      weekStart: startOfWeekMonday(now),
      offset,
      reserve: data.reserve,
    });
  }, [data, schedule, now, offset]);

  if (!data || !schedule || !review) return <div className="px-5 py-4 text-[12px] text-muted">Loading…</div>;

  const weekStart = new Date(startOfWeekMonday(now).getTime() + offset * 7 * 86400000);
  const weekEnd = new Date(weekStart.getTime() + 6 * 86400000);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  // The target line is drawn for whichever label carries a share target, since
  // that is the only weekly figure the account has actually committed to.
  const targeted = review.byLabel.find((l) => l.targetMin != null);
  const targetLine = targeted?.targetMin != null ? cumulativeTarget(review, targeted.targetMin) : null;
  const chartMax = Math.max(
    60,
    ...review.byDay.map((d) => d.bookedMin),
    ...(targetLine ? [targetLine[targetLine.length - 1] / 2] : []),
  );

  const label =
    offset === 0 ? "This week" : offset === -1 ? "Last week" : offset === 1 ? "Next week" : `${fmt(weekStart)}`;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOffset(offset - 1)}
          className="rounded-md border border-border w-[26px] h-[26px] flex items-center justify-center text-muted hover:text-text"
          title="Previous week"
        >
          <CaretLeftIcon size={12} />
        </button>
        <div className="text-[12px] text-text">
          {label} <span className="text-muted-2">· {fmt(weekStart)}–{fmt(weekEnd)}</span>
        </div>
        <button
          onClick={() => setOffset(offset + 1)}
          className="rounded-md border border-border w-[26px] h-[26px] flex items-center justify-center text-muted hover:text-text"
          title="Next week"
        >
          <CaretRightIcon size={12} />
        </button>
        {offset !== 0 && (
          <button onClick={() => setOffset(0)} className="text-[10.5px] text-accent-text hover:underline">
            back to this week
          </button>
        )}
      </div>

      {/* Said once, plainly: a past week is a record. Nothing back there is
         re-derived from today's rules, so it carries no targets. */}
      {review.isPast && (
        <div className="text-[10.5px] text-muted-2">
          A past week is a record of what was worked — it carries no targets, and nothing here is re-planned.
        </div>
      )}

      {/* A week with almost no capacity is the single most useful thing to say
         about it, and every figure below reads oddly without it. */}
      {!review.isPast && review.capacityMin < review.standardCapacityMin && (
        <div className="text-[10.5px] leading-snug" style={{ color: "#e0a94e" }}>
          {`This week opens ${hrs(review.capacityMin)} of its usual ${hrs(review.standardCapacityMin)} — the rest is away days or days off. Every target below is a share of what the week actually has, not of a normal one.`}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Tile
          label={review.isPast ? "Worked" : "Work booked"}
          value={hrs(review.isPast ? review.workDoneMin : review.workBookedMin)}
          hint={
            review.isPast
              ? "ticked off"
              : review.workDoneMin > 0
                ? `${hrs(review.workDoneMin)} done so far`
                : "nothing ticked off yet"
          }
        />
        <Tile
          label="Meetings"
          value={hrs(review.meetingsMin)}
          hint={
            review.outOfHoursMeetingsMin > 0
              ? `plus ${hrs(review.outOfHoursMeetingsMin)} outside your hours`
              : "held slots, yours and others'"
          }
        />
        <Tile label="Routines" value={hrs(review.routinesMin)} hint="standing weekly slots" />
        {/* With a reserve set, "unbooked" is the wrong headline: what matters is
           how much of the week could honestly still be asked for, which is that
           figure minus what is being held back. Without one, nothing changes. */}
        {review.reservedMin > 0 ? (
          <Tile
            label="Room left"
            value={hrs(Math.max(0, review.bookableMin - review.workBookedMin))}
            hint={`${hrs(review.reservedMin)} held back${review.reservedForMeetingsMin > 0 ? ` (${hrs(review.reservedForMeetingsMin)} for meetings still to land)` : ""}`}
            color={review.overBookedMin > 0 ? "#e0a94e" : undefined}
          />
        ) : (
          <Tile
            label="Unbooked"
            value={hrs(review.freeMin)}
            hint={`of ${hrs(review.capacityMin)} the week opens`}
            color={review.freeMin === 0 ? "#e0a94e" : undefined}
          />
        )}
      </div>

      {/* Nothing was refused — the engine doesn't read the reserve — so this is
         news about the week rather than a scheduling failure, and it says which
         of the two numbers it has eaten into. */}
      {review.overBookedMin > 0 && (
        <div className="text-[10.5px] leading-snug" style={{ color: "#e0a94e" }}>
          {`This week books ${hrs(review.workBookedMin)} of work against the ${hrs(review.bookableMin)} it can honestly hold — ${hrs(review.overBookedMin)} of that comes out of the ${hrs(review.reservedMin)} you keep for meetings and the unplanned. It is still scheduled; it just isn't free time.`}
        </div>
      )}

      <div className="rounded-lg border border-border bg-panel p-3">
        <div className="text-[10px] tracking-wide uppercase text-muted-2 font-medium pb-2">
          By label{review.isPast ? "" : " — target, booked, done"}
        </div>
        {review.byLabel.length === 0 ? (
          <div className="text-[10.5px] text-muted-2">Nothing scheduled or logged this week.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {review.byLabel.map((l) => {
              const scale = Math.max(l.targetMin ?? 0, l.bookedMin, l.doneMin, 60);
              const pct = (min: number) => `${Math.min(100, (min / scale) * 100)}%`;
              const short = l.targetMin != null && l.bookedMin < l.targetMin;
              return (
                <div key={l.labelId ?? "none"} className="flex items-center gap-3">
                  <div className="w-[110px] flex-none min-w-0">
                    <div className="text-[11.5px] text-text truncate" title={l.label}>
                      {l.label}
                    </div>
                    {l.targetMin != null && (
                      <div className="text-[9.5px]" style={{ color: short ? "#e0a94e" : "var(--color-muted-2)" }}>
                        target {hrs(l.targetMin)}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    {/* Booked as the bar, done as a solid fill inside it — the
                       gap between them is the follow-through, and it should be
                       readable without comparing two separate bars. */}
                    <div className="relative h-3 rounded bg-surface overflow-hidden">
                      <div
                        className="absolute inset-y-0 left-0 rounded"
                        style={{ width: pct(l.bookedMin), background: l.color ?? "#5b5f75", opacity: 0.35 }}
                      />
                      <div
                        className="absolute inset-y-0 left-0 rounded"
                        style={{ width: pct(l.doneMin), background: l.color ?? "#9184d9" }}
                      />
                      {l.targetMin != null && (
                        <div
                          className="absolute inset-y-0"
                          style={{ left: pct(l.targetMin), width: 2, background: "#e9e9ed", opacity: 0.65 }}
                          title={`target ${hrs(l.targetMin)}`}
                        />
                      )}
                    </div>
                  </div>
                  <div className="w-[92px] flex-none text-right text-[10.5px] text-muted-2 tabular-nums">
                    {hrs(l.doneMin)} / {hrs(l.bookedMin)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {/* A shortfall has two quite different causes and they need opposite
           fixes, so the line has to say WHICH. If the hours the engine set out to
           place were themselves below the share, the week's room is irrelevant —
           the per-commitment figures don't divide into usable blocks. Only when
           it asked for the full share and still came up short is it capacity. */}
        {!review.isPast && targeted?.targetMin != null && targeted.bookedMin < targeted.targetMin && (
          <div className="pt-2 text-[10px] leading-snug" style={{ color: "#e0a94e" }}>
            {targeted.askedMin != null && targeted.askedMin < targeted.targetMin
              ? `${targeted.label}'s share of this week is ${hrs(targeted.targetMin)}, but its commitments' hours only divide into ${hrs(targeted.askedMin)} of whole blocks — each is rounded to a length no shorter than the label's minimum chunk, and those roundings don't cancel out. ${
                  targeted.belowFloor.length
                    ? `${targeted.belowFloor.join(" and ")} get${targeted.belowFloor.length > 1 ? "" : "s"} nothing this week: ${targeted.belowFloor.length > 1 ? "their shares are" : "its share is"} shorter than that minimum. Raise ${targeted.belowFloor.length > 1 ? "their" : "its"} weekly hours, or lower the label's minimum chunk.`
                    : "Nudging one commitment's weekly hours up would close it."
                } The week has ${hrs(review.freeMin)} unbooked, so this is not a room problem.`
              : `${targeted.label} is ${hrs(targeted.targetMin - targeted.bookedMin)} short of its target and the week is full — the fix is a smaller ask or a clearer week, not more effort.`}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border bg-panel p-3">
        <div className="text-[10px] tracking-wide uppercase text-muted-2 font-medium pb-2">Day by day</div>
        <div className="flex items-end gap-2 h-[120px]">
          {review.byDay.map((d, i) => {
            const height = (min: number) => `${Math.min(100, (min / chartMax) * 100)}%`;
            const off = d.windowMin === 0;
            return (
              <div key={d.gday} className="flex-1 flex flex-col items-center gap-1 h-full">
                <div className="flex-1 w-full relative flex items-end">
                  <div
                    className="w-full rounded-t"
                    style={{ height: height(d.bookedMin), background: "rgba(145,132,217,0.32)" }}
                    title={`${hrs(d.bookedMin)} booked`}
                  />
                  <div
                    className="absolute bottom-0 w-full rounded-t"
                    style={{ height: height(d.doneMin), background: "#9184d9" }}
                    title={`${hrs(d.doneMin)} done`}
                  />
                  {targetLine && (
                    <div
                      className="absolute w-full"
                      style={{ bottom: height(targetLine[i]), height: 1, background: "rgba(233,233,237,0.4)" }}
                      title={`${hrs(targetLine[i])} by end of day, to stay on target`}
                    />
                  )}
                </div>
                <div className="text-[9.5px]" style={{ color: off ? "var(--color-muted-2)" : "var(--color-muted)" }}>
                  {DAY_LABELS[d.dow]}
                </div>
              </div>
            );
          })}
        </div>
        <div className="pt-1.5 text-[9.5px] text-muted-2">
          {review.workBookedMin === 0
            ? review.capacityMin === 0
              ? "Nothing opens this week — every day is off or marked away."
              : "No work is booked this week."
            : `Solid is ticked off, faint is booked${targetLine ? "; the line is where the week's target would have you by the end of each day, spread over the days that are actually open" : ""}.`}
        </div>
      </div>
    </div>
  );
}
