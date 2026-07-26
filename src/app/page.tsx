"use client";

import { CalendarPanel } from "@/components/calendar/CalendarPanel";
import { PlannerChatPanel } from "@/components/planner/PlannerChatPanel";
import { useScheduleData } from "@/hooks/useScheduleData";

export default function Home() {
  const scheduleData = useScheduleData();

  return (
    <div className="flex-1 flex min-h-0">
      <CalendarPanel scheduleData={scheduleData} />
      <PlannerChatPanel scheduleData={scheduleData} />
    </div>
  );
}
