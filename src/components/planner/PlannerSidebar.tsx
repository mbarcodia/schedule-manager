"use client";

// The planner page's right-hand rail: every trackable with its notes nested
// under it, plus unlinked notes. Notes are editable inline (settings-page
// style direct CRUD); the planner's own tool-created notes appear on the
// refreshes triggered after each reply.

import { useCallback, useEffect, useState } from "react";
import { CaretDownIcon, CaretRightIcon, TrashIcon } from "@phosphor-icons/react";
import { createClient } from "@/lib/supabase/client";
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

  const load = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const [{ data: rows }, { data: noteRows }] = await Promise.all([
      supabase.from("projects").select("id,title").eq("user_id", user.id),
      supabase.from("notes").select("*").eq("user_id", user.id).order("updated_at", { ascending: false }),
    ]);
    setProjects(rows ?? []);
    setNotes(noteRows ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function saveNote(note: NoteRow) {
    const supabase = createClient();
    await supabase.from("notes").update({ content: draft, updated_at: new Date().toISOString() }).eq("id", note.id);
    setOpenId(null);
    void load();
  }

  async function deleteNote(note: NoteRow) {
    const supabase = createClient();
    await supabase.from("notes").delete().eq("id", note.id);
    setOpenId(null);
    void load();
  }

  function renderNote(n: NoteRow) {
    const open = openId === n.id;
    return (
      <div key={n.id} className="rounded-md border border-border bg-surface">
        <button
          onClick={() => {
            setOpenId(open ? null : n.id);
            setDraft(n.content);
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
        </button>
        {open && (
          <div className="px-2 pb-2 flex flex-col gap-1.5">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={6}
              className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-[11.5px] text-text outline-none focus-visible:border-accent resize-y"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => void saveNote(n)}
                className="border border-accent text-accent rounded-md px-2.5 py-1 text-[11px] font-medium hover:bg-accent/10"
              >
                Save
              </button>
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
