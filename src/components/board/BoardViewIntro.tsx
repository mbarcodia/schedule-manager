"use client";

// A one-paragraph "what am I looking at" for whichever board view is open.
// Collapsible and remembered, so it's there while the board is new and out of
// the way once it isn't.

import { useEffect, useState } from "react";

export type BoardViewId = "kanban" | "eisenhower" | "timeline" | "todos" | "lists" | "archive";

const INTROS: Record<BoardViewId, { title: string; body: string }> = {
  kanban: {
    title: "Progress — what's moving this week",
    body:
      "Your tasks sorted by what the schedule actually says about it, not by a status you maintain by hand. Backlog is anything with no time booked this week; This Week has time booked but hasn't started; In Progress is underway right now or partly logged; Done means every time block for it this week is checked off. Drag a card to change reality: In Progress pins it to today, This Week pushes it up the queue, Backlog unpins it. Done can't be dragged into — check blocks off on the calendar so your logged hours stay true. The ★ marks something important, and In Progress shows a soft limit of 3 to discourage juggling.",
  },
  eisenhower: {
    title: "Priorities — what deserves the attention",
    body:
      "The same tasks split by importance against urgency. Importance is yours to set (the ★ on any card); urgency is read from the deadline — anything due within three days counts, and a task with no deadline never does. Use it to notice the trap quadrants: urgent-but-unimportant tasks that eat a week, and important-but-not-urgent ones (usually what matters most) that quietly never get scheduled.",
  },
  timeline: {
    title: "Timeline — the next six months",
    body:
      "One bar per project that has any date to work toward — its own deadline, or a target inside it — running from today to the furthest of them, coloured by whether the hours you've booked can realistically cover what's left. Overdue bars turn red. Targets are the dots along each bar: hollow while pending, red once their date passes, filled once you click them. Projects with no dates at all sit in their own lane on top. This is the view for spotting two deadlines landing in the same fortnight while there's still time to move something.",
  },
  todos: {
    title: "To-Do — things to do, with as much structure as each one needs",
    body:
      "An item starts as a plain line. Open it to say what it is: just a line, due by a date, or happening at a set time. A deadline needs only a date. An event needs a start and end, and holds that slot on the calendar. Either can carry reminders and booked hours, added whenever you decide it needs them — set an earlier finish-by to book preparation. Ticking an item off clears the hours it had booked. A list can also chase itself: anything still unticked at the end of the week, month or year arrives as one notification.",
  },
  lists: {
    title: "Lists — things you’re keeping track of",
    body:
      "For anything you want to keep rather than do: a reading list, questions for your next supervision, what to pack for a conference, the standing agenda for a recurring meeting. Each list holds a paragraph, a checklist, or both. Nothing here is ever scheduled or notified and ticking something off has no consequences anywhere else — that’s the whole difference from To-Do. Completed items strike through and grey out rather than vanishing; each list decides for itself whether to keep showing them, and the eye hides any single item you’d rather not look at.",
  },
  archive: {
    title: "Archive — everything you've finished",
    body:
      "Finished tasks are archived rather than deleted, so its logged hours survive for the long view. Nothing here affects your schedule, and Restore puts something back if you archived it early. Because the record is intact, you can ask the chat things like \"what did I get done this semester?\" and get an answer from real hours rather than memory.",
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
