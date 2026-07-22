"use client";

import { useEffect, useRef, useState } from "react";
import { PaperPlaneRightIcon } from "@phosphor-icons/react";
import type { PlannerMessage } from "@/hooks/usePlannerChat";

interface PlannerChatProps {
  messages: PlannerMessage[];
  busy: boolean;
  onSend: (text: string) => void;
}

export function PlannerChat({ messages, busy, onSend }: PlannerChatProps) {
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  function handleSend() {
    if (busy) return;
    const text = input;
    setInput("");
    onSend(text);
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <div ref={listRef} className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3 min-h-0">
        {messages.map((m, i) => (
          <div key={i} className="max-w-[75%]" style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start" }}>
            <div
              className="rounded-lg px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap"
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

      <div className="flex-none px-4 py-3.5 border-t border-border flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          rows={2}
          placeholder="Discuss projects, priorities, and plans — Shift+Enter for a new line"
          className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-text text-[13px] outline-none focus-visible:border-accent resize-none"
        />
        <button
          onClick={handleSend}
          disabled={busy}
          className="inline-flex items-center justify-center gap-1.5 border border-accent text-accent rounded-md px-3.5 text-[13px] font-medium hover:bg-accent/10 disabled:opacity-50 self-end h-10"
        >
          <PaperPlaneRightIcon size={14} weight="fill" />
          {busy ? "Thinking…" : "Send"}
        </button>
      </div>
    </div>
  );
}
