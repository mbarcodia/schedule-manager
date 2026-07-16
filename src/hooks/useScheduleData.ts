"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fetchScheduleData, type ScheduleData } from "@/lib/scheduling/fetch-schedule-data";
import { computeSchedule } from "@/lib/scheduling/engine";
import type { ComputeScheduleResult, ScheduleBlock } from "@/lib/scheduling/types";

export interface UseScheduleDataResult {
  data: ScheduleData | null;
  schedule: ComputeScheduleResult | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Mark a task/research chunk fully done, partially done, or missed. */
  setProgress: (block: ScheduleBlock, mode: "done" | "partial" | "none", minutes?: number) => Promise<void>;
  /** Check a future block done early — pins it in place, time credited now. */
  pinDone: (block: ScheduleBlock) => Promise<void>;
  /** Undo an early-done pin. */
  unpinDone: (block: ScheduleBlock) => Promise<void>;
}

function subjectFromTaskId(taskId: string): { subjectType: "task" | "research"; subjectId: string } {
  const m = /^research-(.+)-w\d+$/.exec(taskId);
  return m ? { subjectType: "research", subjectId: m[1] } : { subjectType: "task", subjectId: taskId };
}

/** The real calendar date a block's gday falls on, given the account's
 * timezone-relative week grid — good enough for writing an occurred_date
 * (we don't need the exact instant, just the civil date). */
function gdayToISODate(gday: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const todayIdx = (d.getDay() + 6) % 7; // 0=Mon..6=Sun
  d.setDate(d.getDate() - todayIdx + gday);
  return d.toISOString().slice(0, 10);
}

export function useScheduleData(): UseScheduleDataResult {
  const [data, setData] = useState<ScheduleData | null>(null);
  const [schedule, setSchedule] = useState<ComputeScheduleResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await fetchScheduleData();
      setData(d);
      setSchedule(computeSchedule(d.inputs));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load schedule");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // react-hooks/set-state-in-effect flags this on principle (effects should
    // sync with external systems, not kick off data loads), but the setState
    // calls inside refresh() all happen after an await — no synchronous
    // cascading render. Standard fetch-on-mount; not worth a Suspense/`use()`
    // rewrite for this.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const setProgress: UseScheduleDataResult["setProgress"] = useCallback(
    async (block, mode, minutes) => {
      if (!block.taskId) return;
      const supabase = createClient();
      const { subjectType, subjectId } = subjectFromTaskId(block.taskId);
      const occurred_date = gdayToISODate(block.gday);

      if (mode === "none") {
        // Remove any prior log for this slot (treat it as missed by absence).
        await supabase
          .from("progress_log")
          .delete()
          .match({ subject_type: subjectType, subject_id: subjectId, occurred_date, start_min: block.start });
      } else {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;
        await supabase.from("progress_log").upsert(
          {
            user_id: user.id,
            subject_type: subjectType,
            subject_id: subjectId,
            occurred_date,
            start_min: block.start,
            end_min: block.end,
            minutes_done: mode === "partial" ? (minutes ?? null) : null,
          },
          { onConflict: "user_id,subject_type,subject_id,occurred_date,start_min" },
        );
      }
      await refresh();
    },
    [refresh],
  );

  const pinDone: UseScheduleDataResult["pinDone"] = useCallback(
    async (block) => {
      if (!block.taskId) return;
      const supabase = createClient();
      const { subjectType, subjectId } = subjectFromTaskId(block.taskId);
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      await supabase.from("pinned_chunks").upsert(
        {
          user_id: user.id,
          subject_type: subjectType,
          subject_id: subjectId,
          tag_label: block.tagLabel,
          title: block.title,
          project_id: block.projectId ?? null,
          priority: block.priority,
          occurred_date: gdayToISODate(block.gday),
          start_min: block.start,
          end_min: block.end,
        },
        { onConflict: "user_id,subject_type,subject_id,occurred_date,start_min" },
      );
      await refresh();
    },
    [refresh],
  );

  const unpinDone: UseScheduleDataResult["unpinDone"] = useCallback(
    async (block) => {
      if (!block.taskId) return;
      const supabase = createClient();
      const { subjectType, subjectId } = subjectFromTaskId(block.taskId);
      await supabase.from("pinned_chunks").delete().match({
        subject_type: subjectType,
        subject_id: subjectId,
        occurred_date: gdayToISODate(block.gday),
        start_min: block.start,
      });
      await refresh();
    },
    [refresh],
  );

  return { data, schedule, loading, error, refresh, setProgress, pinDone, unpinDone };
}
