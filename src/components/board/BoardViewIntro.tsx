"use client";

// A one-paragraph "what am I looking at" for whichever board view is open.
// Collapsible and remembered, so it's there while the board is new and out of
// the way once it isn't.

import { useEffect, useState } from "react";

export type BoardViewId = "week" | "kanban" | "eisenhower" | "timeline" | "todos" | "lists" | "archive" | "trash";

const INTROS: Record<BoardViewId, { title: string; body: string }> = {
  week: {
    title: "Week — where the time actually went",
    body:
      "Three numbers per label, because they fail differently. A label with a share of the week set gets a TARGET; BOOKED is what the scheduler managed to place for it; DONE is what you ticked off. Target against booked is a capacity problem — the week couldn't hold what you asked of it, and the fix is a smaller ask or a clearer week. Booked against done is a follow-through problem — the time was there. A single \u201chours this week\u201d figure hides which one you have. A travel week has less capacity, so its target is smaller: the percentage is a share of the week you actually have, not of an ideal one. Past weeks are a record and carry no targets.",
  },
  kanban: {
    title: "Progress — commitments by whether they are keeping up",
    body:
      "Each commitment sits in a column read from reality, not a status you maintain: whether it can be judged at all, whether anything has been logged, and whether the work left fits the time left at its current weekly hours. Judging it needs an effort estimate and a date — without those a commitment sits in Needs setup, because “on pace” would otherwise be a guess, and its card names which figure is missing. Click that line on any card to set the total work, the weekly hours, the finish-by date and the dates along the way; describing the same thing to the chat does the identical job. Tasks appear under the commitment they belong to. Drag a task to change the schedule: In progress pins it to today, This week moves it up the queue, Backlog unpins it.",
  },
  eisenhower: {
    title: "Priorities — importance against urgency",
    body:
      "Importance is yours to set, on commitments and tasks alike. Urgency is read from the nearest date, so anything with no date is never urgent. The two trap quadrants are the point: urgent-but-unimportant work that eats a week, and important-but-not-urgent work that quietly never gets scheduled. If everything lands in one box, nothing has been marked important yet.",
  },
  timeline: {
    title: "Timeline — six months of dates",
    body:
      "One bar per commitment with a date, from today to the furthest one. Targets are the dots along it: hollow while pending, filled once you click them. Each one can carry the hours due by it, which is what stops a checkpoint two weeks away being measured against the whole project — click a commitment's name to set that, its dates and its hours. A date is either hard, meaning externally imposed, or a goal you set yourself — both are scheduled toward the same way, but only a goal is yours to move when it slips. Commitments with no dates sit in their own lane. This is the view for spotting two deadlines landing in the same fortnight while there is still time to move one.",
  },
  todos: {
    title: "To-Do — things to do, with as much structure as each one needs",
    body:
      "An item starts as a plain line. Open it to say what it is: just a line, due by a date, or happening at a set time. A deadline needs only a date. An event needs a start and end, and holds that slot on the calendar. Either can carry reminders and booked hours, added whenever you decide it needs them — set an earlier finish-by to book preparation. Ticking an item off clears the hours it had booked. A list can also chase itself: anything still unticked at the end of the week, month or year arrives as one notification.",
  },
  lists: {
    title: "Lists — things you are keeping rather than doing",
    body:
      "A reading list, what to pack, the standing agenda for a recurring meeting. Each list holds a paragraph, a checklist, or both. Nothing here is ever scheduled or notified, and ticking something off has no consequence anywhere else — that is the whole difference from To-Do. Completed items grey out rather than vanishing.",
  },
  trash: {
    title: "Trash — everything you have removed",
    body:
      "Removing something in this app moves it here instead of destroying it: notes, to-dos, lists, targets and events all land in the Trash, and Restore puts them back exactly where they were. Entries are grouped by the action that removed them, so a list that took fourteen items with it is one entry that restores all fifteen rows — not fifteen entries you would have to find and undo one at a time. Nothing here expires or is cleaned up on a schedule, because a timer that quietly removes things is the problem this exists to solve. Emptying the Trash is the only action in the app that destroys anything, and it asks you to type the word. Finished work is not clutter and does not come here — that is the Archive tab, and its logged hours still count.",
  },
  archive: {
    title: "Archive — everything you have finished",
    body:
      "Finished work is archived rather than deleted, so its logged hours survive. Nothing here affects your schedule, and Restore puts something back. Because the record is intact, the chat can answer “what did I get done this semester?” from real hours rather than memory.",
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
