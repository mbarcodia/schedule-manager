"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fmtMin } from "@/lib/scheduling/time";
import type { ScheduleBlock } from "@/lib/scheduling/types";

interface TaskDetailPopoverProps {
  block: ScheduleBlock;
  top: number;
  onClose: () => void;
  onSetProgress: (mode: "done" | "partial" | "none", minutes?: number) => void;
}

interface TaskInfo {
  kind: "task";
  priority: string;
  deadline: string | null;
  totalMin: number;
  completedMin: number;
}
interface ResearchInfo {
  kind: "research";
  weeklyMinMin: number;
  scheduledThisWeekMin: number;
  completedThisWeekMin: number;
}

function subjectFromTaskId(taskId: string): { subjectType: "task" | "research"; subjectId: string } {
  const m = /^research-(.+)-w\d+$/.exec(taskId);
  return m ? { subjectType: "research", subjectId: m[1] } : { subjectType: "task", subjectId: taskId };
}

export function TaskDetailPopover({ block, top, onClose, onSetProgress }: TaskDetailPopoverProps) {
  const [info, setInfo] = useState<TaskInfo | ResearchInfo | null>(null);

  useEffect(() => {
    let ignore = false;
    async function load() {
      if (!block.taskId) return;
      const supabase = createClient();
      const { subjectType, subjectId } = subjectFromTaskId(block.taskId);

      const { data: progressRows } = await supabase
        .from("progress_log")
        .select("start_min,end_min,minutes_done")
        .eq("subject_type", subjectType)
        .eq("subject_id", subjectId);
      const completedMin = (progressRows ?? []).reduce(
        (s, r) => s + (r.minutes_done ?? r.end_min - r.start_min),
        0,
      );

      if (subjectType === "task") {
        const { data: task } = await supabase
          .from("tasks")
          .select("priority,duration_min,deadline_at")
          .eq("id", subjectId)
          .single();
        if (ignore || !task) return;
        setInfo({
          kind: "task",
          priority: task.priority,
          deadline: task.deadline_at ? new Date(task.deadline_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null,
          totalMin: task.duration_min,
          completedMin,
        });
      } else {
        const { data: project } = await supabase.from("projects").select("weekly_min_min").eq("id", subjectId).single();
        if (ignore) return;
        setInfo({
          kind: "research",
          weeklyMinMin: project?.weekly_min_min ?? 0,
          scheduledThisWeekMin: block.end - block.start,
          completedThisWeekMin: completedMin,
        });
      }
    }
    void load();
    return () => {
      ignore = true;
    };
  }, [block.taskId, block.end, block.start]);

  const len = block.end - block.start;
  const step = Math.max(15, Math.round(len / 4 / 15) * 15);
  const partialOptions: number[] = [];
  for (let m = step; m < len; m += step) partialOptions.push(m);
  const taskStarted = !!block.status && !block.pinned;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        top: Math.max(0, top),
        right: 2,
        zIndex: 10,
        background: "#232532",
        border: "1px solid rgba(233,233,237,0.25)",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        minWidth: 190,
        overflow: "hidden",
      }}
    >
      <div className="px-2.5 py-2 border-b border-white/10">
        <div className="text-[11.5px] font-medium text-text">{block.title}</div>
        {!info && <div className="mt-1 text-[10.5px] text-muted">Loading…</div>}
        {info?.kind === "task" && (
          <div className="mt-1 flex flex-col gap-0.5 text-[10.5px] text-muted">
            <span>Priority: {info.priority}</span>
            <span>Deadline: {info.deadline ?? "none"}</span>
            <span>
              Completed: {fmtMin(info.completedMin)} / {fmtMin(info.totalMin)}
            </span>
          </div>
        )}
        {info?.kind === "research" && (
          <div className="mt-1 flex flex-col gap-0.5 text-[10.5px] text-muted">
            <span>Weekly minimum: {fmtMin(info.weeklyMinMin)}</span>
            <span>Scheduled this week: {fmtMin(info.scheduledThisWeekMin)}</span>
            <span>Completed this week: {fmtMin(info.completedThisWeekMin)}</span>
          </div>
        )}
      </div>

      {taskStarted && (
        <div className="flex flex-col">
          <button
            className="schedule-menu-item"
            onClick={() => {
              onSetProgress("done");
              onClose();
            }}
          >
            ✓ Done — all {fmtMin(len)}
          </button>
          {partialOptions.map((m) => (
            <button
              key={m}
              className="schedule-menu-item"
              onClick={() => {
                onSetProgress("partial", m);
                onClose();
              }}
            >
              Did {fmtMin(m)} — move the rest
            </button>
          ))}
          <button
            className="schedule-menu-item"
            onClick={() => {
              onSetProgress("none");
              onClose();
            }}
          >
            Didn&apos;t get to it — move it all
          </button>
        </div>
      )}
    </div>
  );
}
