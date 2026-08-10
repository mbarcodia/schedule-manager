"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fetchScheduleData, type ScheduleData } from "@/lib/scheduling/fetch-schedule-data";
import { computeSchedule } from "@/lib/scheduling/engine";
import { localDateKey } from "@/lib/scheduling/time";
import type { ComputeScheduleResult, ScheduleBlock } from "@/lib/scheduling/types";

export interface UseScheduleDataResult {
  data: ScheduleData | null;
  schedule: ComputeScheduleResult | null;
  loading: boolean;
  error: string | null;
  /** A WRITE that failed, as a sentence to show the user. Separate from `error`
   * on purpose: that one means the schedule couldn't be loaded and replaces the
   * whole view, which would be an absurd response to one checkbox not saving.
   * Every write below refreshes afterwards, so a swallowed failure looked
   * exactly like the tick undoing itself for no reason. */
  writeError: string | null;
  dismissWriteError: () => void;
  refresh: () => Promise<void>;
  /** Mark a task/research chunk fully done, partially done, or missed. */
  setProgress: (block: ScheduleBlock, mode: "done" | "partial" | "none", minutes?: number) => Promise<void>;
  /** Check a future block done early — the pin is recorded ending at the
   * completion moment (full length, so the task stays fully credited) and
   * the block's original slot is freed for the scheduler to refill. */
  pinDone: (block: ScheduleBlock) => Promise<void>;
  /** Undo an early-done pin. */
  unpinDone: (block: ScheduleBlock) => Promise<void>;
}

function subjectFromTaskId(taskId: string): { subjectType: "task" | "research" | "anchor"; subjectId: string } {
  const research = /^research-(.+)-w\d+$/.exec(taskId);
  if (research) return { subjectType: "research", subjectId: research[1] };
  const anchor = /^anchor-(.+)$/.exec(taskId);
  if (anchor) return { subjectType: "anchor", subjectId: anchor[1] };
  return { subjectType: "task", subjectId: taskId };
}

/** The real calendar date a block's gday falls on, given the account's
 * timezone-relative week grid — good enough for writing an occurred_date
 * (we don't need the exact instant, just the civil date).
 *
 * Built from LOCAL parts. It used to end in toISOString().slice(0, 10), which
 * converts local midnight to UTC first — fine in the Americas, a day early
 * everywhere east of Greenwich. In a write path that means progress recorded
 * against the wrong day AND a done-marker whose key no longer matches its
 * block, so ticking work off would appear to do nothing at all. */
function gdayToISODate(gday: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const todayIdx = (d.getDay() + 6) % 7; // 0=Mon..6=Sun
  d.setDate(d.getDate() - todayIdx + gday);
  return localDateKey(d);
}

export function useScheduleData(): UseScheduleDataResult {
  const [data, setData] = useState<ScheduleData | null>(null);
  const [schedule, setSchedule] = useState<ComputeScheduleResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const dismissWriteError = useCallback(() => setWriteError(null), []);

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
        const { error: err } = await supabase
          .from("progress_log")
          .delete()
          .match({ subject_type: subjectType, subject_id: subjectId, occurred_date, start_min: block.start });
        if (err) return setWriteError(`Couldn't clear that block: ${err.message}`);
      } else {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;
        const { error: err } = await supabase.from("progress_log").upsert(
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
        if (err) return setWriteError(`Couldn't record that: ${err.message}`);
      }
      setWriteError(null);
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
      // Record the pin ending at the completion moment rather than at the
      // block's scheduled slot — the freed slot then reshuffles on the next
      // compute. Length is preserved so the task stays fully credited; if
      // the day is younger than the block is long, it spills past "now"
      // rather than losing credit.
      const d = new Date();
      const nowMin = Math.floor((d.getHours() * 60 + d.getMinutes()) / 15) * 15;
      const len = block.end - block.start;
      const todayGday = (d.getDay() + 6) % 7;
      const occurredDate = gdayToISODate(todayGday);
      // A second chunk of the same task checked off around the same time
      // would land on a slot the task already claimed — colliding with a
      // prior pin (merged away by the upsert's conflict key) or with a
      // progress-logged span (double-booking minutes already credited).
      // Stack it immediately before the task's earliest claim today
      // instead. Adjacent same-status chunks render merged, so repeated
      // check-offs read as one growing done block.
      const claimFilter = { user_id: user.id, subject_type: subjectType, subject_id: subjectId, occurred_date: occurredDate };
      const [{ data: pins }, { data: prog }] = await Promise.all([
        supabase.from("pinned_chunks").select("start_min").match(claimFilter),
        supabase.from("progress_log").select("start_min").match(claimFilter),
      ]);
      const claims = [...(pins ?? []), ...(prog ?? [])].map((r) => r.start_min);
      const anchor = claims.length ? Math.min(...claims) : nowMin;
      const start = Math.max(0, Math.min(nowMin, anchor) - len);
      const { error: pinErr } = await supabase.from("pinned_chunks").upsert(
        {
          user_id: user.id,
          subject_type: subjectType,
          subject_id: subjectId,
          tag_label: block.tagLabel,
          title: block.title,
          project_id: block.projectId ?? null,
          priority: block.priority,
          occurred_date: occurredDate,
          start_min: start,
          end_min: start + len,
        },
        { onConflict: "user_id,subject_type,subject_id,occurred_date,start_min" },
      );
      if (pinErr) return setWriteError(`Couldn't check that off early: ${pinErr.message}`);
      setWriteError(null);
      await refresh();
    },
    [refresh],
  );

  const unpinDone: UseScheduleDataResult["unpinDone"] = useCallback(
    async (block) => {
      if (!block.taskId) return;
      const supabase = createClient();
      const { subjectType, subjectId } = subjectFromTaskId(block.taskId);
      const { error: err } = await supabase.from("pinned_chunks").delete().match({
        subject_type: subjectType,
        subject_id: subjectId,
        occurred_date: gdayToISODate(block.gday),
        start_min: block.start,
      });
      if (err) return setWriteError(`Couldn't undo that: ${err.message}`);
      setWriteError(null);
      await refresh();
    },
    [refresh],
  );

  return { data, schedule, loading, error, writeError, dismissWriteError, refresh, setProgress, pinDone, unpinDone };
}
