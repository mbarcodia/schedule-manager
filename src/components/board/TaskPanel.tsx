"use client";

// A standalone task — hours of work that get scheduled onto the calendar.
//
// Creating one was chat-only, and a task that didn't come from a to-do had no
// editor anywhere: the board could star it, archive it and drag it between
// columns, but not fix its title or change how long it is. Create and edit are
// the same form here, because a create-only form is a trap — the hours you give a
// task are exactly the figure that turns out wrong.
//
// Same drawer as the commitment panel, for the same reason: a board column is
// 180px wide and this is a form.

import { useState } from "react";
import { XIcon, StarIcon, ArchiveBoxIcon } from "@phosphor-icons/react";
import { createClient } from "@/lib/supabase/client";
import { setTaskArchived } from "@/lib/planner/board-actions";
import {
  PRIORITIES,
  blankTaskDraft,
  chunkFor,
  describeChunking,
  taskDraft,
  taskRowFields,
  validateTask,
  type TaskDraft,
} from "@/lib/planner/task-form";
import { WhyNotLine } from "./WhyNotLine";
import type { Database } from "@/lib/supabase/database.types";
import type { Reason } from "@/lib/scheduling/why-not";
import type { Category, Project } from "@/lib/scheduling/types";

type TaskRow = Database["public"]["Tables"]["tasks"]["Row"];

export function TaskPanel({
  task,
  projects,
  categories,
  whyNot = null,
  onClose,
  onSaved,
}: {
  /** Null while creating one. */
  task: TaskRow | null;
  projects: Project[];
  categories: Category[];
  /** Why its hours aren't all on the calendar — shown at the top, since it names
   * which of the fields below is the one to change. */
  whyNot?: Reason | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<TaskDraft>(() => (task ? taskDraft(task) : blankTaskDraft()));
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errors = validateTask(draft);
  const patch = (next: Partial<TaskDraft>) => setDraft({ ...draft, ...next });

  async function save() {
    const fields = taskRowFields(draft, new Date());
    if (!fields) {
      setError(errors[0] ?? "Something about that task doesn't add up.");
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = createClient();

    if (task) {
      const { error: err } = await supabase.from("tasks").update(fields).eq("id", task.id);
      if (err) {
        setBusy(false);
        setError(`Couldn't save that task: ${err.message}`);
        return;
      }
    } else {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setBusy(false);
        setError("You appear to be signed out — reload and try again.");
        return;
      }
      // ord 0 puts it in the middle of the queue rather than at either end:
      // the board's Backlog/This Week drops are what move it, and picking an
      // extreme here would silently prioritise every new task.
      const { error: err } = await supabase.from("tasks").insert({ user_id: user.id, ord: 0, ...fields });
      if (err) {
        setBusy(false);
        setError(`Couldn't add that task: ${err.message}`);
        return;
      }
    }

    await onSaved();
    setBusy(false);
    onClose();
  }

  async function archive() {
    if (!task) return;
    setBusy(true);
    setError(null);
    await setTaskArchived(task.id, true);
    await onSaved();
    setBusy(false);
    onClose();
  }

  const field =
    "rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text outline-none focus-visible:border-accent";
  const legend = "text-[10px] tracking-wide uppercase text-muted-2";
  const hint = "text-[10px] text-muted-2";

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        aria-label="Close"
        onClick={onClose}
        className="flex-1 cursor-default"
        style={{ background: "rgba(0,0,0,0.45)" }}
      />
      <div className="relative w-full max-w-[400px] h-full overflow-y-auto border-l border-border bg-panel p-4 flex flex-col gap-4">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className={legend}>{task ? "Task" : "New task"}</div>
            <input
              value={draft.title}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="what needs doing"
              className="w-full bg-transparent text-[13px] text-text leading-snug outline-none border-b border-transparent focus-visible:border-accent"
            />
          </div>
          <button
            onClick={() => patch({ important: !draft.important })}
            title={draft.important ? "Not important" : "Mark important"}
          >
            <StarIcon
              size={14}
              weight={draft.important ? "fill" : "regular"}
              className="text-muted-2 hover:text-accent-text"
            />
          </button>
          <button onClick={onClose} aria-label="Close" className="text-muted-2 hover:text-text">
            <XIcon size={14} />
          </button>
        </div>

        <WhyNotLine reason={whyNot} size={10.5} />

        <section className="flex flex-col gap-1.5">
          <div className={legend}>How long</div>
          <div className="flex items-center gap-1.5">
            <input value={draft.hoursText} onChange={(e) => patch({ hoursText: e.target.value })} className={`${field} w-14`} />
            <span className="text-[11px] text-muted">hours of work</span>
          </div>
          <div className={hint}>
            Booked on the calendar in pieces — an hour at a time for anything over 90 minutes, in one sitting below
            that. A label&apos;s minimum chunk wins over that if it&apos;s longer.
          </div>
        </section>

        <section className="flex flex-col gap-1.5">
          <div className={legend}>Due by</div>
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={draft.deadlineDate}
              onChange={(e) => patch({ deadlineDate: e.target.value })}
              className={`${field} w-32`}
            />
            <input
              type="time"
              value={draft.deadlineTime}
              onChange={(e) => patch({ deadlineTime: e.target.value })}
              className={field}
            />
          </div>
          <div className={hint}>
            A date on its own means any time that day counts — leave the time empty unless there really is one.
          </div>
        </section>

        <section className="flex flex-col gap-1.5">
          <div className={legend}>Not before</div>
          <input
            type="date"
            value={draft.startDate}
            onChange={(e) => patch({ startDate: e.target.value })}
            className={`${field} w-32`}
          />
          <div className={hint}>Nothing gets scheduled earlier than this. Empty means it can start today.</div>
        </section>

        <section className="flex flex-col gap-1.5">
          <div className={legend}>Where it belongs</div>
          <select value={draft.projectId} onChange={(e) => patch({ projectId: e.target.value })} className={field}>
            <option value="">no commitment</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          <select value={draft.categoryId} onChange={(e) => patch({ categoryId: e.target.value })} className={field}>
            <option value="">no label</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            value={draft.priority}
            onChange={(e) => patch({ priority: e.target.value as TaskDraft["priority"] })}
            className={field}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p} priority
              </option>
            ))}
          </select>
          <div className={hint}>
            Priority decides what gets the good slots when the week is full; the label decides how its time is
            scheduled.
          </div>
        </section>

        {/* The three placement levers, last because the defaults are right for
           almost everything — and each one can make a task harder to schedule,
           so the hints say what each costs rather than only what it does. */}
        <section className="flex flex-col gap-1.5">
          <div className={legend}>How it gets placed</div>
          <select
            value={draft.timeOfDay}
            onChange={(e) => patch({ timeOfDay: e.target.value as TaskDraft["timeOfDay"] })}
            className={field}
          >
            <option value="">any time of day</option>
            <option value="morning">mornings only</option>
            <option value="afternoon">afternoons only</option>
          </select>
          <div className={hint}>
            {draft.timeOfDay
              ? "A hard rule: it won't be placed in the other half of the day even if that means not fitting this week."
              : "Its label's own time-of-day rule still applies underneath, if it has one."}
          </div>

          <div className="flex items-center gap-1.5 pt-1">
            <input
              value={draft.maxPerDayText}
              onChange={(e) => patch({ maxPerDayText: e.target.value })}
              placeholder="—"
              className={`${field} w-14`}
            />
            <span className="text-[11px] text-muted">minutes a day at most</span>
          </div>
          <div className={hint}>Spreads it out instead of taking it in as few sittings as fit. Empty means no cap.</div>

          <div className="flex items-center gap-1.5 pt-1">
            <input
              value={draft.chunkText}
              onChange={(e) => patch({ chunkText: e.target.value })}
              placeholder={String(chunkFor(Math.round((Number(draft.hoursText) || 0) * 60)) || 30)}
              className={`${field} w-14`}
            />
            <span className="text-[11px] text-muted">minutes per block</span>
          </div>
          <div className={hint}>
            Empty uses the default shown — an hour for anything over 90 minutes, otherwise the whole task in one
            sitting. A label&apos;s minimum chunk still overrides a shorter one.
          </div>
          {/* Neither of these combinations is refused, because the scheduler
             resolves both. It just doesn't resolve them the way the numbers as
             typed suggest, so it says which one wins. */}
          {describeChunking(draft) && <div className={hint}>{describeChunking(draft)}</div>}
        </section>

        {(error || errors.length > 0) && (
          <div className="text-[10.5px] leading-snug" style={{ color: "#e5484d" }}>
            {error ?? errors[0]}
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={() => void save()}
            disabled={busy || errors.length > 0}
            className="rounded-md border border-accent text-accent px-2.5 py-1 text-[11px] font-medium hover:bg-accent/10 disabled:opacity-50"
          >
            {busy ? "Saving…" : task ? "Save" : "Add it"}
          </button>
          <button onClick={onClose} className="text-[10.5px] text-muted-2 hover:text-text">
            cancel
          </button>
          {task && (
            <div className="ml-auto">
              {confirmArchive ? (
                <span className="text-[10px] text-muted-2">
                  Put it away?{" "}
                  <button onClick={() => void archive()} disabled={busy} className="text-accent-text hover:underline">
                    yes
                  </button>{" "}
                  <button onClick={() => setConfirmArchive(false)} className="hover:underline">
                    no
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmArchive(true)}
                  title="Off the board, logged hours kept — restore it from Archive"
                  className="flex items-center gap-1 text-[10px] text-muted-2 hover:text-text"
                >
                  <ArchiveBoxIcon size={11} /> done with this
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
