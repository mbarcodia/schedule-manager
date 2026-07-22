"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { CaretLeftIcon } from "@phosphor-icons/react";
import { usePlannerChat } from "@/hooks/usePlannerChat";
import { PlannerChat } from "@/components/planner/PlannerChat";
import { PlannerSidebar } from "@/components/planner/PlannerSidebar";

export default function PlannerPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const onReplied = useCallback(() => setRefreshKey((k) => k + 1), []);
  const { messages, busy, send } = usePlannerChat(onReplied);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-none px-5 py-3.5 border-b border-border flex items-center gap-3">
        <Link href="/" className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-text">
          <CaretLeftIcon size={12} weight="bold" /> Back to schedule
        </Link>
        <div className="font-medium text-[14px]">Planner</div>
        <div className="text-[11px] text-muted">
          Long-horizon planning partner — it can do everything the assistant can, plus keep notes.
        </div>
      </div>
      <div className="flex-1 flex min-h-0">
        <PlannerChat messages={messages} busy={busy} onSend={send} />
        <PlannerSidebar refreshKey={refreshKey} />
      </div>
    </div>
  );
}
