"use client";

// Months-long horizontal timeline: one bar per dated project/proposal from
// now to its deadline, plus an always-visible "ongoing goals" lane (goals
// have a cadence, not a deadline, so they don't participate in the date
// scale). Risk coloring reuses the same trackable-chip heuristic the chat
// panel shows, rather than reimplementing it.

import { useMemo } from "react";
import { computeTrackableChips, type TrackableChip } from "@/lib/scheduling/trackables";
import type { UseScheduleDataResult } from "@/hooks/useScheduleData";

const MONTHS_SHOWN = 6;
const DAY_MS = 86400000;

export function Timeline({ scheduleData }: { scheduleData: UseScheduleDataResult }) {
  const { data, schedule } = scheduleData;
  const now = useMemo(() => new Date(), []);

  const chipByTitle = useMemo(() => {
    const map = new Map<string, TrackableChip>();
    if (!data || !schedule) return map;
    for (const c of computeTrackableChips(
      data.projects,
      data.proposals,
      data.goals,
      data.inputs.tasks,
      schedule,
      now,
      data.inputs.weeklyHours,
    )) {
      map.set(`${c.kind}:${c.title}`, c);
    }
    return map;
  }, [data, schedule, now]);

  if (!data || !schedule) return <div className="px-5 py-4 text-[12px] text-muted">Loading…</div>;

  const spanMs = MONTHS_SHOWN * 30.4 * DAY_MS;
  const monthTicks = Array.from({ length: MONTHS_SHOWN + 1 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    return { label: d.toLocaleDateString(undefined, { month: "short" }), pct: ((d.getTime() - now.getTime()) / spanMs) * 100 };
  }).filter((t) => t.pct >= 0 && t.pct <= 100);

  const dated = [
    ...data.projects.map((p) => ({ kind: "Project", id: p.id, title: p.title, deadline: p.deadlineDate ?? null })),
    ...data.proposals.map((p) => ({ kind: "Proposal", id: p.id, title: p.title, deadline: p.deadlineDate ?? null })),
  ].filter((t) => t.deadline != null) as { kind: string; id: string; title: string; deadline: Date }[];
  dated.sort((a, b) => a.deadline.getTime() - b.deadline.getTime());

  const undated = [
    ...data.projects.filter((p) => !p.deadlineDate).map((p) => ({ kind: "Project", id: p.id, title: p.title })),
    ...data.proposals.filter((p) => !p.deadlineDate).map((p) => ({ kind: "Proposal", id: p.id, title: p.title })),
  ];

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
      {/* Ongoing goals lane — no dates, pinned above the scale */}
      <div className="rounded-lg border border-border bg-panel p-3">
        <div className="text-[10px] tracking-wide uppercase text-muted-2 font-medium pb-2">Ongoing goals</div>
        <div className="flex flex-wrap gap-1.5">
          {data.goals.map((g) => (
            <div key={g.id} className="rounded-md border border-border bg-surface px-2.5 py-1.5 flex items-baseline gap-2">
              <span className="text-[11.5px] text-text">{g.title}</span>
              <span className="text-[9px] tracking-wide uppercase text-muted-2">{g.cadence}</span>
            </div>
          ))}
          {data.goals.length === 0 && <div className="text-[10.5px] text-muted-2">no goals yet</div>}
        </div>
      </div>

      {/* Dated lanes */}
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
          {dated.map((t) => {
            const chip = chipByTitle.get(`${t.kind}:${t.title}`);
            const endPct = Math.min(100, Math.max(2, ((t.deadline.getTime() - now.getTime()) / spanMs) * 100));
            const overdue = t.deadline.getTime() < now.getTime();
            return (
              <div key={t.id} className="flex items-center gap-2">
                <div className="flex-none w-[172px] min-w-0 flex items-baseline gap-1.5">
                  <span className="text-[9px] tracking-wide uppercase text-muted-2">{t.kind}</span>
                  <span className="text-[11.5px] text-text truncate" title={t.title}>
                    {t.title}
                  </span>
                </div>
                <div className="flex-1 relative h-5 rounded bg-surface overflow-hidden">
                  <div
                    className="absolute inset-y-1 left-0 rounded-r"
                    title={chip ? `${chip.statusText} — due ${t.deadline.toLocaleDateString()}` : t.deadline.toLocaleDateString()}
                    style={{
                      width: `${endPct}%`,
                      background: overdue ? "rgba(229,72,77,0.35)" : (chip?.bg ?? "#1d1f2b"),
                      border: `1px solid ${overdue ? "#e5484d" : (chip?.border ?? "rgba(233,233,237,0.16)")}`,
                    }}
                  />
                  <span
                    className="absolute top-1/2 -translate-y-1/2 text-[9px] whitespace-nowrap px-1.5"
                    style={{ left: `min(${endPct}%, calc(100% - 90px))`, color: chip?.statusColor ?? "#9397ab" }}
                  >
                    {chip?.statusText ?? t.deadline.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                </div>
              </div>
            );
          })}
          {dated.length === 0 && <div className="text-[10.5px] text-muted-2">no dated projects or proposals</div>}
        </div>
        {undated.length > 0 && (
          <div className="mt-3 pt-2 border-t border-border text-[10.5px] text-muted">
            No deadline: {undated.map((t) => t.title).join(", ")}
          </div>
        )}
      </div>
    </div>
  );
}
