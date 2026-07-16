"use client";

import { CalendarPanel } from "@/components/calendar/CalendarPanel";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";
import { useScheduleData } from "@/hooks/useScheduleData";

export default function Home() {
  const scheduleData = useScheduleData();

  return (
    <div className="flex-1 flex min-h-0">
      <CalendarPanel scheduleData={scheduleData} />
      <AssistantPanel scheduleData={scheduleData} />
    </div>
  );
}
