// Which scheduled tasks came from a to-do.
//
// Booking hours for a to-do creates an ordinary task, so by the time it reaches
// the calendar or the board it looks like any other task — and its
// date, reminders and notes are back on the to-do, with nothing on screen
// saying so. This is the reverse lookup that lets those surfaces link home.

import { createClient } from "@/lib/supabase/client";

export interface TodoLink {
  itemId: string;
  itemText: string;
  listName: string;
}

/** Keyed by task id. Only tasks that came from a to-do appear. */
export async function fetchTodoLinks(): Promise<Map<string, TodoLink>> {
  const supabase = createClient();
  const [{ data: items }, { data: lists }] = await Promise.all([
    supabase.from("todo_items").select("id,text,task_id,list_id").not("task_id", "is", null),
    supabase.from("todo_lists").select("id,name"),
  ]);
  const listName = new Map((lists ?? []).map((l) => [l.id, l.name]));
  const out = new Map<string, TodoLink>();
  for (const i of items ?? []) {
    if (!i.task_id) continue;
    out.set(i.task_id, { itemId: i.id, itemText: i.text, listName: listName.get(i.list_id) ?? "" });
  }
  return out;
}

/** Deep link to the To-Do tab with one item's panel already open. */
export const todoItemHref = (itemId: string) => `/planner?view=todos&item=${itemId}`;
