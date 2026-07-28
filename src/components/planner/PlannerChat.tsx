"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PaperPlaneRightIcon } from "@phosphor-icons/react";
import type { PlannerMessage } from "@/hooks/usePlannerChat";

interface PlannerChatProps {
  messages: PlannerMessage[];
  busy: boolean;
  onSend: (text: string) => void;
  /** Pre-fills the input once (e.g. the weekly-review deep link) — never
   * auto-sends; the user still hits Send. */
  initialInput?: string;
}

const MIN_COMPOSE_H = 44;
const MAX_COMPOSE_H = 320;
const DEFAULT_COMPOSE_H = 64;
const COMPOSE_H_KEY = "planner-compose-height";
/** Treat "within this many px of the bottom" as reading the newest message. */
const PIN_SLACK = 48;

export function PlannerChat({ messages, busy, onSend, initialInput }: PlannerChatProps) {
  const [input, setInput] = useState("");
  const [composeH, setComposeH] = useState(DEFAULT_COMPOSE_H);
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** Whether to keep the view glued to the bottom. False once the user
   * scrolls up to read history — otherwise streaming would yank them back. */
  const pinned = useRef(true);

  const stickToBottom = useCallback(() => {
    const list = listRef.current;
    if (list && pinned.current) list.scrollTop = list.scrollHeight;
  }, []);

  /** One pass isn't enough on first paint: the bubbles are still being laid
   * out (and the web font hasn't swapped in), so scrollHeight is short and the
   * view lands just above the last line. Re-stick over the next few frames and
   * again once fonts are ready. */
  const settleToBottom = useCallback(() => {
    let frames = 0;
    const tick = () => {
      stickToBottom();
      if (++frames < 6) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    document.fonts?.ready.then(stickToBottom).catch(() => {});
  }, [stickToBottom]);

  useEffect(() => {
    const stored = Number(window.localStorage.getItem(COMPOSE_H_KEY));
    if (stored >= MIN_COMPOSE_H && stored <= MAX_COMPOSE_H) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setComposeH(stored);
    }
  }, []);

  useEffect(() => {
    // Arrives async (read from the URL after mount) — only seed an untouched
    // box. One-shot seeding, not a cascading-render risk (same caveat as
    // useScheduleData's fetch-on-mount).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (initialInput) setInput((prev) => prev || initialInput);
  }, [initialInput]);

  // Scrolling on the messages array alone isn't enough: streamed text lands in
  // the DOM after this effect runs, so scrollHeight is still the pre-paint
  // value and the newest lines end up hidden below the compose box. Watching
  // the content box for size changes re-pins after every paint instead.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(stickToBottom);
    observer.observe(content);
    return () => observer.disconnect();
  }, [stickToBottom]);

  // A new turn always re-pins, even if the user had scrolled up earlier. This
  // also covers first load, when history arrives asynchronously.
  useEffect(() => {
    pinned.current = true;
    settleToBottom();
  }, [messages.length, settleToBottom]);

  // Growing or shrinking the compose box changes the viewport height.
  useEffect(stickToBottom, [composeH, stickToBottom]);

  function handleSend() {
    if (busy) return;
    const text = input;
    setInput("");
    onSend(text);
  }

  function onListScroll() {
    const list = listRef.current;
    if (!list) return;
    pinned.current = list.scrollHeight - list.scrollTop - list.clientHeight < PIN_SLACK;
  }

  /** Drag the divider to trade message-list space for compose space. */
  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = composeH;
    const move = (ev: PointerEvent) => {
      // Dragging up (smaller clientY) grows the compose box.
      const next = Math.min(MAX_COMPOSE_H, Math.max(MIN_COMPOSE_H, startH + (startY - ev.clientY)));
      setComposeH(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setComposeH((h) => {
        window.localStorage.setItem(COMPOSE_H_KEY, String(h));
        return h;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <div
        ref={listRef}
        onScroll={onListScroll}
        className="flex-1 overflow-y-auto px-5 pt-4 min-h-0"
      >
        {/* Inner box so a ResizeObserver can watch the content, not the
            fixed-height scroll port. pb-3 keeps the last bubble clear of the
            divider instead of touching it. */}
        <div ref={contentRef} className="flex flex-col gap-3 pb-3">
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
      </div>

      {/* Resize divider */}
      <div
        onPointerDown={startResize}
        onDoubleClick={() => setComposeH(DEFAULT_COMPOSE_H)}
        title="Drag to resize the message box (double-click to reset)"
        className="flex-none h-2.5 border-t border-border cursor-row-resize flex items-center justify-center group"
        style={{ touchAction: "none" }}
      >
        <div className="h-0.5 w-8 rounded-full bg-border group-hover:bg-accent transition-colors" />
      </div>

      <div className="flex-none px-4 pb-3.5 pt-2 flex gap-2 items-end">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Discuss projects, priorities, and plans — Shift+Enter for a new line"
          style={{ height: composeH }}
          className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-text text-[13px] outline-none focus-visible:border-accent resize-none"
        />
        <button
          onClick={handleSend}
          disabled={busy}
          className="inline-flex items-center justify-center gap-1.5 border border-accent text-accent rounded-md px-3.5 text-[13px] font-medium hover:bg-accent/10 disabled:opacity-50 h-10"
        >
          <PaperPlaneRightIcon size={14} weight="fill" />
          {busy ? "Thinking…" : "Send"}
        </button>
      </div>
    </div>
  );
}
