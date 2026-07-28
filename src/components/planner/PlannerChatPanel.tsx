"use client";

// The one chat surface: the planner chat (full scheduling + notes tools, both
// credential paths) presented as the calendar page's collapsible side rail —
// the chrome the retired quick assistant used to own.

import { useEffect, useState } from "react";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { PlannerChat } from "@/components/planner/PlannerChat";
import { usePlannerChat } from "@/hooks/usePlannerChat";
import { computeTrackableChips } from "@/lib/scheduling/trackables";
import { DEFAULT_CHAT_MODE, type ChatMode } from "@/lib/planner/modes";
import type { UseScheduleDataResult } from "@/hooks/useScheduleData";

interface PlannerChatPanelProps {
  scheduleData: UseScheduleDataResult;
}

const MIN_WIDTH = 300;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 400;
const WIDTH_KEY = "planner-panel-width";

export function PlannerChatPanel({ scheduleData }: PlannerChatPanelProps) {
  const { data, schedule, refresh } = scheduleData;
  const { messages, busy, send } = usePlannerChat(refresh);
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [initialInput, setInitialInput] = useState<string | undefined>();
  const [mode, setMode] = useState<ChatMode>(DEFAULT_CHAT_MODE);

  useEffect(() => {
    const stored = Number(window.localStorage.getItem(WIDTH_KEY));
    if (stored >= MIN_WIDTH && stored <= MAX_WIDTH) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWidth(stored);
    }
  }, []);

  /** Drag the panel's left edge to trade calendar width for chat width. */
  function startWidthResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) => {
      // Dragging left (smaller clientX) widens the panel.
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + (startX - ev.clientX))));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setWidth((w) => {
        window.localStorage.setItem(WIDTH_KEY, String(w));
        return w;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

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
      ? computeTrackableChips(
          data.projects,
          data.proposals,
          data.goals,
          data.inputs.tasks,
          schedule,
          new Date(),
          data.inputs.weeklyHours,
        )
      : [];

  if (collapsed) {
    return (
      <div className="flex-none w-9 border-l border-border flex flex-col items-center pt-3">
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
    <div className="flex-none flex min-h-0" style={{ width }}>
      {/* Vertical grab handle: drag left/right to resize the whole panel. */}
      <div
        onPointerDown={startWidthResize}
        onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
        title="Drag to resize the chat panel (double-click to reset)"
        className="flex-none w-2.5 border-l border-border cursor-col-resize flex items-center justify-center group"
        style={{ touchAction: "none" }}
      >
        <div className="w-0.5 h-8 rounded-full bg-border group-hover:bg-accent transition-colors" />
      </div>

      <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <div className="flex-none px-4 py-3.5 border-b border-border flex items-start justify-between gap-2">
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

      {chips.length > 0 && (
        <div className="flex-none px-4 py-2.5 border-b border-border flex gap-1.5 overflow-x-auto">
          {chips.map((c, i) => (
            <div
              key={i}
              title={c.tooltip}
              className="flex-none flex flex-col gap-0.5 rounded-md px-2.5 py-1.5 box-border"
              style={{ border: `1px solid ${c.border}`, background: c.bg, minWidth: 120 }}
            >
              <div className="text-[9px] tracking-wide uppercase text-muted-2">{c.kind}</div>
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
    </div>
  );
}
