"use client";

// Browsable history of what's been put away — nothing is hard-deleted when
// finished, so semester-scale retrospectives stay possible. Fetches its own rows,
// since archived ones are deliberately excluded from ScheduleData.
//
// Commitments as well as tasks (migration 0037). Before that a commitment could
// only be deleted, which took its progress_log rows and its targets with it — so
// this view answered "what did I get done?" from loose tasks alone while the
// weekly-hours work that makes up most of a research week was unrecoverable.

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { setCommitmentArchived, setTaskArchived } from "@/lib/planner/board-actions";
import type { Database } from "@/lib/supabase/database.types";

type ArchivedTask = Pick<
  Database["public"]["Tables"]["tasks"]["Row"],
  "id" | "title" | "duration_min" | "deadline_at" | "archived_at" | "category_id"
>;
type ArchivedCommitment = Pick<
  Database["public"]["Tables"]["projects"]["Row"],
  "id" | "title" | "archived_at" | "category_id" | "effort_estimate_min"
>;
type CategoryRow = Pick<Database["public"]["Tables"]["categories"]["Row"], "id" | "name" | "color">;

interface ArchiveViewProps {
  onMutated?: () => void;
}

export function ArchiveView({ onMutated }: ArchiveViewProps) {
  const [tasks, setTasks] = useState<ArchivedTask[] | null>(null);
  const [commitments, setCommitments] = useState<ArchivedCommitment[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const [{ data: rows }, { data: projects }, { data: cats }] = await Promise.all([
      supabase
        .from("tasks")
        .select("id,title,duration_min,deadline_at,archived_at,category_id")
        .eq("user_id", user.id)
        .not("archived_at", "is", null)
        .order("archived_at", { ascending: false }),
      supabase
        .from("projects")
        .select("id,title,archived_at,category_id,effort_estimate_min")
        .eq("user_id", user.id)
        .not("archived_at", "is", null)
        .order("archived_at", { ascending: false }),
      supabase.from("categories").select("id,name,color"),
    ]);
    setTasks(rows ?? []);
    setCommitments(projects ?? []);
    setCategories(cats ?? []);
  }, []);

  useEffect(() => {
    // Fetch-on-mount, same pattern (and lint caveat) as useScheduleData.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function restoreTask(id: string) {
    setBusyId(id);
    setError(null);
    await setTaskArchived(id, false);
    await load();
    setBusyId(null);
    onMutated?.();
  }

  async function restoreCommitment(id: string) {
    setBusyId(id);
    setError(null);
    const message = await setCommitmentArchived(id, false);
    if (message) setError(`Couldn't restore that commitment: ${message}`);
    else await load();
    setBusyId(null);
    onMutated?.();
  }

  if (tasks === null) return <div className="px-5 py-4 text-[12px] text-muted">Loading…</div>;

  const catById = new Map(categories.map((c) => [c.id, c]));
  const label = (categoryId: string | null) => (categoryId ? catById.get(categoryId) : null);

  const row = (
    key: string,
    categoryId: string | null,
    archivedAt: string | null,
    title: string,
    extra: string | null,
    onRestore: () => void,
  ) => {
    const cat = label(categoryId);
    return (
      <div key={key} className="rounded-md border border-border bg-surface px-3 py-2 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            {cat && (
              <span className="text-[9px] tracking-wide uppercase" style={{ color: cat.color }}>
                {cat.name}
              </span>
            )}
            <span className="text-[9px] text-muted-2">
              archived {archivedAt ? new Date(archivedAt).toLocaleDateString() : "—"}
              {extra ? ` · ${extra}` : ""}
            </span>
          </div>
          <div className="text-[12px] text-text truncate" title={title}>
            {title}
          </div>
        </div>
        <button
          onClick={onRestore}
          disabled={busyId === key}
          className="flex-none text-[11px] text-accent-text hover:underline disabled:opacity-50"
        >
          {busyId === key ? "Restoring…" : "Restore"}
        </button>
      </div>
    );
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3">
      <div className="text-[10.5px] text-muted-2 px-1 pb-2">
        Everything here keeps its logged hours forever — ask the planner chat for a summary of any period (e.g.
        &quot;what did I get done this semester?&quot;). Restoring a commitment brings back its dates and its
        estimate too.
      </div>

      {error && (
        <div className="px-1 pb-2 text-[10.5px]" style={{ color: "#e5484d" }}>
          {error}
        </div>
      )}

      <div className="flex flex-col gap-1.5 max-w-xl">
        {commitments.length > 0 && (
          <>
            <div className="px-1 pt-1 text-[10px] tracking-wide uppercase text-muted-2 font-medium">Commitments</div>
            {commitments.map((c) =>
              row(
                c.id,
                c.category_id,
                c.archived_at,
                c.title,
                c.effort_estimate_min ? `${Math.round(c.effort_estimate_min / 60)}h estimated` : null,
                () => void restoreCommitment(c.id),
              ),
            )}
          </>
        )}

        {tasks.length > 0 && (
          <>
            <div className="px-1 pt-2 text-[10px] tracking-wide uppercase text-muted-2 font-medium">Tasks</div>
            {tasks.map((t) => row(t.id, t.category_id, t.archived_at, t.title, null, () => void restoreTask(t.id)))}
          </>
        )}

        {tasks.length === 0 && commitments.length === 0 && (
          <div className="px-1 text-[11px] text-muted">Nothing archived yet.</div>
        )}
      </div>
    </div>
  );
}
