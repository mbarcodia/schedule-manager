"use client";

import { useEffect, useState } from "react";
import { CalendarPanel } from "@/components/calendar/CalendarPanel";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";
import { useScheduleData } from "@/hooks/useScheduleData";

export default function Home() {
  const scheduleData = useScheduleData();
  // The quick assistant only runs on a direct API key — a subscription token
  // is planner-only, so the panel is hidden for those users rather than
  // rendering a chat that can never answer.
  const [showAssistant, setShowAssistant] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function loadCredential() {
      const res = await fetch("/api/planner/credentials");
      if (ignore || !res.ok) return;
      const data = await res.json();
      if (!ignore) setShowAssistant(data?.provider !== "oauth_token");
    }
    void loadCredential();
    return () => {
      ignore = true;
    };
  }, []);

  return (
    <div className="flex-1 flex min-h-0">
      <CalendarPanel scheduleData={scheduleData} />
      {showAssistant && <AssistantPanel scheduleData={scheduleData} />}
    </div>
  );
}
