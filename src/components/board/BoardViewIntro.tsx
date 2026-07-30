"use client";

// A one-paragraph "what am I looking at" for whichever board view is open.
// Collapsible and remembered, so it's there while the board is new and out of
// the way once it isn't.

import { useEffect, useState } from "react";

export type BoardViewId = "kanban" | "eisenhower" | "timeline" | "todos" | "reminders" | "archive";

const INTROS: Record<BoardViewId, { title: string; body: string }> = {
  kanban: {
    title: "Kanban — what's moving this week",
    body:
      "Your work sorted by what the schedule actually says about it, not by a status you maintain by hand. Backlog is anything with no time booked this week; This Week has time booked but hasn't started; In Progress is underway right now or partly logged; Done means every time block for it this week is checked off. Drag a card to change reality: In Progress pins it to today, This Week pushes it up the queue, Backlog unpins it. Done can't be dragged into — check work off on the calendar so your logged hours stay true. The ★ marks something important, and In Progress shows a soft limit of 3 to discourage juggling.",
  },
  eisenhower: {
    title: "Eisenhower — what deserves the attention",
    body:
      "The same work split by importance against urgency. Importance is yours to set (the ★ on any card); urgency is read from the deadline — anything due within three days counts, and work with no deadline never does. Use it to notice the trap quadrants: urgent-but-unimportant work that eats a week, and important-but-not-urgent work (usually what matters most) that quietly never gets scheduled.",
  },
  timeline: {
    title: "Timeline — the next six months",
    body:
      "One bar per commitment that has a deadline, running from today to that date, coloured by whether the hours you've booked can realistically cover what's left. Overdue bars turn red. Commitments with a cadence rather than a deadline sit in their own lane on top. This is the view for spotting two deadlines landing in the same fortnight while there's still time to move something.",
  },
  todos: {
    title: "To-dos — things to do, not hours to schedule",
    body:
      "Named checklists that deliberately hold no time. Nothing here is placed on your calendar and nothing competes for your working hours — it's for the small stuff you just need to remember to do. Tell the chat \"add write email to Rich to my This week list\" and it lands here, creating the list if it doesn't exist. When an item turns out to need real time, ask for it as work instead and the scheduler will book hours for it.",
  },
  reminders: {
    title: "Reminders — dated nudges, delivered as notifications",
    body:
      "A reminder is a date you want to be told about in advance, grouped under whatever headings you like (Presentations, Reviews, Deadlines). Each one can have several lead times, so a seminar can nudge you a week before and again the day before. Reminders take no calendar time either — if you also want hours to prepare, ask for that separately and both will exist: the nudge and the booked work.",
  },
  archive: {
    title: "Archive — everything you've finished",
    body:
      "Finished work is archived rather than deleted, so its logged hours survive for the long view. Nothing here affects your schedule, and Restore puts something back if you archived it early. Because the record is intact, you can ask the chat things like \"what did I get done this semester?\" and get an answer from real hours rather than memory.",
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
