"use client";

// The guided screen a check-in push opens (/planner?checkin=1) — distinct
// from WeeklyReviewCard's passive stats strip, which stays up all the time
// and answers "how's it going." This is a moment, not a fixture: it exists
// because priorities shift enough during a real week that a once-a-week
// glance isn't enough, and it should let you act on what changed right here
// rather than sending you hunting across three boards for the write path.
//
// Deliberately thin on its own logic — every action below is an existing
// write (toggle important, open the commitment/task panel, put on hold)
// surfaced together at the moment the push lands, not a new mutation path.

import { useMemo, useState } from "react";
import { XIcon, StarIcon, PlusIcon } from "@phosphor-icons/react";
import { buildWeekReview } from "@/lib/scheduling/week-review";
import { paceFromData, paceSentence } from "@/lib/scheduling/pace";
import { startOfWeekMonday } from "@/lib/scheduling/time";
import { setTaskImportant } from "@/lib/planner/board-actions";
import { TaskPanel } from "./TaskPanel";
import { CommitmentPanelHost } from "./CommitmentPanel";
import type { UseScheduleDataResult } from "@/hooks/useScheduleData";

const hrs = (min: number) => `${+(min / 60).toFixed(min % 60 === 0 ? 0 : 1)}h`;

export function WeeklyCheckinPanel({
  scheduleData,
  onClose,
  onMutated,
}: {
  scheduleData: UseScheduleDataResult;
  onClose: () => void;
  onMutated?: () => void;
}) {
  const { data, schedule, refresh } = scheduleData;
  const now = useMemo(() => new Date(), []);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [openCommitment, setOpenCommitment] = useState<string | null>(null);

  const review = useMemo(() => {
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
      offset: 0,
      reserve: data.reserve,
    });
  }, [data, schedule, now]);

  const pace = useMemo(() => (data ? paceFromData(data, now) : []), [data, now]);
  const slipping = pace.filter((p) => p.status === "slipping");

  async function saved() {
    await refresh();
    onMutated?.();
  }

  async function toggleTaskImportant(taskId: string, next: boolean) {
    await setTaskImportant(taskId, next);
    await saved();
  }

  if (!data || !schedule || !review) {
    return (
      <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center">
        <div className="rounded-lg border border-border bg-panel px-5 py-4 text-[12px] text-muted">Loading…</div>
      </div>
    );
  }

  // schedule.risk/nearDeadline are titles (the engine's own unit of reporting
  // — see engine.ts), resolved back to real rows here so each can open its
  // real panel rather than just being named.
  const byTitle = new Map(data.rawTasks.map((t) => [t.title, t]));
  const isRow = (t: (typeof data.rawTasks)[number] | undefined): t is (typeof data.rawTasks)[number] => t != null;
  const riskTasks = (schedule.risk ?? []).map((title) => byTitle.get(title)).filter(isRow);
  const nearDeadlineTasks = (schedule.nearDeadline ?? [])
    .map((title) => byTitle.get(title))
    .filter(isRow)
    .filter((t) => !riskTasks.includes(t));

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto py-8">
      <div className="w-full max-w-[560px] rounded-lg border border-border bg-panel">
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border">
          <div>
            <div className="text-[13px] font-medium text-text">Week check-in</div>
            <div className="text-[10.5px] text-muted">What&apos;s changed, what needs a decision.</div>
          </div>
          <button onClick={onClose} className="text-muted-2 hover:text-text">
            <XIcon size={16} />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-4 max-h-[75vh] overflow-y-auto">
          {review.byLabel.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <div className="text-[10px] tracking-wide uppercase text-muted-2 font-medium">This week, by label</div>
              {review.byLabel.map((l) => (
                <div
                  key={l.labelId ?? l.label}
                  className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5"
                >
                  {l.color && <span className="w-2 h-2 flex-none rounded-sm" style={{ background: l.color }} />}
                  <span className="flex-1 min-w-0 text-[11.5px] text-text truncate">{l.label}</span>
                  <span className="flex-none text-[10.5px] text-muted-2 tabular-nums">
                    {hrs(l.doneMin)} done · {hrs(l.bookedMin)} booked
                    {l.targetMin != null ? ` · ${hrs(l.targetMin)} target` : ""}
                  </span>
                </div>
              ))}
            </section>
          )}

          {slipping.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <div className="text-[10px] tracking-wide uppercase text-muted-2 font-medium">Slipping</div>
              {slipping.map((p) => (
                <button
                  key={p.projectId}
                  onClick={() => setOpenCommitment(p.projectId)}
                  className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-left hover:border-accent"
                >
                  <span className="flex-1 min-w-0 text-[11.5px] text-text truncate">{p.title}</span>
                  <span className="flex-none text-[10.5px] text-muted-2 truncate max-w-[220px]">{paceSentence(p)}</span>
                </button>
              ))}
            </section>
          )}

          {(riskTasks.length > 0 || nearDeadlineTasks.length > 0) && (
            <section className="flex flex-col gap-1.5">
              <div className="text-[10px] tracking-wide uppercase text-muted-2 font-medium">Needs attention</div>
              {[...riskTasks, ...nearDeadlineTasks].map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5"
                >
                  <button
                    onClick={() => setOpenTask(t.id)}
                    className="flex-1 min-w-0 text-left text-[11.5px] text-text truncate hover:underline"
                  >
                    {t.title}
                  </button>
                  <span className="flex-none text-[9.5px] text-muted-2">
                    {riskTasks.includes(t) ? "will miss its deadline" : "due soon"}
                  </span>
                  <button
                    onClick={() => void toggleTaskImportant(t.id, !t.important)}
                    title={t.important ? "Not important" : "Mark important"}
                    className="flex-none text-muted-2 hover:text-accent-text"
                  >
                    <StarIcon size={12} weight={t.important ? "fill" : "regular"} />
                  </button>
                </div>
              ))}
            </section>
          )}

          {review.byLabel.length === 0 && slipping.length === 0 && riskTasks.length === 0 && nearDeadlineTasks.length === 0 && (
            <div className="text-[11.5px] text-muted">Nothing urgent — the week&apos;s holding.</div>
          )}

          <button
            onClick={() => setOpenTask("new")}
            className="self-start flex items-center gap-1 text-[11.5px] text-accent-text hover:underline"
          >
            <PlusIcon size={11} /> something new since last time
          </button>
        </div>
      </div>

      {openTask && (
        <TaskPanel
          task={openTask === "new" ? null : (data.rawTasks.find((t) => t.id === openTask) ?? null)}
          projects={data.projects}
          categories={data.categories}
          onClose={() => setOpenTask(null)}
          onSaved={saved}
        />
      )}
      <CommitmentPanelHost
        data={data}
        pace={pace}
        openId={openCommitment}
        onClose={() => setOpenCommitment(null)}
        onSaved={saved}
      />
    </div>
  );
}
