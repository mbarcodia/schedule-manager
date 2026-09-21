"use client";

// The planner page's right-hand rail: every trackable with its notes nested
// under it, plus unlinked notes. Notes are editable inline (settings-page
// style direct CRUD); the planner's own tool-created notes appear on the
// refreshes triggered after each reply.

import { useCallback, useEffect, useState } from "react";
import { CaretDownIcon, CaretRightIcon, TrashIcon } from "@phosphor-icons/react";
import { createClient } from "@/lib/supabase/client";
import { softDelete } from "@/lib/db/soft-delete";
import { writeError } from "@/lib/planner/write";
import { appendChecklistItem, parseChecklist, toggleChecklistLine } from "@/lib/planner/checklist";
import type { Database, NoteKind } from "@/lib/supabase/database.types";

type NoteRow = Database["public"]["Tables"]["notes"]["Row"];

interface Project {
  id: string;
  title: string;
}

interface PlannerSidebarProps {
  /** Bumped by the page after each planner reply to refetch. */
  refreshKey: number;
}

const KIND_LABEL: Record<NoteKind, string> = {
  idea: "Idea",
  todo: "To-do",
  paper: "Paper",
  update: "Update",
  other: "Note",
};

export function PlannerSidebar({ refreshKey }: PlannerSidebarProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** A todo note open as a checklist by default; set to view its raw
   * markdown instead — for renaming/reordering/deleting lines, which a
   * checkbox row can't do. Cleared whenever a different note is opened. */
  const [textEditId, setTextEditId] = useState<string | null>(null);
  const [newItemText, setNewItemText] = useState<Record<string, string>>({});
  /** A note that didn't save. Shown rather than swallowed: this editor used to
   * close on failure, which is the "Save does nothing" shape exactly. */
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const [{ data: rows }, { data: noteRows }] = await Promise.all([
      // Archived commitments drop out of this list: they are off every board, so
      // a heading for one here would be the only place it still appeared. Its
      // notes stay in the database and come back with it.
      supabase.from("projects").select("id,title").eq("user_id", user.id).is("archived_at", null),
      supabase.from("notes").select("*").is("deleted_at", null).eq("user_id", user.id).order("updated_at", { ascending: false }),
    ]);
    setProjects(rows ?? []);
    setNotes(noteRows ?? []);
  }, []);

  useEffect(() => {
    // Fetch-on-mount, and again whenever the chat reports a mutation — same
    // pattern (and lint caveat) as useScheduleData, TodoView and ArchiveView.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshKey]);

  async function saveNote(note: NoteRow) {
    const supabase = createClient();
    const message = await writeError(
      "Couldn't save that note",
      supabase.from("notes").update({ content: draft, updated_at: new Date().toISOString() }).eq("id", note.id),
    );
    // The editor stays OPEN on failure, so the text you typed is still there.
    // Closing it and reloading — which is what this did — threw the edit away
    // and looked exactly like a successful save.
    if (message) return setError(message);
    setError(null);
    setOpenId(null);
    void load();
  }

  /** Writes immediately — a checkbox is a click, not a form, and waiting for
   * a separate Save would mean the check visibly un-does itself until you
   * remember to press it. */
  async function writeChecklistContent(note: NoteRow, content: string) {
    const supabase = createClient();
    const message = await writeError(
      "Couldn't update that checklist",
      supabase.from("notes").update({ content, updated_at: new Date().toISOString() }).eq("id", note.id),
    );
    if (message) return setError(message);
    setError(null);
    void load();
  }

  async function toggleItem(note: NoteRow, line: number, checked: boolean) {
    await writeChecklistContent(note, toggleChecklistLine(note.content, line, checked));
  }

  async function addItem(note: NoteRow) {
    const text = (newItemText[note.id] ?? "").trim();
    if (!text) return;
    setNewItemText((prev) => ({ ...prev, [note.id]: "" }));
    await writeChecklistContent(note, appendChecklistItem(note.content, text));
  }

  async function deleteNote(note: NoteRow) {
    const supabase = createClient();
    const message = await softDelete(supabase, "notes", note.id, "Couldn't move that note to Trash");
    if (message) return setError(message);
    setError(null);
    setOpenId(null);
    void load();
  }

  function renderNote(n: NoteRow) {
    const open = openId === n.id;
    const items = n.kind === "todo" ? parseChecklist(n.content) : [];
    // A checklist opens AS a checklist — raw markdown is what "edit as text"
    // is for, not the default view of something meant to be ticked off.
    const asText = textEditId === n.id || n.kind !== "todo";
    return (
      <div key={n.id} className="rounded-md border border-border bg-surface">
        <button
          onClick={() => {
            const next = open ? null : n.id;
            setOpenId(next);
            setDraft(n.content);
            setTextEditId(null);
          }}
          className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left"
        >
          {open ? (
            <CaretDownIcon size={10} className="flex-none text-muted" />
          ) : (
            <CaretRightIcon size={10} className="flex-none text-muted" />
          )}
          <span className="text-[9px] tracking-wide uppercase text-muted-2 flex-none">{KIND_LABEL[n.kind]}</span>
          <span className="text-[11.5px] text-text truncate">{n.title}</span>
          {items.length > 0 && (
            <span className="flex-none text-[9.5px] text-muted-2">
              {items.filter((i) => i.checked).length}/{items.length}
            </span>
          )}
        </button>
        {open && !asText && (
          <div className="px-2 pb-2 flex flex-col gap-1.5">
            {items.length === 0 && <div className="px-1 text-[10.5px] text-muted-2">no steps yet</div>}
            {items.map((it) => (
              <label key={it.line} className="flex items-start gap-1.5 px-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={it.checked}
                  onChange={(e) => void toggleItem(n, it.line, e.target.checked)}
                  className="mt-0.5 flex-none"
                />
                <span className={`text-[11.5px] leading-snug ${it.checked ? "text-muted-2 line-through" : "text-text"}`}>
                  {it.text}
                </span>
              </label>
            ))}
            <div className="flex items-center gap-1.5 px-1 pt-0.5">
              <input
                value={newItemText[n.id] ?? ""}
                onChange={(e) => setNewItemText((prev) => ({ ...prev, [n.id]: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && void addItem(n)}
                placeholder="add a step"
                className="flex-1 min-w-0 bg-transparent text-[11.5px] text-text outline-none placeholder:text-muted border-b border-transparent focus-visible:border-accent"
              />
              <button onClick={() => void addItem(n)} className="flex-none text-[11px] text-accent-text hover:underline">
                Add
              </button>
            </div>
            <div className="flex items-center gap-2 pt-0.5">
              <button
                onClick={() => setTextEditId(n.id)}
                className="text-[10.5px] text-muted-2 hover:text-text"
              >
                edit as text ▸
              </button>
              <button
                onClick={() => void deleteNote(n)}
                title="Delete note"
                className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted hover:text-red-300"
              >
                <TrashIcon size={12} /> Delete
              </button>
            </div>
          </div>
        )}
        {open && asText && (
          <div className="px-2 pb-2 flex flex-col gap-1.5">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={6}
              className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-[11.5px] text-text outline-none focus-visible:border-accent resize-y"
            />
            {n.kind === "todo" && (
              <div className="text-[10px] text-muted-2">
                One <code>- [ ] step</code> or <code>- [x] step</code> per line.
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={() => void saveNote(n)}
                className="border border-accent text-accent rounded-md px-2.5 py-1 text-[11px] font-medium hover:bg-accent/10"
              >
                Save
              </button>
              {n.kind === "todo" && (
                <button
                  onClick={() => setTextEditId(null)}
                  className="text-[10.5px] text-muted-2 hover:text-text"
                >
                  back to checklist ▸
                </button>
              )}
              <button
                onClick={() => void deleteNote(n)}
                title="Delete note"
                className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-red-300"
              >
                <TrashIcon size={12} /> Delete
              </button>
              <span className="ml-auto text-[10px] text-muted-2">edited {new Date(n.updated_at).toLocaleDateString()}</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  const notesFor = (c: Project) => notes.filter((n) => n.project_id === c.id);
  const unlinked = notes.filter((n) => !n.project_id && !n.task_id);
  const taskLinked = notes.filter((n) => n.task_id);

  return (
    <div className="flex-none w-[320px] border-l border-border flex flex-col min-h-0">
      {error && (
        <div className="flex-none px-4 py-2 text-[11px] border-b border-border" style={{ color: "#e5484d" }}>
          {error}{" "}
          <button onClick={() => setError(null)} className="text-muted-2 hover:text-text">
            dismiss
          </button>
        </div>
      )}
      <div className="flex-none px-4 py-3.5 border-b border-border flex items-start justify-between gap-2">
        <div>
          <div className="font-medium text-[13px]">Project notes</div>
          <div className="mt-0.5 text-[11px] text-muted">
              What the planner has learned about each project. Separate from the Lists tab, which is yours to
              write.
            </div>
        </div>
        <a
          href="/api/planner/export"
          download
          className="flex-none text-[10.5px] text-accent-text hover:underline whitespace-nowrap"
        >
          Export
        </a>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3 min-h-0">
        {projects.map((c) => (
          <div key={c.id}>
            <div className="flex items-baseline gap-1.5 px-1 pb-1">
              {/* Which of the three kinds a project is isn't something the
                  user acts on, so it stays out of the way. */}
              <span className="text-[12px] font-medium text-text truncate">{c.title}</span>
            </div>
            <div className="flex flex-col gap-1">
              {notesFor(c).map(renderNote)}
              {notesFor(c).length === 0 && <div className="px-1 text-[10.5px] text-muted-2">no notes yet</div>}
            </div>
          </div>
        ))}
        {taskLinked.length > 0 && (
          <div>
            <div className="px-1 pb-1 text-[9px] tracking-wide uppercase text-muted-2">Notes on tasks</div>
            <div className="flex flex-col gap-1">{taskLinked.map(renderNote)}</div>
          </div>
        )}
        {unlinked.length > 0 && (
          <div>
            <div className="px-1 pb-1 text-[9px] tracking-wide uppercase text-muted-2">Unlinked</div>
            <div className="flex flex-col gap-1">{unlinked.map(renderNote)}</div>
          </div>
        )}
        {projects.length === 0 && notes.length === 0 && (
          <div className="px-1 text-[11px] text-muted">
            Nothing here yet — tell the planner about a project and it will start keeping track.
          </div>
        )}
      </div>
    </div>
  );
}
