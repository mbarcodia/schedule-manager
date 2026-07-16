"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
}

export function useChat(onReplied: () => void) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function load() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from("chat_messages")
        .select("role,content")
        .eq("user_id", user.id)
        .order("created_at", { ascending: true })
        .limit(50);
      if (ignore) return;
      const history = (data ?? []).map((m) => ({ role: m.role, text: m.content }));
      setMessages(
        history.length
          ? history
          : [
              {
                role: "assistant",
                text: "Tell me a task, project, or deadline and I'll fit it around your rules. You can also ask about status, or say things like \"shorten Thursday by 2 hours\".",
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
      setMessages((prev) => [...prev, { role: "user", text: trimmed }, { role: "assistant", text: "…", pending: true }]);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed }),
        });
        const data = await res.json();
        setMessages((prev) => [
          ...prev.filter((m) => !m.pending),
          { role: "assistant", text: data.reply ?? "Something went wrong." },
        ]);
      } catch {
        setMessages((prev) => [
          ...prev.filter((m) => !m.pending),
          { role: "assistant", text: "I couldn't reach the assistant just now — please try again." },
        ]);
      }
      onReplied();
    },
    [onReplied],
  );

  return { messages, loaded, send };
}
