"use client";

// To-Do: things you have to do, grouped into lists you name.
//
// A to-do starts as a bare line of text and stays that way unless you ask for
// more. Open one and it can gain a date, reminders counting back from that
// date, hours booked on the calendar, and separately hours booked to prepare
// for it — each optional, each editable later. That "later" matters: the common
// path is jotting something down now and deciding weeks afterwards that it
// actually needs time.
//
// Reminders used to be their own tab, which meant "present at the seminar" and
// "warn me a week before the seminar" were two unrelated records.

import { useCallback, useEffect, useState } from "react";
import { EyeSlashIcon, EyeIcon, CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import { createClient } from "@/lib/supabase/client";
import { TodoItemPanel } from "./TodoItemPanel";
import type { ChaseCadence, Database } from "@/lib/supabase/database.types";

type ListRow = Database["public"]["Tables"]["todo_lists"]["Row"];
type ItemRow = Database["public"]["Tables"]["todo_items"]["Row"];
type CategoryRow = Database["public"]["Tables"]["categories"]["Row"];
type TaskRow = Database["public"]["Tables"]["tasks"]["Row"];

/** Said as a plain outcome rather than a verb: the earlier wording ("chased
 * weekly") described the mechanism and left the user guessing what it did. */
const CHASE_LABEL: Record<ChaseCadence, string> = {
  week: "notify me at the end of each week",
  month: "notify me at the end of each month",
  year: "notify me at the end of each year",
};

const fmtDue = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** What's already attached to an item, or null when it's still a plain line.
 * Doubles as the label on the control that opens the panel, so the row always
 * says both what it has and where to change it. */
function settingsSummary(item: ItemRow): string | null {
  const parts = [
    item.due_at ? fmtDue(item.due_at) : null,
    item.lead_minutes.length ? `${item.lead_minutes.length} reminder${item.lead_minutes.length > 1 ? "s" : ""}` : null,
    item.task_id ? "time booked" : null,
    item.prep_task_id ? "prep booked" : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export function TodoView({ onMutated }: { onMutated?: () => void }) {
  const [lists, setLists] = useState<ListRow[] | null>(null);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [newList, setNewList] = useState("");
  const [newChase, setNewChase] = useState<ChaseCadence | "">("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [openItem, setOpenItem] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const [{ data: listRows }, { data: itemRows }, { data: catRows }, { data: taskRows }] = await Promise.all([
      supabase.from("todo_lists").select("*").order("sort_order").order("name"),
      supabase.from("todo_items").select("*").order("sort_order").order("created_at"),
      supabase.from("categories").select("*").order("sort_order"),
      supabase.from("tasks").select("*").is("archived_at", null),
    ]);
    setLists(listRows ?? []);
    setItems(itemRows ?? []);
    setCategories(catRows ?? []);
    setTasks(taskRows ?? []);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function refresh() {
    await load();
    onMutated?.();
  }

  async function addList() {
    const name = newList.trim();
    if (!name) return;
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setNewList("");
    setNewChase("");
    await supabase.from("todo_lists").insert({ user_id: user.id, name, chase: newChase || null });
    await refresh();
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
    await refresh();
  }

  /** Ticking a to-do finishes whatever it had booked: the hours leave the
   * calendar rather than sitting there for work that's already done. Archiving
   * rather than deleting keeps the logged history for retrospectives. */
  async function toggle(item: ItemRow) {
    const supabase = createClient();
    const done = !item.done;
    await supabase
      .from("todo_items")
      .update({ done, completed_at: done ? new Date().toISOString() : null })
      .eq("id", item.id);
    const linkedIds = [item.task_id, item.prep_task_id].filter((id): id is string => id != null);
    if (linkedIds.length) {
      await supabase
        .from("tasks")
        .update({ archived_at: done ? new Date().toISOString() : null })
        .in("id", linkedIds);
    }
    await refresh();
  }

  async function setHidden(item: ItemRow, hidden: boolean) {
    const supabase = createClient();
    await supabase.from("todo_items").update({ hidden }).eq("id", item.id);
    await refresh();
  }

  async function setShowCompleted(list: ListRow, show: boolean) {
    const supabase = createClient();
    await supabase.from("todo_lists").update({ show_completed: show }).eq("id", list.id);
    await refresh();
  }

  async function setChase(list: ListRow, chase: ChaseCadence | "") {
    const supabase = createClient();
    await supabase.from("todo_lists").update({ chase: chase || null }).eq("id", list.id);
    await refresh();
  }

  async function removeItem(item: ItemRow) {
    const supabase = createClient();
    const linkedIds = [item.task_id, item.prep_task_id].filter((id): id is string => id != null);
    if (linkedIds.length) await supabase.from("tasks").delete().in("id", linkedIds);
    await supabase.from("todo_items").delete().eq("id", item.id);
    await refresh();
  }

  async function removeList(list: ListRow) {
    if (!confirm(`Delete the "${list.name}" list and everything on it?`)) return;
    const supabase = createClient();
    await supabase.from("todo_lists").delete().eq("id", list.id);
    await refresh();
  }

  if (lists === null) return <div className="px-5 py-4 text-[12px] text-muted">Loading…</div>;

  const field =
    "rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text outline-none focus-visible:border-accent";

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <input
          value={newList}
          onChange={(e) => setNewList(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addList()}
          placeholder="New list name (e.g. This week)"
          className={field}
        />
        <select
          value={newChase}
          onChange={(e) => setNewChase(e.target.value as ChaseCadence | "")}
          className={field}
          title="What happens to items on this list that are never ticked off"
        >
          <option value="">if anything&apos;s unfinished: leave it alone</option>
          <option value="week">if anything&apos;s unfinished: {CHASE_LABEL.week}</option>
          <option value="month">if anything&apos;s unfinished: {CHASE_LABEL.month}</option>
          <option value="year">if anything&apos;s unfinished: {CHASE_LABEL.year}</option>
        </select>
        <button onClick={addList} className="text-xs text-accent hover:underline">
          + Add list
        </button>
      </div>

      {lists.length === 0 && (
        <p className="text-[12px] text-muted max-w-xl">
          No lists yet. Create one above, or just tell the chat — &ldquo;add call the plumber to my This week
          list&rdquo; — and it will make the list if it doesn&apos;t exist.
        </p>
      )}

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
        {lists.map((list) => {
          const all = items.filter((i) => i.list_id === list.id);
          const visible = all.filter((i) => !i.hidden && (list.show_completed || !i.done));
          const openCount = all.filter((i) => !i.done).length;
          const hiddenCount = all.filter((i) => i.hidden).length;
          return (
            <div key={list.id} className="rounded-lg border border-border bg-panel p-3 flex flex-col min-h-[120px]">
              <div className="flex items-baseline gap-1.5 mb-1">
                <span className="text-[12px] font-medium text-text truncate">{list.name}</span>
                <span className="text-[10px] text-muted-2">{openCount}</span>
                <button
                  onClick={() => removeList(list)}
                  className="ml-auto text-[10px] text-muted-2 hover:text-text flex-none"
                >
                  delete
                </button>
              </div>

              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <select
                  value={list.chase ?? ""}
                  onChange={(e) => setChase(list, e.target.value as ChaseCadence | "")}
                  className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-muted outline-none"
                  title="What happens to items on this list that are never ticked off"
                >
                  <option value="">unfinished items: leave them</option>
                  <option value="week">unfinished items: {CHASE_LABEL.week}</option>
                  <option value="month">unfinished items: {CHASE_LABEL.month}</option>
                  <option value="year">unfinished items: {CHASE_LABEL.year}</option>
                </select>
                <label className="flex items-center gap-1 text-[10px] text-muted-2">
                  <input
                    type="checkbox"
                    checked={list.show_completed}
                    onChange={(e) => setShowCompleted(list, e.target.checked)}
                  />
                  show completed
                </label>
              </div>

              <div className="flex flex-col gap-0.5 flex-1">
                {visible.map((item) => (
                    <div key={item.id}>
                      <div className="group flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={item.done}
                          onChange={() => toggle(item)}
                          className="mt-0.5 flex-none"
                        />
                        <div className="flex-1 min-w-0">
                          <button
                            onClick={() => setOpenItem(openItem === item.id ? null : item.id)}
                            className="text-left text-[11.5px] leading-snug w-full"
                            style={{
                              color: item.done ? "var(--color-muted-2, #75798c)" : "var(--color-text, #e9e9ed)",
                              textDecoration: item.done ? "line-through" : "none",
                            }}
                          >
                            {item.text}
                          </button>
                          <button
                            onClick={() => setOpenItem(openItem === item.id ? null : item.id)}
                            className="flex items-center gap-1 text-[9.5px] text-muted-2 hover:text-text"
                            title="Set a date, reminders, booked hours or preparation time"
                          >
                            {openItem === item.id ? <CaretUpIcon size={9} /> : <CaretDownIcon size={9} />}
                            {settingsSummary(item) ?? "add date, reminder, or time"}
                          </button>
                        </div>
                        <button
                          onClick={() => setHidden(item, true)}
                          title="Hide this item"
                          className="flex-none text-muted-2 opacity-0 group-hover:opacity-100 hover:text-text"
                        >
                          <EyeSlashIcon size={12} />
                        </button>
                        <button
                          onClick={() => removeItem(item)}
                          title="Delete this item"
                          className="flex-none text-[10px] text-muted-2 opacity-0 group-hover:opacity-100 hover:text-text"
                        >
                          ✕
                        </button>
                      </div>
                      {openItem === item.id && (
                        <TodoItemPanel
                          item={item}
                          categories={categories}
                          tasks={tasks}
                          onClose={() => setOpenItem(null)}
                          onSaved={refresh}
                        />
                      )}
                    </div>
                ))}
                {visible.length === 0 && <div className="text-[10.5px] text-muted-2">nothing here</div>}
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
