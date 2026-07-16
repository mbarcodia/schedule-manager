"use client";

import { useEffect, useRef, useState } from "react";
import { PaperPlaneRightIcon } from "@phosphor-icons/react";
import { useChat } from "@/hooks/useChat";
import { computeTrackableChips } from "./trackables";
import type { UseScheduleDataResult } from "@/hooks/useScheduleData";

interface AssistantPanelProps {
  scheduleData: UseScheduleDataResult;
}

export function AssistantPanel({ scheduleData }: AssistantPanelProps) {
  const { data, schedule, refresh } = scheduleData;
  const { messages, send } = useChat(refresh);
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

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

  function handleSend() {
    const text = input;
    setInput("");
    void send(text);
  }

  return (
    <div className="flex-none w-[400px] border-l border-border flex flex-col min-h-0">
      <div className="flex-none px-4 py-3.5 border-b border-border">
        <div className="font-medium text-[13px]">Assistant</div>
        <div className="mt-0.5 text-[11px] text-muted">Tell me a task. I&apos;ll fit it around your rules.</div>
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

      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3.5 flex flex-col gap-2.5 min-h-0">
        {messages.map((m, i) => (
          <div key={i} className="max-w-[85%]" style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start" }}>
            <div
              className="rounded-lg px-2.5 py-2 text-[12.5px] leading-relaxed"
              style={{
                background: m.role === "user" ? "#423a6a" : "#232532",
                border: `1px solid ${m.role === "user" ? "#796cbf" : "rgba(233,233,237,0.16)"}`,
                color: "#e9e9ed",
              }}
            >
              {m.text}
            </div>
          </div>
        ))}
      </div>

      <div className="flex-none px-3.5 py-3 border-t border-border flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="e.g. finish report, high priority, 2h, due fri"
          className="flex-1 rounded-md border border-border bg-surface px-2.5 py-2 text-text text-[13px] outline-none focus-visible:border-accent"
          style={{ minHeight: 36 }}
        />
        <button
          onClick={handleSend}
          className="inline-flex items-center justify-center gap-1.5 border border-accent text-accent rounded-md px-3.5 text-[13px] font-medium hover:bg-accent/10"
        >
          <PaperPlaneRightIcon size={14} weight="fill" />
          Send
        </button>
      </div>
    </div>
  );
}
