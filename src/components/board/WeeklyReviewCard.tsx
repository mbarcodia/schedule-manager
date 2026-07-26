"use client";

// Live weekly-review stats strip at the top of the board — the on-demand
// version of what the weekly-summary cron pushes. The CTA deep-links to the
// calendar page's chat with a review prompt pre-filled (not auto-sent).

import { useMemo } from "react";
import Link from "next/link";
import { deriveBoardStatuses, boardStatusFor } from "@/lib/planner/board-status";
import { DEFAULT_WIP_LIMIT } from "@/lib/planner/board-constants";
import { computeTrackableChips } from "@/lib/scheduling/trackables";
import type { UseScheduleDataResult } from "@/hooks/useScheduleData";

export function WeeklyReviewCard({ scheduleData }: { scheduleData: UseScheduleDataResult }) {
  const { data, schedule } = scheduleData;

  const stats = useMemo(() => {
    if (!data || !schedule) return null;
    const index = deriveBoardStatuses(schedule);
    const statuses = data.rawTasks.map((t) => boardStatusFor(index, t.id));
    const atRisk = computeTrackableChips(
      data.projects,
      data.proposals,
      data.goals,
      data.inputs.tasks,
      schedule,
      new Date(),
      data.inputs.weeklyHours,
    ).filter((c) => c.statusText.startsWith("At risk")).length;
    return {
      done: statuses.filter((s) => s === "done").length,
      total: data.rawTasks.length,
      inProgress: statuses.filter((s) => s === "in_progress").length,
      missed: schedule.missed.length,
      atRisk,
    };
  }, [data, schedule]);

  if (!stats) return null;

  const items = [
    { label: "done this week", value: `${stats.done}/${stats.total}` },
    { label: "in progress", value: `${stats.inProgress}/${DEFAULT_WIP_LIMIT}`, warn: stats.inProgress > DEFAULT_WIP_LIMIT },
    { label: "missed", value: String(stats.missed), warn: stats.missed > 0 },
    { label: "at risk", value: String(stats.atRisk), warn: stats.atRisk > 0 },
  ];

  return (
    <div className="flex-none px-5 py-2.5 border-b border-border flex items-center gap-5">
      {items.map((it) => (
        <div key={it.label} className="flex items-baseline gap-1.5">
          <span className="text-[13px] font-semibold" style={{ color: it.warn ? "#e0a94e" : "var(--color-text, #e9e9ed)" }}>
            {it.value}
          </span>
          <span className="text-[10px] text-muted-2">{it.label}</span>
        </div>
      ))}
      <Link href="/?review=1" className="ml-auto text-[11px] text-accent-text hover:underline whitespace-nowrap">
        Discuss this week&apos;s review →
      </Link>
    </div>
  );
}
