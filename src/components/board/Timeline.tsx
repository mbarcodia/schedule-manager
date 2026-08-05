"use client";

// Months-long horizontal timeline over projects.
//
// A project earns a bar if it has any date to draw toward — its own deadline
// or a target inside it — and the bar runs from today to the furthest of those.
// Targets sit on the bar as markers, hollow until they're hit, which is the
// whole point of having them: a project with no deadline but three interim
// dates is exactly the thing that used to be invisible here.
//
// Projects with no dates at all can't be placed on a date scale, so they get
// their own lane above it. Risk colouring reuses the same chip heuristic the
// chat panel shows rather than reimplementing it.

import { useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { computeTrackableChips, type TrackableChip } from "@/lib/scheduling/trackables";
import { paceFromData } from "@/lib/scheduling/pace";
import type { UseScheduleDataResult } from "@/hooks/useScheduleData";
import type { Target } from "@/lib/scheduling/types";

const MONTHS_SHOWN = 6;
const DAY_MS = 86400000;

export function Timeline({ scheduleData }: { scheduleData: UseScheduleDataResult }) {
  const { data, schedule, refresh } = scheduleData;
  const now = useMemo(() => new Date(), []);

  /** Ticking a target off is a one-field write with no scheduling consequences
   * — nothing re-flows, because targets never occupied any time. */
  async function toggleTarget(target: Target) {
    const supabase = createClient();
    await supabase
      .from("targets")
      .update({ completed_at: target.completedAt ? null : new Date().toISOString() })
      .eq("id", target.id);
    await refresh();
  }

  const chipsByProject = useMemo(() => {
    const map = new Map<string, TrackableChip[]>();
    if (!data || !schedule) return map;
    const pace = paceFromData(data, now);
    for (const c of computeTrackableChips(data.projects, data.inputs.tasks, schedule, now, data.inputs.weeklyHours, pace)) {
      map.set(c.projectId, [...(map.get(c.projectId) ?? []), c]);
    }
    return map;
  }, [data, schedule, now]);

  if (!data || !schedule) return <div className="px-5 py-4 text-[12px] text-muted">Loading…</div>;

  const spanMs = MONTHS_SHOWN * 30.4 * DAY_MS;
  const pctFor = (d: Date) => ((d.getTime() - now.getTime()) / spanMs) * 100;

  const monthTicks = Array.from({ length: MONTHS_SHOWN + 1 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    return { label: d.toLocaleDateString(undefined, { month: "short" }), pct: pctFor(d) };
  }).filter((t) => t.pct >= 0 && t.pct <= 100);

  const rows = data.projects.map((c) => {
    const targets = data.targets
      .filter((t) => t.projectId === c.id)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    const dates = [c.deadlineDate, ...targets.map((t) => t.date)].filter((d): d is Date => d != null);
    const end = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
    return { project: c, targets, end };
  });

  const dated = rows.filter((r) => r.end != null).sort((a, b) => a.end!.getTime() - b.end!.getTime());
  const undated = rows.filter((r) => r.end == null);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
      {undated.length > 0 && (
        <div className="rounded-lg border border-border bg-panel p-3">
          <div className="text-[10px] tracking-wide uppercase text-muted-2 font-medium pb-2">
            No dates — nothing to count down to
          </div>
          <div className="flex flex-wrap gap-1.5">
            {undated.map(({ project: c }) => (
              <div
                key={c.id}
                className="rounded-md border border-border bg-surface px-2.5 py-1.5 flex items-baseline gap-2"
              >
                <span className="text-[11.5px] text-text">{c.title}</span>
                <span className="text-[9px] tracking-wide uppercase text-muted-2">
                  {c.weeklyMinMin ? `${c.weeklyMinMin / 60}h/wk` : c.cadence || "untracked"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border bg-panel p-3">
        <div className="relative h-5 mb-1 ml-[180px]">
          {monthTicks.map((t) => (
            <span
              key={t.label + t.pct}
              className="absolute text-[9px] tracking-wide uppercase text-muted-2"
              style={{ left: `${t.pct}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          {dated.map(({ project: c, targets, end }) => {
            const chip = (chipsByProject.get(c.id) ?? []).find((x) => x.facet === "deadline");
            const endPct = Math.min(100, Math.max(2, pctFor(end!)));
            // Only a deadline can be overdue. A target's date passing is worth
            // seeing, but it doesn't make the whole project late.
            const overdue = c.deadlineDate != null && c.deadlineDate.getTime() < now.getTime();
            return (
              <div key={c.id} className="flex items-center gap-2">
                <div className="flex-none w-[172px] min-w-0 flex items-baseline gap-1.5">
                  {c.weeklyMinMin != null && (
                    <span className="text-[9px] tracking-wide uppercase text-muted-2 flex-none">
                      {c.weeklyMinMin / 60}h/wk
                    </span>
                  )}
                  <span className="text-[11.5px] text-text truncate" title={c.title}>
                    {c.title}
                  </span>
                </div>
                <div className="flex-1 relative h-5 rounded bg-surface overflow-hidden">
                  <div
                    className="absolute inset-y-1 left-0 rounded-r"
                    title={
                      c.deadlineDate
                        ? `${chip?.statusText ?? ""} — due ${c.deadlineDate.toLocaleDateString()}`.trim()
                        : `Last target ${end!.toLocaleDateString()} — no deadline of its own`
                    }
                    style={{
                      width: `${endPct}%`,
                      background: overdue ? "rgba(229,72,77,0.35)" : (chip?.bg ?? "#1d1f2b"),
                      border: `1px solid ${overdue ? "#e5484d" : (chip?.border ?? "rgba(233,233,237,0.16)")}`,
                    }}
                  />
                  {targets.map((t) => (
                    <TargetMarker
                      key={t.id}
                      target={t}
                      pct={Math.min(100, Math.max(0, pctFor(t.date)))}
                      now={now}
                      onToggle={() => void toggleTarget(t)}
                    />
                  ))}
                  <span
                    className="absolute top-1/2 -translate-y-1/2 text-[9px] whitespace-nowrap px-1.5"
                    style={{ left: `min(${endPct}%, calc(100% - 90px))`, color: chip?.statusColor ?? "#9397ab" }}
                  >
                    {chip?.statusText ?? end!.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                </div>
              </div>
            );
          })}
          {dated.length === 0 && (
            <div className="text-[10.5px] text-muted-2">nothing with a deadline or a target yet</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A target on its project's bar: filled once hit, outlined while pending,
 * red once its date has passed without being ticked. Click toggles it. */
function TargetMarker({
  target,
  pct,
  now,
  onToggle,
}: {
  target: Target;
  pct: number;
  now: Date;
  onToggle: () => void;
}) {
  const done = target.completedAt != null;
  const late = !done && target.date.getTime() < now.getTime();
  const color = done ? "#3dd68c" : late ? "#e5484d" : "#d2cefd";
  return (
    <button
      onClick={onToggle}
      title={`${target.title} — ${target.date.toLocaleDateString()}${
        done ? " · done, click to reopen" : late ? " · date passed, click if you hit it" : " · click when you hit it"
      }`}
      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full cursor-pointer p-0"
      style={{
        left: `${pct}%`,
        width: 11,
        height: 11,
        background: done ? color : "#161826",
        border: `1.5px solid ${color}`,
        zIndex: 2,
      }}
    />
  );
}
