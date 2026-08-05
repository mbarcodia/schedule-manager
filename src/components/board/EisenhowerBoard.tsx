"use client";

// Eisenhower 2×2 — same cards as the kanban view (star toggle moves tasks
// between the important/not-important rows; "urgent" follows deadlines).

import { useEffect, useMemo, useState } from "react";
import { PlusIcon } from "@phosphor-icons/react";
import { KanbanCard, type TaskRow } from "./KanbanCard";
import { fetchTodoLinks, type TodoLink } from "@/lib/planner/todo-links";
import { setTaskImportant, setCommitmentImportant, setTaskArchived } from "@/lib/planner/board-actions";
import { quadrantFor, commitmentQuadrant, type Quadrant } from "@/lib/planner/eisenhower";
import { computePace, type CommitmentPace } from "@/lib/scheduling/pace";
import { computeStreaks, type CommitmentStreak } from "@/lib/scheduling/streaks";
import { projectTotalMin } from "@/lib/scheduling/calibration";
import { CommitmentCard } from "./CommitmentCard";
import { CommitmentPanelHost, NEW_COMMITMENT } from "./CommitmentPanel";
import { URGENT_THRESHOLD_DAYS } from "@/lib/planner/board-constants";
import type { UseScheduleDataResult } from "@/hooks/useScheduleData";
import type { Category } from "@/lib/scheduling/types";

const QUADRANTS: { id: Quadrant; title: string; hint: string }[] = [
  { id: "do", title: "Do", hint: "urgent · important" },
  { id: "schedule", title: "Schedule", hint: "not urgent · important" },
  { id: "delegate", title: "Delegate / Do quick", hint: "urgent · not important" },
  { id: "eliminate", title: "Reconsider", hint: "not urgent · not important" },
];

interface EisenhowerBoardProps {
  scheduleData: UseScheduleDataResult;
  onMutated?: () => void;
}

export function EisenhowerBoard({ scheduleData, onMutated }: EisenhowerBoardProps) {
  // Which of these tasks came from a to-do, so each card can link home.
  const [todoLinks, setTodoLinks] = useState<Map<string, TodoLink>>(new Map());
  useEffect(() => {
    void fetchTodoLinks().then(setTodoLinks);
  }, []);

  const { data, refresh } = scheduleData;
  const [openCommitment, setOpenCommitment] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const groups: Record<Quadrant, TaskRow[]> = { do: [], schedule: [], delegate: [], eliminate: [] };
    if (!data) return groups;
    // Linked tasks show under their commitment, so listing them here as well
    // would put the same work in two places.
    for (const t of data.rawTasks) {
      if (t.project_id) continue;
      groups[quadrantFor(t, data.inputs.timezone)].push(t);
    }
    return groups;
  }, [data]);

  // Stable per mount, as Timeline does it — `new Date()` inside a data memo is
  // impure, never recomputes, and stops the React Compiler optimising the file.
  const now = useMemo(() => new Date(), []);

  // Commitments sit on the same two axes: importance is the star, urgency comes
  // from the soonest date still to be met.
  const commitments = useMemo(() => {
    const groups: Record<Quadrant, CommitmentPace[]> = { do: [], schedule: [], delegate: [], eliminate: [] };
    if (!data) return groups;
    const pace = computePace({
      projects: data.projects,
      targets: data.targets,
      loggedByProject: data.progressFacts.byProject,
      weeklyHours: data.inputs.weeklyHours,
      now,
    });
    for (const p of pace) {
      const project = data.projects.find((x) => x.id === p.projectId);
      groups[
        commitmentQuadrant(
          { important: p.important, deadlineDate: project?.deadlineDate ?? null },
          p.nextDate,
          data.inputs.timezone,
          now,
        )
      ].push(p);
    }
    return groups;
  }, [data, now]);

  // Consistency and the phase-based projection, alongside pace. Both read from
  // the full work history rather than the visible fortnight.
  const extras = useMemo(() => {
    if (!data) return { streaks: new Map<string, CommitmentStreak>(), projected: new Map<string, number>() };
    const streaks = new Map(
      computeStreaks({
        logged: data.progressFacts.logged,
        commitments: data.projects.map((p) => ({ id: p.id, weeklyMinMin: p.weeklyMinMin, createdAt: null })),
        now,
      }).map((s) => [s.projectId, s]),
    );
    const projected = new Map<string, number>();
    for (const p of data.projects) {
      const mine = data.targets.filter((t) => t.projectId === p.id);
      const done = mine.filter((t) => t.completedAt).length;
      const proj = projectTotalMin(data.progressFacts.byProject[p.id] ?? 0, mine.length, done);
      if (proj != null) projected.set(p.id, proj);
    }
    return { streaks, projected };
  }, [data, now]);

  const categoriesById = useMemo(() => {
    const map: Record<string, Category> = {};
    for (const c of data?.categories ?? []) map[c.id] = c;
    return map;
  }, [data]);

  if (!data) return <div className="px-5 py-4 text-[12px] text-muted">Loading…</div>;

  async function handleToggleImportant(task: TaskRow) {
    await setTaskImportant(task.id, !task.important);
    await refresh();
    onMutated?.();
  }

  async function handleArchive(task: TaskRow) {
    await setTaskArchived(task.id, true);
    await refresh();
    onMutated?.();
  }

  async function handleToggleCommitmentImportant(projectId: string, next: boolean) {
    await setCommitmentImportant(projectId, next);
    await refresh();
    onMutated?.();
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3">
      <div className="flex items-baseline justify-between px-1 pb-2 gap-3">
        <div className="text-[10.5px] text-muted-2">
          ★ marks something important — commitments and tasks alike. Urgent = a date within{" "}
          {URGENT_THRESHOLD_DAYS} days, so anything undated is never urgent.
        </div>
        <button
          onClick={() => setOpenCommitment(NEW_COMMITMENT)}
          className="flex-none flex items-center gap-1 text-[10.5px] text-muted-2 hover:text-text"
        >
          <PlusIcon size={11} /> new commitment
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3" style={{ minHeight: "70%" }}>
        {QUADRANTS.map((q) => (
          <div key={q.id} className="rounded-lg border border-border bg-panel flex flex-col min-h-[160px]">
            <div className="flex-none px-3 py-2 border-b border-border flex items-baseline justify-between">
              <span className="text-[10px] tracking-wide uppercase text-muted-2 font-medium">{q.title}</span>
              <span className="text-[9px] text-muted-2">{q.hint}</span>
            </div>
            <div className="flex-1 p-2 flex flex-col gap-1.5">
              {commitments[q.id].map((p) => (
                <CommitmentCard
                  key={p.projectId}
                  pace={p}
                  streak={extras.streaks.get(p.projectId) ?? null}
                  projectedTotalMin={extras.projected.get(p.projectId) ?? null}
                  color={(() => {
                    const labelId = data.projects.find((x) => x.id === p.projectId)?.categoryId;
                    return labelId ? (categoriesById[labelId]?.color ?? null) : null;
                  })()}
                  targetCount={data.targets.filter((t) => t.projectId === p.projectId).length}
                  onToggleImportant={() => void handleToggleCommitmentImportant(p.projectId, !p.important)}
                  onOpen={() => setOpenCommitment(p.projectId)}
                >
                  {data.rawTasks
                    .filter((t) => t.project_id === p.projectId)
                    .map((t) => (
                      <KanbanCard
                        key={t.id}
                        task={t}
                        category={t.category_id ? (categoriesById[t.category_id] ?? null) : null}
                        todoLink={todoLinks.get(t.id) ?? null}
                        onToggleImportant={handleToggleImportant}
                        onArchive={handleArchive}
                      />
                    ))}
                </CommitmentCard>
              ))}
              {grouped[q.id].map((t) => (
                <KanbanCard
                  key={t.id}
                  task={t}
                  category={t.category_id ? (categoriesById[t.category_id] ?? null) : null}
                  todoLink={todoLinks.get(t.id) ?? null}
                  onToggleImportant={handleToggleImportant}
                  onArchive={handleArchive}
                />
              ))}
              {grouped[q.id].length === 0 && commitments[q.id].length === 0 && (
                <div className="px-1 text-[10.5px] text-muted-2">empty</div>
              )}
            </div>
          </div>
        ))}
      </div>

      <CommitmentPanelHost
        data={data}
        pace={Object.values(commitments).flat()}
        openId={openCommitment}
        onClose={() => setOpenCommitment(null)}
        onSaved={async () => {
          await refresh();
          onMutated?.();
        }}
      />
    </div>
  );
}
