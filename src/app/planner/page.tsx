"use client";

// The planner tab is the visual board — kanban (and soon eisenhower/timeline/
// archive views) over the same live schedule the calendar uses. The planner
// CHAT lives on the calendar page (PlannerChatPanel); only notes + board here.

import { useState } from "react";
import Link from "next/link";
import { CaretLeftIcon } from "@phosphor-icons/react";
import { KanbanBoard } from "@/components/board/KanbanBoard";
import { EisenhowerBoard } from "@/components/board/EisenhowerBoard";
import { PlannerSidebar } from "@/components/planner/PlannerSidebar";
import { useScheduleData } from "@/hooks/useScheduleData";

type BoardView = "kanban" | "eisenhower";

const VIEWS: { id: BoardView; label: string }[] = [
  { id: "kanban", label: "Kanban" },
  { id: "eisenhower", label: "Eisenhower" },
];

export default function PlannerPage() {
  const scheduleData = useScheduleData();
  const [view, setView] = useState<BoardView>("kanban");
  // Bumped by board mutations (drops, star/archive toggles) so the notes
  // sidebar can refetch if a linked trackable changes.
  const [refreshKey, setRefreshKey] = useState(0);
  const onMutated = () => setRefreshKey((k) => k + 1);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-none px-5 py-3.5 border-b border-border flex items-center gap-3">
        <Link href="/" className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-text">
          <CaretLeftIcon size={12} weight="bold" /> Back to schedule
        </Link>
        <div className="font-medium text-[14px]">Planner</div>
        <div className="text-[11px] text-muted">
          Board views of your projects, proposals, and goals — chat lives on the calendar page.
        </div>
        <div className="ml-auto flex gap-1">
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
      <div className="flex-1 flex min-h-0">
        {view === "kanban" && <KanbanBoard scheduleData={scheduleData} onMutated={onMutated} />}
        {view === "eisenhower" && <EisenhowerBoard scheduleData={scheduleData} onMutated={onMutated} />}
        <PlannerSidebar refreshKey={refreshKey} />
      </div>
    </div>
  );
}
