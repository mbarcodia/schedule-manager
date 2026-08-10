"use client";

// The one chat surface: the planner chat (full scheduling + notes tools, both
// credential paths) presented as the calendar page's collapsible side rail —
// the chrome the retired quick assistant used to own.

import { useEffect, useState } from "react";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { PlannerChat } from "@/components/planner/PlannerChat";
import { usePlannerChat } from "@/hooks/usePlannerChat";
import { computeTrackableChips } from "@/lib/scheduling/trackables";
import { paceFromData } from "@/lib/scheduling/pace";
import { DEFAULT_CHAT_MODE, type ChatMode } from "@/lib/planner/modes";
import type { UseScheduleDataResult } from "@/hooks/useScheduleData";
import type { ChatRail } from "@/hooks/useChatRail";

interface PlannerChatPanelProps {
  scheduleData: UseScheduleDataResult;
  /** Width and collapse, owned by the page because they are its grid columns —
   * see app/page.tsx. The controls for both still live in here. */
  rail: ChatRail;
}

// This panel's two halves, placed explicitly in the page's grid. Column 3 is the
// rail; column 2 is the drag handle, which spans BOTH rows so it stays one
// continuous edge past the header's bottom border.
// No display/direction here: a grid item stretches to its row's height on its
// own, and forcing a column threw the header's own `flex … justify-between` into
// the vertical axis — which dropped the collapse caret to the bottom of the cell
// as soon as the calendar's toolbar made the row taller than the text.
const HEADER_CELL: React.CSSProperties = { gridColumn: 3, gridRow: 1 };
const BODY_CELL: React.CSSProperties = { gridColumn: 3, gridRow: 2, display: "flex", flexDirection: "column", minHeight: 0 };
const HANDLE_CELL: React.CSSProperties = { gridColumn: 2, gridRow: "1 / 3" };

export function PlannerChatPanel({ scheduleData, rail }: PlannerChatPanelProps) {
  const { data, schedule, refresh } = scheduleData;
  const { messages, busy, send } = usePlannerChat(refresh);
  const { collapsed, setCollapsed, startWidthResize, resetWidth } = rail;
  const [initialInput, setInitialInput] = useState<string | undefined>();
  const [mode, setMode] = useState<ChatMode>(DEFAULT_CHAT_MODE);

  useEffect(() => {
    // The board's "Discuss this week's review" link lands on /?review=1 —
    // pre-fill (never auto-send) the review prompt. Read from the URL
    // directly: this is client-only state, not worth a useSearchParams
    // Suspense boundary.
    const params = new URLSearchParams(window.location.search);
    // One-shot mount-time seed from the URL (window doesn't exist during
    // prerender, so this can't be a lazy initializer).
    if (params.get("review")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInitialInput(
        "Let's do a weekly review — what's overdue, what's stuck in progress too long, and what should I drop or reprioritize for next week?",
      );
      setMode("planning");
    } else if (params.get("plan")) {
      setInitialInput("Time to plan.");
      setMode("planning");
    }
  }, []);

  const chips =
    data && schedule
      ? (() => {
          const now = new Date();
          return computeTrackableChips(
            data.projects,
            data.inputs.tasks,
            schedule,
            now,
            data.inputs.weeklyHours,
            paceFromData(data, now),
          );
        })()
      : [];

  // Collapsed, the rail is one narrow column with nothing but the expand button.
  // It still spans both grid rows so the calendar's header border runs the full
  // width of the page rather than stopping short of it.
  if (collapsed) {
    return (
      <div
        style={{ gridColumn: 3, gridRow: "1 / 3" }}
        className="border-l border-border flex flex-col items-center pt-3"
      >
        <button
          onClick={() => setCollapsed(false)}
          title="Expand chat"
          className="inline-flex items-center justify-center w-7 h-7 rounded-md hover:bg-white/5 text-muted"
        >
          <CaretLeftIcon size={13} weight="bold" />
        </button>
      </div>
    );
  }

  return (
    <>
      {/* Vertical grab handle: drag left/right to resize the whole panel. Spans
         both rows, so it reads as one edge rather than being cut in half by the
         header's bottom border. */}
      <div
        style={{ ...HANDLE_CELL, touchAction: "none" }}
        onPointerDown={startWidthResize}
        onDoubleClick={resetWidth}
        title="Drag to resize the chat panel (double-click to reset)"
        className="border-l border-border cursor-col-resize flex items-center justify-center group"
      >
        <div className="w-0.5 h-8 rounded-full bg-border group-hover:bg-accent transition-colors" />
      </div>

      <div style={HEADER_CELL} className="min-w-0 px-4 py-3.5 border-b border-border flex items-start justify-between gap-2">
        <div>
          <div className="font-medium text-[13px]">Chat</div>
          <div className="mt-0.5 text-[11px] text-muted">
            Discuss projects, priorities, and plans — it can schedule tasks and keep notes.
          </div>
        </div>
        <button
          onClick={() => setCollapsed(true)}
          title="Collapse chat"
          className="flex-none inline-flex items-center justify-center w-6 h-6 rounded-md hover:bg-white/5 text-muted"
        >
          <CaretRightIcon size={12} weight="bold" />
        </button>
      </div>

      <div style={BODY_CELL} className="min-w-0">
      {chips.length > 0 && (
        <div className="flex-none px-4 py-2.5 border-b border-border flex gap-1.5 overflow-x-auto">
          {chips.map((c) => (
            <div
              key={`${c.projectId}:${c.facet}`}
              title={c.tooltip}
              className="flex-none flex flex-col gap-0.5 rounded-md px-2.5 py-1.5 box-border"
              style={{ border: `1px solid ${c.border}`, background: c.bg, minWidth: 120 }}
            >
              {/* Which facet this chip reports on — weekly hours, a deadline,
                  or an ongoing cadence. A project carrying both hours and a
                  date gets one chip for each. */}
              <div className="text-[9px] tracking-wide uppercase text-muted-2">
                {c.facet === "weekly" ? "hours" : c.facet === "deadline" ? "deadline" : "ongoing"}
              </div>
              <div
                className="text-[11.5px] font-medium text-text whitespace-nowrap overflow-hidden text-ellipsis"
                style={{ maxWidth: 140 }}
              >
                {c.title}
              </div>
              <div className="text-[10px]" style={{ color: c.statusColor, fontWeight: c.statusWeight === "600" ? 600 : 500 }}>
                {c.statusText}
              </div>
            </div>
          ))}
        </div>
      )}

        <PlannerChat
          messages={messages}
          busy={busy}
          onSend={send}
          mode={mode}
          onModeChange={setMode}
          initialInput={initialInput}
        />
      </div>
    </>
  );
}
