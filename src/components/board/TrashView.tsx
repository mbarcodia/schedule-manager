"use client";

// Everything you've removed, and the way back.
//
// This view is what makes the rest of migration 0043 true. Soft deletion without
// somewhere to see the result is not a safety net, it's a leak: rows nobody can
// reach, accumulating invisibly, with "you can restore it" written on a button
// that leads nowhere. So the promise made in every confirmation dialog —
// "restore it from the Trash tab" — is kept here.
//
// Grouped by WHEN, not by what. Removing a list removes fourteen things in one
// action, and the question afterwards is "undo that", not "find the fourteen
// rows". Rows trashed in the same action share an exact timestamp (see
// soft-delete.ts), so grouping by it reassembles the action and restoring the
// group reverses precisely it — no more, no less.

import { useCallback, useEffect, useState } from "react";
import { ArrowCounterClockwiseIcon, TrashIcon } from "@phosphor-icons/react";
import { createClient } from "@/lib/supabase/client";
import { restore, restoreTodoList, restoreList, type TrashableTable } from "@/lib/db/soft-delete";
import { emptyTrash } from "@/lib/db/purge-trash";
import { useConfirmDialog } from "@/components/ui/useConfirmDialog";

interface TrashRow {
  table: TrashableTable;
  id: string;
  label: string;
  deletedAt: string;
  /** Rows that went in the same action and come back with it. */
  children: number;
}

/** What each table is called in a sentence. */
const NOUN: Record<TrashableTable, string> = {
  notes: "Note",
  todo_items: "To-do",
  todo_lists: "To-do list",
  lists: "List",
  list_items: "List item",
  targets: "Target",
  events: "Event",
  routine_notes: "Routine note",
};

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export function TrashView({ onMutated }: { onMutated?: () => void }) {
  const [rows, setRows] = useState<TrashRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDialog, ask] = useConfirmDialog();

  const load = useCallback(async () => {
    const supabase = createClient();
    const [notes, todoItems, todoLists, lists, listItems, targets, events, routineNotes] = await Promise.all([
      supabase.from("notes").select("id,title,deleted_at").not("deleted_at", "is", null),
      supabase.from("todo_items").select("id,text,deleted_at,list_id").not("deleted_at", "is", null),
      supabase.from("todo_lists").select("id,name,deleted_at").not("deleted_at", "is", null),
      supabase.from("lists").select("id,title,deleted_at").not("deleted_at", "is", null),
      supabase.from("list_items").select("id,text,deleted_at,list_id").not("deleted_at", "is", null),
      supabase.from("targets").select("id,title,deleted_at").not("deleted_at", "is", null),
      supabase.from("events").select("id,title,deleted_at").not("deleted_at", "is", null),
      // Only ones explicitly removed reach here. A note whose window has closed
      // is NOT deleted — it stays live on its routine and merely stops being
      // surfaced (migration 0044), so it must never appear in the Trash.
      supabase.from("routine_notes").select("id,body,deleted_at").not("deleted_at", "is", null),
    ]);

    const all: TrashRow[] = [];
    const push = (table: TrashableTable, id: string, label: string, deletedAt: string | null) => {
      if (deletedAt) all.push({ table, id, label, deletedAt, children: 0 });
    };
    (notes.data ?? []).forEach((r) => push("notes", r.id, r.title, r.deleted_at));
    (todoLists.data ?? []).forEach((r) => push("todo_lists", r.id, r.name, r.deleted_at));
    (lists.data ?? []).forEach((r) => push("lists", r.id, r.title, r.deleted_at));
    (targets.data ?? []).forEach((r) => push("targets", r.id, r.title, r.deleted_at));
    (events.data ?? []).forEach((r) => push("events", r.id, r.title, r.deleted_at));
    (routineNotes.data ?? []).forEach((r) => push("routine_notes", r.id, r.body, r.deleted_at));

    // An item trashed AS PART OF its list is not listed separately — it is shown
    // as a count on the list, and restoring the list brings it back. An item
    // trashed on its own has a timestamp no list shares, so it gets its own row.
    // Without this the view would show fifteen entries for one action and invite
    // you to restore an item into a list that is still in the Trash.
    const listStamp = new Map<string, string>();
    (todoLists.data ?? []).forEach((l) => l.deleted_at && listStamp.set(l.id, l.deleted_at));
    (lists.data ?? []).forEach((l) => l.deleted_at && listStamp.set(l.id, l.deleted_at));

    for (const r of todoItems.data ?? []) {
      if (r.deleted_at && listStamp.get(r.list_id) === r.deleted_at) {
        const parent = all.find((a) => a.table === "todo_lists" && a.id === r.list_id);
        if (parent) parent.children++;
        continue;
      }
      push("todo_items", r.id, r.text, r.deleted_at);
    }
    for (const r of listItems.data ?? []) {
      if (r.deleted_at && listStamp.get(r.list_id) === r.deleted_at) {
        const parent = all.find((a) => a.table === "lists" && a.id === r.list_id);
        if (parent) parent.children++;
        continue;
      }
      push("list_items", r.id, r.text, r.deleted_at);
    }

    all.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    setRows(all);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function restoreRow(row: TrashRow) {
    setBusyId(row.id);
    setError(null);
    const supabase = createClient();
    const message =
      row.table === "todo_lists"
        ? await restoreTodoList(supabase, row.id, row.deletedAt)
        : row.table === "lists"
          ? await restoreList(supabase, row.id, row.deletedAt)
          : await restore(supabase, row.table, row.id, `Couldn't restore that ${NOUN[row.table].toLowerCase()}`);
    setBusyId(null);
    if (message) return setError(message);
    await load();
    onMutated?.();
  }

  async function empty() {
    // Typed rather than clicked. This is the only destructive action left in the
    // app, and a Delete button one careless click from an OK is not meaningfully
    // different from the hard deletes this whole change removed.
    const n = rows?.length ?? 0;
    const ok = await ask({
      title: `Permanently destroy ${n} item${n === 1 ? "" : "s"} in the Trash?`,
      lines: [
        "Everything listed here is deleted from the database outright.",
        "There is no second copy — this is not the same as removing it.",
        "A backup taken before now would still have it (npm run backup).",
      ],
      footnote: "This is the only action in this app that cannot be undone.",
      confirmLabel: "Empty Trash",
      danger: true,
      typeToConfirm: "EMPTY",
    });
    if (!ok) return;
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return setError("You appear to be signed out — reload and try again.");
    const { error: err } = await emptyTrash(supabase, user.id);
    if (err) return setError(err);
    await load();
    onMutated?.();
  }

  if (rows === null) return <div className="px-5 py-4 text-[12px] text-muted">Loading…</div>;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      {confirmDialog}
      {error && (
        <div className="mb-2 text-[11px]" style={{ color: "#e5484d" }}>
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="text-[12px] text-muted">
          Nothing in the Trash. Anything you remove lands here and stays until you empty it — nothing expires on its own.
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="text-[11px] text-muted">
              {rows.length} item{rows.length === 1 ? "" : "s"}. Nothing here is scheduled, counted, or shown anywhere
              else — and nothing is removed on a timer.
            </div>
            <button
              onClick={empty}
              className="flex-none rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-text"
            >
              <TrashIcon size={12} className="inline mr-1" />
              Empty Trash
            </button>
          </div>

          <div className="flex flex-col gap-1">
            {rows.map((row) => (
              <div
                key={`${row.table}:${row.id}`}
                className="flex items-center gap-2 rounded-md border border-border bg-panel px-3 py-2"
              >
                <span className="flex-none text-[10px] uppercase tracking-wide text-muted-2 w-[76px]">
                  {NOUN[row.table]}
                </span>
                <span className="flex-1 min-w-0 truncate text-[12px] text-text">
                  {row.label || <span className="text-muted-2">(untitled)</span>}
                  {row.children > 0 && (
                    <span className="text-[11px] text-muted"> · with {row.children} item{row.children === 1 ? "" : "s"}</span>
                  )}
                </span>
                <span className="flex-none text-[10px] text-muted-2">{ago(row.deletedAt)}</span>
                <button
                  onClick={() => restoreRow(row)}
                  disabled={busyId === row.id}
                  className="flex-none rounded border border-border px-1.5 py-0.5 text-[10px] text-accent-text hover:underline disabled:opacity-60"
                >
                  <ArrowCounterClockwiseIcon size={11} className="inline mr-0.5" />
                  Restore
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
