"use client";

// The calendar and the chat rail, laid out as ONE grid rather than two columns
// side by side.
//
// Two columns is the obvious structure and it has one flaw you cannot fix from
// inside either of them: each column's header is as tall as its own contents, so
// the two bottom borders land at different heights and the join reads as a
// misprint. The calendar's toolbar wraps to a second line at some widths and not
// others, so there is no height either side could be pinned to.
//
// A grid solves it outright: both headers occupy row 1, and a grid row is as tall
// as its tallest cell, so the two borders are one line by construction — at every
// window width, however much the toolbar wraps, and whatever gets added to it
// later. Each panel returns a Fragment of two explicitly-placed cells (fragments
// add no DOM node, so those cells are still direct grid children) which is what
// lets both keep all of their own state.

import { CalendarPanel } from "@/components/calendar/CalendarPanel";
import { PlannerChatPanel } from "@/components/planner/PlannerChatPanel";
import { useScheduleData } from "@/hooks/useScheduleData";
import { COLLAPSED_WIDTH, HANDLE_WIDTH, useChatRail } from "@/hooks/useChatRail";

export default function Home() {
  const scheduleData = useScheduleData();
  const rail = useChatRail();

  return (
    <div
      className="flex-1 grid min-h-0 min-w-0"
      style={{
        // Calendar | drag handle | chat. The handle collapses to nothing along
        // with the rail, since there is no longer a width to drag.
        gridTemplateColumns: rail.collapsed
          ? `minmax(0, 1fr) 0px ${COLLAPSED_WIDTH}px`
          : `minmax(0, 1fr) ${HANDLE_WIDTH}px ${rail.width}px`,
        // Headers, then everything else. `auto` is what makes the header row
        // size to the taller of the two and stretch both to match.
        gridTemplateRows: "auto minmax(0, 1fr)",
      }}
    >
      <CalendarPanel scheduleData={scheduleData} />
      <PlannerChatPanel scheduleData={scheduleData} rail={rail} />
    </div>
  );
}
