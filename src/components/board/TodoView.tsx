"use client";

// Named checklists. Nothing here touches the schedule — that's the point:
// a to-do is something to do, not hours to place.

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";

type ListRow = Database["public"]["Tables"]["todo_lists"]["Row"];
type ItemRow = Database["public"]["Tables"]["todo_items"]["Row"];

export function TodoView() {
  const [lists, setLists] = useState<ListRow[] | null>(null);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [newList, setNewList] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const [{ data: listRows }, { data: itemRows }] = await Promise.all([
      supabase.from("todo_lists").select("*").order("sort_order").order("name"),
      supabase.from("todo_items").select("*").order("sort_order").order("created_at"),
    ]);
    setLists(listRows ?? []);
    setItems(itemRows ?? []);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function addList() {
    const name = newList.trim();
    if (!name) return;
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setNewList("");
    await supabase.from("todo_lists").insert({ user_id: user.id, name });
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
    await supabase.from("todo_items").insert({ user_id: user.id, list_id: listId, text });
    await load();
  }

  async function toggle(item: ItemRow) {
    const supabase = createClient();
    await supabase
      .from("todo_items")
      .update({ done: !item.done, completed_at: item.done ? null : new Date().toISOString() })
      .eq("id", item.id);
    await load();
  }

  async function removeItem(id: string) {
    const supabase = createClient();
    await supabase.from("todo_items").delete().eq("id", id);
    await load();
  }

  async function removeList(list: ListRow) {
    if (!confirm(`Delete the "${list.name}" list and everything on it?`)) return;
    const supabase = createClient();
    await supabase.from("todo_lists").delete().eq("id", list.id);
    await load();
  }

  if (lists === null) return <div className="px-5 py-4 text-[12px] text-muted">Loading…</div>;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <input
          value={newList}
          onChange={(e) => setNewList(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addList()}
          placeholder="New list name (e.g. This week)"
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text outline-none focus-visible:border-accent"
        />
        <button onClick={addList} className="text-xs text-accent hover:underline">
          + Add list
        </button>
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          show completed
        </label>
      </div>

      {lists.length === 0 && (
        <p className="text-[12px] text-muted max-w-xl">
          No lists yet. Create one above, or just tell the chat — &ldquo;add write email to Rich to my This week
          list&rdquo; — and it will make the list if it doesn&apos;t exist. Items here never take calendar time; ask
          for hours separately when something needs real work booked.
        </p>
      )}

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
        {lists.map((list) => {
          const listItems = items.filter((i) => i.list_id === list.id && (showDone || !i.done));
          const openCount = items.filter((i) => i.list_id === list.id && !i.done).length;
          return (
            <div key={list.id} className="rounded-lg border border-border bg-panel p-3 flex flex-col min-h-[120px]">
              <div className="flex items-baseline gap-1.5 mb-2">
                <span className="text-[12px] font-medium text-text truncate">{list.name}</span>
                <span className="text-[10px] text-muted-2">{openCount}</span>
                <button
                  onClick={() => removeList(list)}
                  className="ml-auto text-[10px] text-muted-2 hover:text-text flex-none"
                >
                  delete
                </button>
              </div>

              <div className="flex flex-col gap-1 flex-1">
                {listItems.map((item) => (
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
                      onClick={() => removeItem(item.id)}
                      className="flex-none text-[10px] text-muted-2 opacity-0 group-hover:opacity-100 hover:text-text"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {listItems.length === 0 && <div className="text-[10.5px] text-muted-2">nothing here</div>}
              </div>

              <input
                value={draft[list.id] ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [list.id]: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && addItem(list.id)}
                placeholder="Add an item…"
                className="mt-2 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text outline-none focus-visible:border-accent"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
