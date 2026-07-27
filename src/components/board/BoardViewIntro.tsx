"use client";

// A one-paragraph "what am I looking at" for whichever board view is open.
// Collapsible and remembered, so it's there while the board is new and out of
// the way once it isn't.

import { useEffect, useState } from "react";

export type BoardViewId = "kanban" | "eisenhower" | "timeline" | "archive";

const INTROS: Record<BoardViewId, { title: string; body: string }> = {
  kanban: {
    title: "Kanban — what's moving this week",
    body:
      "Your tasks sorted by what the schedule actually says about them, not by a status you maintain by hand. Backlog is anything with no time booked this week; This Week has time booked but hasn't started; In Progress is underway right now or partly logged; Done means everything scheduled for it this week is checked off. Drag a card to change reality: In Progress pins it to today, This Week pushes it up the queue, Backlog unpins it. Done can't be dragged into — check work off on the calendar so your logged hours stay true. The ★ marks a task important, and In Progress shows a soft limit of 3 to discourage juggling.",
  },
  eisenhower: {
    title: "Eisenhower — what deserves the attention",
    body:
      "The same tasks split by importance against urgency. Importance is yours to set (the ★ on any card); urgency is read from the deadline — anything due within three days counts, and a task with no deadline never does. Use it to notice the trap quadrants: urgent-but-unimportant work that eats a week, and important-but-not-urgent work (usually the research that matters most) that quietly never gets scheduled.",
  },
  timeline: {
    title: "Timeline — the next six months",
    body:
      "One bar per project and proposal that has a deadline, running from today to that date, coloured by whether the hours you've booked can realistically cover what's left. Overdue bars turn red. Goals have a cadence rather than a deadline, so they sit in their own lane on top. This is the view for spotting two deadlines landing in the same fortnight while there's still time to move something.",
  },
  archive: {
    title: "Archive — everything you've finished",
    body:
      "Finished tasks are archived rather than deleted, so their logged hours survive for the long view. Nothing here affects your schedule, and Restore puts a task back if you archived it early. Because the record is intact, you can ask the chat things like \"what did I get done this semester?\" and get an answer from real hours rather than memory.",
  },
};

export function BoardViewIntro({ view }: { view: BoardViewId }) {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(window.localStorage.getItem("board-intro-collapsed") !== "1");
  }, []);

  function toggle() {
    const next = !open;
    setOpen(next);
    window.localStorage.setItem("board-intro-collapsed", next ? "0" : "1");
  }

  const intro = INTROS[view];

  return (
    <div className="flex-none px-5 py-2.5 border-b border-border">
      <div className="flex items-baseline gap-2">
        <span className="text-[11.5px] font-medium text-text">{intro.title}</span>
        <button onClick={toggle} className="ml-auto text-[10.5px] text-muted hover:text-text flex-none">
          {open ? "hide" : "what is this?"}
        </button>
      </div>
      {open && <p className="mt-1 text-[11px] text-muted leading-relaxed max-w-3xl">{intro.body}</p>}
    </div>
  );
}
