"use client";

// Everything pace needs about one commitment, in one place you can type into.
//
// Pace asks three things — how much work in total, how many hours a week, and by
// when — and reports which of them is missing when it can't answer. Every one of
// those could previously only be set by talking to the chat, so a card reading
// "needs estimate and weekly hours to be measurable" named a gap it gave you no
// way to close. Both paths now write the same columns: a word dump into the chat
// for setting things up in a sentence, this panel for entering a figure directly.
//
// A drawer rather than an expanding section because it opens from two places —
// a commitment card in a 180px-wide board column, and a row on the Timeline —
// and the form is the same form either way.
//
// The dates inside a commitment live here too, since they carry the fourth
// figure: how much of the work is due by each one. Without that, pace measures
// the whole commitment against its next checkpoint and calls a two-week form
// months behind (see lib/scheduling/pace.ts).

import { useState } from "react";
import { XIcon, PlusIcon, TrashIcon, StarIcon, ArchiveBoxIcon } from "@phosphor-icons/react";
import {
  addTarget,
  createCommitment,
  deleteTarget,
  saveCommitmentFields,
  saveTarget,
  setCommitmentArchived,
  setTargetHit,
} from "@/lib/planner/board-actions";
import { hoursValue, parseHours, validateCommitmentForm, type TargetDraft } from "@/lib/planner/commitment-form";
import { paceSentence, type CommitmentPace } from "@/lib/scheduling/pace";
import type { ScheduleData } from "@/lib/scheduling/fetch-schedule-data";
import type { Project, Target } from "@/lib/scheduling/types";

/** A date column holds a day. Built from local parts — toISOString() would shift
 * it a day west of Greenwich, which is how date-only fields have gone wrong here
 * before. */
function dateValue(d: Date | null | undefined): string {
  if (!d) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface Draft extends TargetDraft {
  /** Ticked off. Kept in form state rather than written on click, so one Save
   * covers the whole panel and a half-finished edit can still be cancelled. */
  hit: boolean;
}

const KINDS: { id: "hard" | "goal"; label: string; hint: string }[] = [
  { id: "hard", label: "Someone else's date", hint: "a submission or funder date — it cannot move" },
  { id: "goal", label: "A date I set", hint: "yours to move, if the work says so" },
];

export function CommitmentPanel({
  project,
  pace,
  targets,
  onClose,
  onSaved,
}: {
  /** Null while creating one — the panel then asks for a title and nothing else
   * is required, since an estimate, hours and a date are all things you may not
   * know yet and pace reports their absence rather than refusing to exist. */
  project: Project | null;
  pace: CommitmentPace | null;
  targets: Target[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [title, setTitle] = useState(project?.title ?? "");
  const [estimateText, setEstimateText] = useState(hoursValue(project?.effortEstimateMin));
  const [weeklyText, setWeeklyText] = useState(hoursValue(project?.weeklyMinMin));
  const [deadlineDate, setDeadlineDate] = useState(dateValue(project?.deadlineDate));
  const [deadlineKind, setDeadlineKind] = useState<"hard" | "goal">(project?.deadlineKind ?? "hard");
  const [activeFrom, setActiveFrom] = useState(dateValue(project?.activeFrom));
  const [activeUntil, setActiveUntil] = useState(dateValue(project?.activeUntil));
  const [important, setImportant] = useState(!!project?.important);
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    [...targets]
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .map((t) => ({
        id: t.id,
        title: t.title,
        date: dateValue(t.date),
        dateKind: t.dateKind ?? "goal",
        hoursText: hoursValue(t.effortEstimateMin),
        hit: t.completedAt != null,
      })),
  );
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { errors: fieldErrors, warnings } = validateCommitmentForm({
    estimateText,
    weeklyText,
    deadlineDate,
    activeFrom,
    activeUntil,
    targets: drafts,
  });
  const errors = title.trim() ? fieldErrors : ["A commitment needs a name.", ...fieldErrors];

  function patchDraft(index: number, patch: Partial<Draft>) {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }

  function removeDraft(index: number) {
    const draft = drafts[index];
    if (draft.id) setRemovedIds((prev) => [...prev, draft.id!]);
    setDrafts((prev) => prev.filter((_, i) => i !== index));
  }

  async function save() {
    setBusy(true);
    setError(null);
    if (errors.length) {
      setBusy(false);
      setError(errors[0]);
      return;
    }

    const fail = (message: string) => {
      setBusy(false);
      setError(message);
    };

    // Create first when there's nothing to attach to yet: the dates below need a
    // commitment id, and a half-created one with orphan targets is worse than a
    // failed save.
    let projectId = project?.id ?? null;
    if (!projectId) {
      const created = await createCommitment(title);
      if (created.error || !created.id) return fail(`Couldn't add that commitment: ${created.error ?? "unknown error"}`);
      projectId = created.id;
    }

    const commitmentError = await saveCommitmentFields(projectId, {
      title: title.trim(),
      deadlineDate: deadlineDate || null,
      deadlineKind,
      effortEstimateMin: parseHours(estimateText).minutes,
      weeklyMinMin: parseHours(weeklyText).minutes,
      important,
      activeFrom: activeFrom || null,
      activeUntil: activeUntil || null,
    });
    if (commitmentError) return fail(`Couldn't save the commitment: ${commitmentError}`);

    // Deletions first: a removed date freeing up its title is what lets the same
    // name be re-used in the same save.
    for (const id of removedIds) {
      const message = await deleteTarget(id);
      if (message) return fail(`Couldn't remove a date: ${message}`);
    }

    for (const draft of drafts) {
      const fields = {
        title: draft.title.trim(),
        date: draft.date,
        dateKind: draft.dateKind,
        effortEstimateMin: parseHours(draft.hoursText).minutes,
      };
      const message = draft.id ? await saveTarget(draft.id, fields) : await addTarget(projectId, fields);
      if (message) return fail(`Couldn't save “${fields.title}”: ${message}`);
      // completed_at is a separate one-field write, and only when it changed —
      // re-stamping it on every save would rewrite the day a target was hit.
      const wasHit = targets.find((t) => t.id === draft.id)?.completedAt != null;
      if (draft.id && draft.hit !== wasHit) {
        const hitMessage = await setTargetHit(draft.id, draft.hit);
        if (hitMessage) return fail(`Couldn't tick “${fields.title}”: ${hitMessage}`);
      }
    }

    await onSaved();
    setBusy(false);
    onClose();
  }

  /** Put away, not deleted: the logged hours, the dates and the estimate all
   * stay, and it can be brought back from the Archive tab. Confirmed first
   * because it clears the commitment off every board at once. */
  async function archive() {
    if (!project) return;
    setBusy(true);
    setError(null);
    const message = await setCommitmentArchived(project.id, true);
    if (message) {
      setBusy(false);
      setError(`Couldn't archive that: ${message}`);
      return;
    }
    await onSaved();
    setBusy(false);
    onClose();
  }

  const field =
    "rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text outline-none focus-visible:border-accent";
  const legend = "text-[10px] tracking-wide uppercase text-muted-2";
  const hint = "text-[10px] text-muted-2";

  const kindPicker = (value: "hard" | "goal", onPick: (kind: "hard" | "goal") => void) => (
    <div className="flex flex-col gap-0.5">
      {KINDS.map((k) => (
        <label key={k.id} className="flex items-baseline gap-1.5 text-[11px] text-text">
          <input type="radio" checked={value === k.id} onChange={() => onPick(k.id)} />
          <span>
            {k.label} <span className={hint}>— {k.hint}</span>
          </span>
        </label>
      ))}
    </div>
  );

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* Clicking away closes without saving, same as the cancel button. */}
      <button
        aria-label="Close"
        onClick={onClose}
        className="flex-1 cursor-default"
        style={{ background: "rgba(0,0,0,0.45)" }}
      />
      <div className="relative w-full max-w-[400px] h-full overflow-y-auto border-l border-border bg-panel p-4 flex flex-col gap-4">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className={legend}>{project ? "Commitment" : "New commitment"}</div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="what you've signed up for"
              className="w-full bg-transparent text-[13px] text-text leading-snug outline-none border-b border-transparent focus-visible:border-accent"
            />
          </div>
          <button onClick={() => setImportant(!important)} title={important ? "Not important" : "Mark important"}>
            <StarIcon size={14} weight={important ? "fill" : "regular"} className="text-muted-2 hover:text-accent-text" />
          </button>
          <button onClick={onClose} aria-label="Close" className="text-muted-2 hover:text-text">
            <XIcon size={14} />
          </button>
        </div>

        {/* The reason the fields below exist, in the panel's own words. */}
        {pace && <div className="text-[10.5px] text-muted-2 leading-snug">{paceSentence(pace)}</div>}

        <section className="flex flex-col gap-1.5">
          <div className={legend}>Is it keeping up?</div>
          <div className="flex items-center gap-1.5">
            <input value={estimateText} onChange={(e) => setEstimateText(e.target.value)} className={`${field} w-14`} />
            <span className="text-[11px] text-muted">hours of work in total</span>
          </div>
          <div className={hint}>
            A rough figure is the point — it gets revised as you log hours. Empty means pace can&apos;t be worked out.
          </div>
          <div className="flex items-center gap-1.5 pt-1">
            <input value={weeklyText} onChange={(e) => setWeeklyText(e.target.value)} className={`${field} w-14`} />
            <span className="text-[11px] text-muted">hours a week, defended</span>
          </div>
          <div className={hint}>These get found and protected on the calendar. Empty books nothing.</div>
        </section>

        <section className="flex flex-col gap-1.5">
          <div className={legend}>Finish by</div>
          <input
            type="date"
            value={deadlineDate}
            onChange={(e) => setDeadlineDate(e.target.value)}
            className={`${field} w-36`}
          />
          {deadlineDate ? kindPicker(deadlineKind, setDeadlineKind) : <div className={hint}>No date of its own.</div>}
        </section>

        {/* Sits under "finish by" because it is the other half of when this
           commitment exists in time — and it is the only way to say "not yet"
           about a commitment, as a task's start date is for a task. */}
        <section className="flex flex-col gap-1.5">
          <div className={legend}>When its hours apply</div>
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={activeFrom}
              onChange={(e) => setActiveFrom(e.target.value)}
              className={`${field} w-36`}
            />
            <span className="text-[11px] text-muted">to</span>
            <input
              type="date"
              value={activeUntil}
              onChange={(e) => setActiveUntil(e.target.value)}
              className={`${field} w-36`}
            />
          </div>
          <div className={hint}>
            {activeFrom || activeUntil
              ? "Weekly hours are only booked inside this window; both ends count as inside it. Leave an end empty for no bound."
              : "Empty both ends and its weekly hours are booked from today onwards. Set a start for something that hasn't begun yet — a course next term, a project waiting on someone else."}
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <div className={legend}>Dates along the way</div>
          <div className={hint}>
            A checkpoint that takes no calendar time. Give the hours due by it, or pace measures the whole commitment
            against that date.
          </div>
          {drafts.map((draft, i) => (
            <div key={draft.id ?? `new-${i}`} className="rounded-md border border-border bg-surface p-2 flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={draft.hit}
                  onChange={(e) => patchDraft(i, { hit: e.target.checked })}
                  title={draft.hit ? "Hit — untick to reopen" : "Tick when you hit it"}
                  disabled={!draft.id}
                />
                <input
                  value={draft.title}
                  onChange={(e) => patchDraft(i, { title: e.target.value })}
                  placeholder="what's done by then"
                  className={`${field} flex-1 min-w-0`}
                  style={draft.hit ? { textDecoration: "line-through", opacity: 0.6 } : undefined}
                />
                <button
                  onClick={() => removeDraft(i)}
                  title="Remove this date"
                  className="flex-none text-muted-2 hover:text-text"
                >
                  <TrashIcon size={12} />
                </button>
              </div>
              <div className="flex items-center gap-1.5 pl-5">
                <input
                  type="date"
                  value={draft.date}
                  onChange={(e) => patchDraft(i, { date: e.target.value })}
                  className={`${field} w-32`}
                />
                <input
                  value={draft.hoursText}
                  onChange={(e) => patchDraft(i, { hoursText: e.target.value })}
                  placeholder="hrs"
                  className={`${field} w-12`}
                />
                <span className="text-[10px] text-muted-2">hours due by it</span>
              </div>
              <div className="pl-5">{kindPicker(draft.dateKind, (dateKind) => patchDraft(i, { dateKind }))}</div>
            </div>
          ))}
          <button
            onClick={() =>
              setDrafts((prev) => [...prev, { title: "", date: "", dateKind: "goal", hoursText: "", hit: false }])
            }
            className="self-start flex items-center gap-1 text-[10.5px] text-muted-2 hover:text-text"
          >
            <PlusIcon size={11} /> add a date
          </button>
        </section>

        {warnings.map((w) => (
          <div key={w} className="text-[10px] leading-snug" style={{ color: "#e0a94e" }}>
            {w}
          </div>
        ))}
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
            {busy ? "Saving…" : project ? "Save" : "Add it"}
          </button>
          <button onClick={onClose} className="text-[10.5px] text-muted-2 hover:text-text">
            cancel
          </button>
          {project && (
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
                  title="Off the boards, hours and dates kept — restore it from Archive"
                  className="flex items-center gap-1 text-[10px] text-muted-2 hover:text-text"
                >
                  <ArchiveBoxIcon size={11} /> finished with this
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Resolves a commitment id against the board's data and mounts the panel.
 *
 * Three views open the same panel — the Progress board, the Priorities board and
 * the Timeline — and each of them already holds `data` and the computed pace, so
 * this exists to stop the same six lines of lookup being written three times and
 * drifting. Renders nothing when nothing is open. */
/** The id that opens the panel with nothing in it, ready to create one. */
export const NEW_COMMITMENT = "new";

export function CommitmentPanelHost({
  data,
  pace,
  openId,
  onClose,
  onSaved,
}: {
  data: ScheduleData;
  pace: CommitmentPace[];
  /** A commitment id, NEW_COMMITMENT, or null for closed. */
  openId: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  if (openId === NEW_COMMITMENT) {
    return <CommitmentPanel project={null} pace={null} targets={[]} onClose={onClose} onSaved={onSaved} />;
  }
  const project = openId ? data.projects.find((p) => p.id === openId) : null;
  if (!project) return null;
  return (
    <CommitmentPanel
      project={project}
      pace={pace.find((p) => p.projectId === project.id) ?? null}
      targets={data.targets.filter((t) => t.projectId === project.id)}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}
