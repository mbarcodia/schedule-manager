"use client";

// The planner tab is the visual board — kanban (and soon eisenhower/timeline/
// archive views) over the same live schedule the calendar uses. The planner
// CHAT lives on the calendar page (PlannerChatPanel); only notes + board here.

import { useEffect, useState } from "react";
import Link from "next/link";
import { CaretLeftIcon } from "@phosphor-icons/react";
import { KanbanBoard } from "@/components/board/KanbanBoard";
import { EisenhowerBoard } from "@/components/board/EisenhowerBoard";
import { ArchiveView } from "@/components/board/ArchiveView";
import { TrashView } from "@/components/board/TrashView";
import { Timeline } from "@/components/board/Timeline";
import { WeeklyReviewCard } from "@/components/board/WeeklyReviewCard";
import { BoardViewIntro } from "@/components/board/BoardViewIntro";
import { TodoView } from "@/components/board/TodoView";
import { ListsView } from "@/components/board/ListsView";
import { WeekView } from "@/components/board/WeekView";
import { PlannerSidebar } from "@/components/planner/PlannerSidebar";
import { useScheduleData } from "@/hooks/useScheduleData";

type BoardView = "week" | "kanban" | "eisenhower" | "timeline" | "todos" | "lists" | "archive" | "trash";

const VIEWS: { id: BoardView; label: string }[] = [
  { id: "week", label: "Week" },
  { id: "kanban", label: "Progress" },
  { id: "eisenhower", label: "Priorities" },
  { id: "timeline", label: "Timeline" },
  { id: "todos", label: "To-Do" },
  { id: "lists", label: "Lists" },
  { id: "archive", label: "Archive" },
  { id: "trash", label: "Trash" },
];

export default function PlannerPage() {
  const scheduleData = useScheduleData();
  const [view, setView] = useState<BoardView>("kanban");
  /** A to-do to open on arrival, when something linked here from the calendar
   * or a board card. Read from the URL on mount rather than via
   * useSearchParams, which would need a Suspense boundary to prerender. */
  const [focusItem, setFocusItem] = useState<string | null>(null);
  /** The same idea for the Progress board: a task or a commitment to open on
   * arrival, when a calendar block linked here. Two params rather than one,
   * because they are ids from different tables opening different panels — see
   * lib/planner/board-links.ts. */
  const [focusTask, setFocusTask] = useState<string | null>(null);
  const [focusCommitment, setFocusCommitment] = useState<string | null>(null);
  // Bumped by board mutations (drops, star/archive toggles) so the notes
  // sidebar can refetch if a linked trackable changes.
  const [refreshKey, setRefreshKey] = useState(0);
  const onMutated = () => setRefreshKey((k) => k + 1);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("view");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (requested && VIEWS.some((v) => v.id === requested)) setView(requested as BoardView);
    setFocusItem(params.get("item"));
    setFocusTask(params.get("task"));
    setFocusCommitment(params.get("commitment"));
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-none px-5 py-3.5 border-b border-border flex items-center gap-3">
        <Link href="/" className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-text">
          <CaretLeftIcon size={12} weight="bold" /> Back to schedule
        </Link>
        <div className="font-medium text-[14px]">Planner</div>
        <div className="text-[11px] text-muted">
          Board views of your projects and work — chat lives on the calendar page.
        </div>
        <Link
          href="/?plan=1"
          className="ml-auto rounded-md border border-accent text-accent px-2.5 py-1 text-[11px] font-medium hover:bg-accent/10 whitespace-nowrap"
        >
          Time to plan
        </Link>
        <div className="flex gap-1">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              className="rounded-md px-2.5 py-1 text-[11px] font-medium border transition-colors"
              style={{
                borderColor: view === v.id ? "var(--color-accent)" : "var(--color-border)",
                background: view === v.id ? "rgba(145,132,217,0.08)" : "transparent",
              }}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <BoardViewIntro view={view} />
      <WeeklyReviewCard scheduleData={scheduleData} />
      <div className="flex-1 flex min-h-0">
        {view === "week" && <WeekView scheduleData={scheduleData} />}
        {view === "kanban" && (
          <KanbanBoard
            scheduleData={scheduleData}
            onMutated={onMutated}
            focusTask={focusTask}
            focusCommitment={focusCommitment}
          />
        )}
        {view === "eisenhower" && <EisenhowerBoard scheduleData={scheduleData} onMutated={onMutated} />}
        {view === "timeline" && <Timeline scheduleData={scheduleData} />}
        {view === "todos" && <TodoView onMutated={onMutated} focusItem={focusItem} />}
        {view === "lists" && <ListsView />}
        {view === "archive" && (
          <ArchiveView
            onMutated={() => {
              // A restore puts the task back on the schedule — refetch it too.
              void scheduleData.refresh();
              onMutated();
            }}
          />
        )}
        {view === "trash" && (
          <TrashView
            onMutated={() => {
              // A restored event or target is back on the calendar and back in
              // pace, so the schedule has to be refetched, not just the board.
              void scheduleData.refresh();
              onMutated();
            }}
          />
        )}
        <PlannerSidebar refreshKey={refreshKey} />
      </div>
    </div>
  );
}
