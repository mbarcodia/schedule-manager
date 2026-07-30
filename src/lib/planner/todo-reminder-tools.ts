// Chat tools for to-do items. A reminder is not a separate kind of thing any
// more: it's a to-do that has a date and some lead times, because "the talk on
// the 10th" and "warn me a week before the talk on the 10th" were always the
// same thing described twice.
//
//   add_task      -> hours the engine schedules on the calendar
//   add_todo      -> a line on a named list; optionally dated, optionally
//                    reminding, never occupying calendar time by itself
//   schedule_todo -> books hours for an existing to-do, and/or prep time
//
// "Add call the plumber to THIS WEEK" is a to-do. "Remind me a week before the
// seminar on the 10th" is a to-do with a date and a lead. "Book 3 hours to
// prepare for it" is schedule_todo. Only the last one takes calendar time.

import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { findCategoryId, markMutated, type ToolContext } from "@/lib/assistant/tools";
import { parseDeadlineDate, parseTimeInText, findByTitle } from "@/lib/assistant/nlp-dates";
import { zonedTimeToUtc } from "@/lib/scheduling/time";
import type { Database } from "@/lib/supabase/database.types";

/** Named lead times so the model doesn't have to do minute arithmetic. */
const LEAD_PHRASES: { pattern: RegExp; minutes: number }[] = [
  { pattern: /\b(\d+)\s*week/i, minutes: 7 * 24 * 60 },
  { pattern: /\b(\d+)\s*day/i, minutes: 24 * 60 },
  { pattern: /\b(\d+)\s*hour/i, minutes: 60 },
  { pattern: /\bmonth/i, minutes: 30 * 24 * 60 },
];

/** "1 week before, 1 day before" -> [10080, 1440]. Accepts a list in one
 * string because that's how people say it. */
export function parseLeadMinutes(raw: string | undefined): number[] {
  if (!raw) return [24 * 60];
  const parts = raw.split(/,|\band\b|;/);
  const out: number[] = [];
  for (const part of parts) {
    const text = part.trim();
    if (!text) continue;
    if (/\b(on the day|same day|day of|at the time|when it happens)\b/i.test(text)) {
      out.push(0);
      continue;
    }
    for (const { pattern, minutes } of LEAD_PHRASES) {
      const m = text.match(pattern);
      if (m) {
        const n = m[1] ? parseInt(m[1], 10) : 1;
        out.push(n * minutes);
        break;
      }
    }
  }
  // Longest lead first, de-duplicated.
  return out.length ? Array.from(new Set(out)).sort((a, b) => b - a) : [24 * 60];
}

function describeLead(minutes: number): string {
  if (minutes === 0) return "at the time";
  if (minutes % (7 * 24 * 60) === 0) {
    const w = minutes / (7 * 24 * 60);
    return `${w} week${w > 1 ? "s" : ""} before`;
  }
  if (minutes % (24 * 60) === 0) {
    const d = minutes / (24 * 60);
    return `${d} day${d > 1 ? "s" : ""} before`;
  }
  const h = Math.round(minutes / 60);
  return `${h} hour${h > 1 ? "s" : ""} before`;
}

/** Resolves "november 10", "friday 2pm" etc. into an instant. Reminders default
 * to 9am local when no time is given — a nudge at midnight is useless. */
function resolveWhen(ctx: ToolContext, raw: string): string | null {
  const d = parseDeadlineDate(raw.toLowerCase(), ctx.today);
  if (!d) return null;
  const minute = parseTimeInText(raw);
  const hour = minute != null ? Math.floor(minute / 60) : 9;
  const min = minute != null ? minute % 60 : 0;
  return zonedTimeToUtc(d.getFullYear(), d.getMonth() + 1, d.getDate(), hour, min, ctx.timezone).toISOString();
}

export function buildTodoReminderTools(ctx: ToolContext) {
  const { supabase, userId } = ctx;

  const add_todo = betaTool({
    name: "add_todo",
    description:
      'Add a line to a named to-do list. Use this for things that need DOING but not necessarily SCHEDULING ("add call the plumber to my This Week list", "put review the draft on my before-meeting list"). Creates the list if it does not exist yet. Optionally give it a date and lead times and it also becomes a reminder — that is how reminders are made; there is no separate reminder object. If the user wants hours booked on the calendar for it, add it here and then call schedule_todo.',
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "the to-do line itself" },
        list: { type: "string", description: 'name of the list, e.g. "This week". Defaults to "General".' },
        when: {
          type: "string",
          description: 'optional date (and time) the thing happens or is due, e.g. "november 10", "friday 2pm"',
        },
        leads: {
          type: "string",
          description:
            'optional notification lead times relative to `when`, a list is fine: "1 week before, 1 day before". Also accepts "on the day". Ignored without `when`.',
        },
        notes: { type: "string", description: "anything extra to carry in the notification" },
      },
      required: ["text"],
    },
    run: async ({ text, list, when, leads, notes }) => {
      const dueAt = when ? resolveWhen(ctx, when) : null;
      if (when && !dueAt) return `Couldn't understand the date "${when}" — try "november 10", "friday", or "in 2 weeks".`;
      const leadMinutes = dueAt && leads ? parseLeadMinutes(leads) : [];
      const listName = (list ?? "General").trim() || "General";
      const { data: lists } = await supabase.from("todo_lists").select("id,name").eq("user_id", userId);
      const existing = findByTitle((lists ?? []).map((l) => ({ ...l, title: l.name })), listName).match;

      let listId = existing?.id;
      let created = false;
      if (!listId) {
        const { data: madeList, error } = await supabase
          .from("todo_lists")
          .insert({ user_id: userId, name: listName })
          .select("id")
          .single();
        if (error || !madeList) return `Couldn't create the "${listName}" list.`;
        listId = madeList.id;
        created = true;
      }

      const { error } = await supabase.from("todo_items").insert({
        user_id: userId,
        list_id: listId,
        text,
        due_at: dueAt,
        lead_minutes: leadMinutes,
        notes: notes?.trim() || null,
      });
      if (error) return `Couldn't add that to "${listName}".`;
      markMutated(ctx);
      const onList = existing?.name ?? listName;
      const dateNote = dueAt
        ? ` for ${new Date(dueAt).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: ctx.timezone })}`
        : "";
      const leadNote = leadMinutes.length ? `, notifying ${leadMinutes.map(describeLead).join(" and ")}` : "";
      return `Added "${text}" to the ${onList} list${created ? " (new list)" : ""}${dateNote}${leadNote}. No calendar time is booked for it — say so if you want hours.`;
    },
  });

  const complete_todo = betaTool({
    name: "complete_todo",
    description: "Tick off a to-do item by its text (fuzzy match). Use for 'I sent that email', 'mark X done on my list'. Any hours booked for it are archived at the same time, so the calendar stops holding time for finished work.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "the item to tick off (fuzzy)" },
        list: { type: "string", description: "narrow to one list if the same wording appears on several" },
      },
      required: ["text"],
    },
    run: async ({ text, list }) => {
      let query = supabase.from("todo_items").select("id,text,list_id").eq("user_id", userId).eq("done", false);
      if (list) {
        const { data: lists } = await supabase.from("todo_lists").select("id,name").eq("user_id", userId);
        const match = findByTitle((lists ?? []).map((l) => ({ ...l, title: l.name })), list).match;
        if (!match) return `No list matching "${list}".`;
        query = query.eq("list_id", match.id);
      }
      const { data: items } = await query;
      const found = findByTitle((items ?? []).map((i) => ({ ...i, title: i.text })), text);
      if (found.ambiguous.length) {
        return `"${text}" matches several items: ${found.ambiguous.map((i) => i.text).join(", ")}. Which one?`;
      }
      if (!found.match) return `No open to-do matching "${text}".`;
      await supabase
        .from("todo_items")
        .update({ done: true, completed_at: new Date().toISOString() })
        .eq("id", found.match.id);
      markMutated(ctx);
      return `Ticked off "${found.match.text}".`;
    },
  });

  const list_todos = betaTool({
    name: "list_todos",
    description: "Show to-do lists and their open items. Use when the user asks what's on a list, or what they should be picking up.",
    inputSchema: {
      type: "object",
      properties: { list: { type: "string", description: "just one list, by name" } },
    },
    run: async ({ list }) => {
      const { data: lists } = await supabase.from("todo_lists").select("id,name").eq("user_id", userId).order("name");
      if (!lists?.length) return "No to-do lists yet.";
      const wanted = list ? [findByTitle(lists.map((l) => ({ ...l, title: l.name })), list).match].filter(Boolean) : lists;
      if (!wanted.length) return `No list matching "${list}".`;
      const { data: items } = await supabase
        .from("todo_items")
        .select("list_id,text,done")
        .eq("user_id", userId)
        .eq("done", false);
      return wanted
        .map((l) => {
          const open = (items ?? []).filter((i) => i.list_id === l!.id);
          return `${l!.name}: ${open.length ? open.map((i) => `- ${i.text}`).join("\n") : "(nothing open)"}`;
        })
        .join("\n\n");
    },
  });

  const add_reminder = betaTool({
    name: "add_reminder",
    description:
      'Set a dated reminder that arrives as a push notification, with one or more lead times ("remind me a week before and a day before the seminar on November 10"). A reminder IS a dated to-do: this puts it on a list so it can later gain hours or preparation time without being re-created. It occupies no calendar time — call schedule_todo if the user also wants time booked.',
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "what the reminder is about" },
        when: { type: "string", description: 'the date (and optional time) it relates to, e.g. "november 10", "friday 2pm"' },
        leads: {
          type: "string",
          description:
            'when to be notified, relative to that date — a list is fine: "1 week before, 1 day before". Also accepts "on the day". Defaults to 1 day before.',
        },
        heading: { type: "string", description: 'which list it belongs on, e.g. "Presentations", "Reviews". Defaults to "Reminders".' },
        notes: { type: "string", description: "anything extra to include in the notification" },
      },
      required: ["title", "when"],
    },
    run: async ({ title, when, leads, heading, notes }) => {
      const dueAt = resolveWhen(ctx, when);
      if (!dueAt) return `Couldn't understand the date "${when}" — try "november 10", "friday", or "in 2 weeks".`;
      const leadMinutes = parseLeadMinutes(leads);
      const listName = (heading ?? "Reminders").trim() || "Reminders";

      const { data: lists } = await supabase.from("todo_lists").select("id,name").eq("user_id", userId);
      const existing = findByTitle((lists ?? []).map((l) => ({ ...l, title: l.name })), listName).match;
      let listId = existing?.id;
      if (!listId) {
        const { data: madeList, error } = await supabase
          .from("todo_lists")
          .insert({ user_id: userId, name: listName })
          .select("id")
          .single();
        if (error || !madeList) return `Couldn't create the "${listName}" list.`;
        listId = madeList.id;
      }

      const { error } = await supabase.from("todo_items").insert({
        user_id: userId,
        list_id: listId,
        text: title,
        due_at: dueAt,
        lead_minutes: leadMinutes,
        notes: notes?.trim() || null,
      });
      if (error) return `Couldn't save that reminder.`;
      markMutated(ctx);
      const whenLabel = new Date(dueAt).toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: ctx.timezone,
      });
      return `Reminder set: "${title}" on ${whenLabel}, on the ${existing?.name ?? listName} list, notifying ${leadMinutes.map(describeLead).join(" and ")}. No calendar time was booked — ask if you want hours, or preparation time.`;
    },
  });

  const list_reminders = betaTool({
    name: "list_reminders",
    description: "Show upcoming dated to-dos and their lead times, optionally within one list.",
    inputSchema: {
      type: "object",
      properties: { heading: { type: "string", description: "narrow to one list" } },
    },
    run: async ({ heading }) => {
      const { data: lists } = await supabase.from("todo_lists").select("id,name").eq("user_id", userId);
      const nameById = new Map((lists ?? []).map((l) => [l.id, l.name]));
      let query = supabase
        .from("todo_items")
        .select("text,due_at,lead_minutes,list_id")
        .eq("user_id", userId)
        .eq("done", false)
        .not("due_at", "is", null)
        .gte("due_at", new Date().toISOString())
        .order("due_at");
      if (heading) {
        const match = findByTitle((lists ?? []).map((l) => ({ ...l, title: l.name })), heading).match;
        if (!match) return `No list matching "${heading}".`;
        query = query.eq("list_id", match.id);
      }
      const { data } = await query;
      if (!data?.length) return heading ? `Nothing dated on "${heading}".` : "No upcoming dated to-dos.";
      return data
        .map(
          (r) =>
            `- ${r.text} — ${new Date(r.due_at!).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: ctx.timezone })} [${nameById.get(r.list_id) ?? "?"}]${r.lead_minutes.length ? ` (${r.lead_minutes.map(describeLead).join(", ")})` : " (no reminders set)"}`,
        )
        .join("\n");
    },
  });

  const remove_reminder = betaTool({
    name: "remove_reminder",
    description:
      "Stop the notifications for a dated to-do, by title (fuzzy match). The item itself stays on its list — deleting the whole thing is remove_item.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
    run: async ({ title }) => {
      const { data } = await supabase
        .from("todo_items")
        .select("id,text")
        .eq("user_id", userId)
        .not("due_at", "is", null);
      const found = findByTitle((data ?? []).map((r) => ({ ...r, title: r.text })), title);
      if (found.ambiguous.length) {
        return `"${title}" matches several: ${found.ambiguous.map((r) => r.title).join(", ")}. Which one?`;
      }
      if (!found.match) return `No dated to-do matching "${title}".`;
      await supabase.from("todo_items").update({ lead_minutes: [], sent_leads: [] }).eq("id", found.match.id);
      markMutated(ctx);
      return `Notifications off for "${found.match.title}". It's still on its list.`;
    },
  });

  const schedule_todo = betaTool({
    name: "schedule_todo",
    description:
      'Book calendar hours for a to-do that already exists. This is how something jotted down earlier becomes real scheduled Work without being retyped ("book 3 hours for the report on my list"). The booking has both ends of a window: `start` is the earliest it may be scheduled and `due` is when it must be finished — which is also how preparation is expressed, by setting `due` earlier than the thing itself ("2 hours, finished by the morning of the talk").',
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "which to-do (fuzzy match on its text)" },
        hours: { type: "number", description: "hours to book" },
        start: { type: "string", description: "earliest the hours may be scheduled, natural language. Omit to allow any time from now." },
        due: { type: "string", description: 'when the hours must be finished, natural language, e.g. "1pm on november 10". Omit for no deadline.' },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        category: { type: "string", description: "label name for the booked time" },
      },
      required: ["text", "hours"],
    },
    run: async ({ text, hours, start, due, priority, category }) => {
      if (!hours) return "Say how many hours to book.";
      const { data: items } = await supabase
        .from("todo_items")
        .select("id,text,due_at,task_id")
        .eq("user_id", userId)
        .eq("done", false);
      const found = findByTitle((items ?? []).map((i) => ({ ...i, title: i.text })), text);
      if (found.ambiguous.length) {
        return `"${text}" matches several to-dos: ${found.ambiguous.map((i) => i.title).join(", ")}. Which one?`;
      }
      if (!found.match) return `No to-do matching "${text}".`;
      const item = found.match;

      const categoryId = category ? await findCategoryId(ctx, category) : null;
      const patch: Database["public"]["Tables"]["todo_items"]["Update"] = {};
      const done: string[] = [];

      {
        const deadlineAt = due ? resolveWhen(ctx, due) : null;
        if (due && !deadlineAt) return `Couldn't understand the deadline "${due}".`;
        const startAt = start ? resolveWhen(ctx, start) : null;
        if (start && !startAt) return `Couldn't understand the start "${start}".`;
        const fields = {
          title: item.text,
          duration_min: Math.round(hours * 60),
          chunk_min: Math.min(120, Math.round(hours * 60)),
          priority: priority ?? "medium",
          floor_at: startAt ?? new Date().toISOString(),
          deadline_at: deadlineAt,
          category_id: categoryId,
        };
        if (item.task_id) {
          await supabase.from("tasks").update(fields).eq("id", item.task_id);
        } else {
          const { data: made, error } = await supabase
            .from("tasks")
            .insert({ ...fields, user_id: userId })
            .select("id")
            .single();
          if (error || !made) return `Couldn't book the time: ${error?.message ?? "unknown error"}`;
          patch.task_id = made.id;
        }
        done.push(
          `${hours}h${startAt ? ", starting no earlier than then" : ""}${deadlineAt ? ", finished by then" : ""}`,
        );
      }

      if (Object.keys(patch).length) await supabase.from("todo_items").update(patch).eq("id", item.id);
      markMutated(ctx);
      return `Booked ${done.join(" and ")} for "${item.text}". It stays on its list; ticking it off there will clear the time again.`;
    },
  });

  return [add_todo, complete_todo, list_todos, add_reminder, list_reminders, remove_reminder, schedule_todo];
}
