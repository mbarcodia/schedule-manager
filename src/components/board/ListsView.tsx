"use client";

// Lists: things you're keeping track of, as opposed to things you'll do.
//
// A reading list, a packing list, the standing agenda for a recurring meeting.
// Each one holds a paragraph, a checklist, or both. Nothing here is ever
// scheduled or notified — that's exactly what separates it from the To-Do tab,
// and it's why ticking something off here has no consequences anywhere else.

import { useCallback, useEffect, useState } from "react";
import { EyeSlashIcon, EyeIcon } from "@phosphor-icons/react";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";

type ListRow = Database["public"]["Tables"]["lists"]["Row"];
type ItemRow = Database["public"]["Tables"]["list_items"]["Row"];

export function ListsView() {
  const [lists, setLists] = useState<ListRow[] | null>(null);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  /** Body text held locally while typing so every keystroke isn't a write. */
  const [bodies, setBodies] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const [{ data: listRows }, { data: itemRows }] = await Promise.all([
      supabase.from("lists").select("*").order("sort_order").order("created_at"),
      supabase.from("list_items").select("*").order("sort_order").order("created_at"),
    ]);
    setLists(listRows ?? []);
    setItems(itemRows ?? []);
    setBodies(Object.fromEntries((listRows ?? []).map((l) => [l.id, l.body])));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function addList() {
    const title = newTitle.trim();
    if (!title) return;
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setNewTitle("");
    await supabase.from("lists").insert({ user_id: user.id, title });
    await load();
  }

  async function saveBody(list: ListRow) {
    const body = bodies[list.id] ?? "";
    if (body === list.body) return;
    const supabase = createClient();
    await supabase.from("lists").update({ body }).eq("id", list.id);
    await load();
  }

  async function addItem(listId: string) {
    const text = (draft[listId] ?? "").trim();
    if (!text) return;
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setDraft((d) => ({ ...d, [listId]: "" }));
    await supabase.from("list_items").insert({ user_id: user.id, list_id: listId, text });
    await load();
  }

  async function toggle(item: ItemRow) {
    const supabase = createClient();
    await supabase
      .from("list_items")
      .update({ done: !item.done, completed_at: item.done ? null : new Date().toISOString() })
      .eq("id", item.id);
    await load();
  }

  async function setHidden(item: ItemRow, hidden: boolean) {
    const supabase = createClient();
    await supabase.from("list_items").update({ hidden }).eq("id", item.id);
    await load();
  }

  async function setShowCompleted(list: ListRow, show: boolean) {
    const supabase = createClient();
    await supabase.from("lists").update({ show_completed: show }).eq("id", list.id);
    await load();
  }

  async function removeItem(id: string) {
    const supabase = createClient();
    await supabase.from("list_items").delete().eq("id", id);
    await load();
  }

  async function removeList(list: ListRow) {
    if (!confirm(`Delete "${list.title}" and everything on it?`)) return;
    const supabase = createClient();
    await supabase.from("lists").delete().eq("id", list.id);
    await load();
  }

  if (lists === null) return <div className="px-5 py-4 text-[12px] text-muted">Loading…</div>;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addList()}
          placeholder="New list title (e.g. Reading list)"
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text outline-none focus-visible:border-accent"
        />
        <button onClick={addList} className="text-xs text-accent hover:underline">
          + Add list
        </button>
      </div>

      {lists.length === 0 && (
        <p className="text-[12px] text-muted max-w-xl">
          No lists yet. These are for things you want to keep rather than things you have to do — a reading list,
          questions for your next supervision, what to pack for a conference. Write a paragraph, tick items off, or
          both.
        </p>
      )}

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
        {lists.map((list) => {
          const all = items.filter((i) => i.list_id === list.id);
          const visible = all.filter((i) => !i.hidden && (list.show_completed || !i.done));
          const hiddenCount = all.filter((i) => i.hidden).length;
          return (
            <div key={list.id} className="rounded-lg border border-border bg-panel p-3 flex flex-col min-h-[140px]">
              <div className="flex items-baseline gap-1.5 mb-1">
                <span className="text-[12px] font-medium text-text truncate">{list.title}</span>
                <button
                  onClick={() => removeList(list)}
                  className="ml-auto text-[10px] text-muted-2 hover:text-text flex-none"
                >
                  delete
                </button>
              </div>

              <label className="flex items-center gap-1 text-[10px] text-muted-2 mb-1.5">
                <input
                  type="checkbox"
                  checked={list.show_completed}
                  onChange={(e) => setShowCompleted(list, e.target.checked)}
                />
                show completed
              </label>

              <textarea
                value={bodies[list.id] ?? ""}
                onChange={(e) => setBodies((b) => ({ ...b, [list.id]: e.target.value }))}
                onBlur={() => saveBody(list)}
                rows={2}
                placeholder="Write anything here…"
                className="mb-2 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text outline-none focus-visible:border-accent resize-y"
              />

              <div className="flex flex-col gap-0.5 flex-1">
                {visible.map((item) => (
                  <div key={item.id} className="group flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={item.done}
                      onChange={() => toggle(item)}
                      className="mt-0.5 flex-none"
                    />
                    <span
                      className="text-[11.5px] leading-snug flex-1 min-w-0"
                      style={{
                        color: item.done ? "var(--color-muted-2, #75798c)" : "var(--color-text, #e9e9ed)",
                        textDecoration: item.done ? "line-through" : "none",
                      }}
                    >
                      {item.text}
                    </span>
                    <button
                      onClick={() => setHidden(item, true)}
                      title="Hide this item"
                      className="flex-none text-muted-2 opacity-0 group-hover:opacity-100 hover:text-text"
                    >
                      <EyeSlashIcon size={12} />
                    </button>
                    <button
                      onClick={() => removeItem(item.id)}
                      title="Delete this item"
                      className="flex-none text-[10px] text-muted-2 opacity-0 group-hover:opacity-100 hover:text-text"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>

              {hiddenCount > 0 && (
                <button
                  onClick={() => {
                    for (const i of all.filter((x) => x.hidden)) void setHidden(i, false);
                  }}
                  className="mt-1 flex items-center gap-1 text-[10px] text-muted-2 hover:text-text"
                >
                  <EyeIcon size={11} /> show {hiddenCount} hidden
                </button>
              )}

              <input
                value={draft[list.id] ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [list.id]: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && addItem(list.id)}
                placeholder="Add a checklist item…"
                className="mt-2 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text outline-none focus-visible:border-accent"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
