"use client";

// Planner counterpart of useChat: same optimistic-send shape, but against
// planner_messages and /api/planner. Kept separate rather than parameterized
// so the two chat surfaces can diverge (streaming lands here first).

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export interface PlannerMessage {
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
}

export function usePlannerChat(onReplied: () => void) {
  const [messages, setMessages] = useState<PlannerMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function load() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from("planner_messages")
        .select("role,content")
        .eq("user_id", user.id)
        .order("created_at", { ascending: true })
        .limit(100);
      if (ignore) return;
      const history = (data ?? []).map((m) => ({ role: m.role, text: m.content }));
      setMessages(
        history.length
          ? history
          : [
              {
                role: "assistant",
                text: "I'm your planner. Tell me about your upcoming projects, deadlines, and how you like to work — I'll help you build a realistic plan, keep notes organized per project, and put the work on your calendar.",
              },
            ],
      );
      setLoaded(true);
    }
    void load();
    return () => {
      ignore = true;
    };
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setBusy(true);
      setMessages((prev) => [...prev, { role: "user", text: trimmed }, { role: "assistant", text: "…", pending: true }]);
      try {
        const res = await fetch("/api/planner", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed }),
        });
        if (!res.ok || !res.body) throw new Error("bad response");

        // The route streams plain text chunks (see /api/planner/route.ts) —
        // replace the pending "…" bubble with accumulated text as it arrives
        // instead of waiting for the whole reply.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          setMessages((prev) => [...prev.slice(0, -1), { role: "assistant", text: accumulated }]);
        }
      } catch {
        setMessages((prev) => [
          ...prev.slice(0, -1),
          { role: "assistant", text: "I couldn't reach the planner just now — please try again." },
        ]);
      }
      setBusy(false);
      onReplied();
    },
    [onReplied],
  );

  return { messages, loaded, busy, send };
}
