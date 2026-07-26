"use client";

// Browsable history of archived tasks — nothing is ever hard-deleted when
// finished, so semester-scale retrospectives stay possible. Fetches its own
// rows (archived tasks are deliberately excluded from ScheduleData).

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { setTaskArchived } from "@/lib/planner/board-actions";
import type { Database } from "@/lib/supabase/database.types";

type ArchivedTask = Pick<
  Database["public"]["Tables"]["tasks"]["Row"],
  "id" | "title" | "duration_min" | "deadline_at" | "archived_at" | "category_id"
>;
type CategoryRow = Pick<Database["public"]["Tables"]["categories"]["Row"], "id" | "name" | "color">;

interface ArchiveViewProps {
  onMutated?: () => void;
}

export function ArchiveView({ onMutated }: ArchiveViewProps) {
  const [tasks, setTasks] = useState<ArchivedTask[] | null>(null);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const [{ data: rows }, { data: cats }] = await Promise.all([
      supabase
        .from("tasks")
        .select("id,title,duration_min,deadline_at,archived_at,category_id")
        .eq("user_id", user.id)
        .not("archived_at", "is", null)
        .order("archived_at", { ascending: false }),
      supabase.from("categories").select("id,name,color"),
    ]);
    setTasks(rows ?? []);
    setCategories(cats ?? []);
  }, []);

  useEffect(() => {
    // Fetch-on-mount, same pattern (and lint caveat) as useScheduleData.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function restore(id: string) {
    setBusyId(id);
    await setTaskArchived(id, false);
    await load();
    setBusyId(null);
    onMutated?.();
  }

  if (tasks === null) return <div className="px-5 py-4 text-[12px] text-muted">Loading…</div>;

  const catById = new Map(categories.map((c) => [c.id, c]));

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3">
      <div className="text-[10.5px] text-muted-2 px-1 pb-2">
        Archived tasks keep their logged hours forever — ask the planner chat for a summary of any period (e.g.
        &quot;what did I get done this semester?&quot;).
      </div>
      <div className="flex flex-col gap-1.5 max-w-xl">
        {tasks.map((t) => {
          const cat = t.category_id ? catById.get(t.category_id) : null;
          return (
            <div key={t.id} className="rounded-md border border-border bg-surface px-3 py-2 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  {cat && (
                    <span className="text-[9px] tracking-wide uppercase" style={{ color: cat.color }}>
                      {cat.name}
                    </span>
                  )}
                  <span className="text-[9px] text-muted-2">archived {t.archived_at!.slice(0, 10)}</span>
                </div>
                <div className="text-[12px] text-text truncate" title={t.title}>
                  {t.title}
                </div>
              </div>
              <button
                onClick={() => restore(t.id)}
                disabled={busyId === t.id}
                className="flex-none text-[11px] text-accent-text hover:underline disabled:opacity-50"
              >
                {busyId === t.id ? "Restoring…" : "Restore"}
              </button>
            </div>
          );
        })}
        {tasks.length === 0 && <div className="px-1 text-[11px] text-muted">Nothing archived yet.</div>}
      </div>
    </div>
  );
}
